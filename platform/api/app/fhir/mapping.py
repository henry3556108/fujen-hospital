"""對應規則引擎：把來源的扁平記錄轉成 FHIR 資源。規則是純資料（JSON），可由管理者在對應工具裡建立。

規則組格式：
    {"resources": [{
        "resourceType": "Patient",
        "key": {"system": "urn:ai-platform:mrn", "from": "patient_id"},      # 或 "template": "{a}-{b}"
        "fields": [
            {"path": "name[0].family", "from": "family_name"},
            {"path": "gender", "from": "sex", "map": {"M": "male", "F": "female"}},
            {"path": "birthDate", "from": "birth_date", "transform": "date", "required": false},
            {"path": "subject.reference", "template": "Patient?identifier=urn:ai-platform:mrn|{patient_id}"},
            {"path": "status", "const": "final"}
        ]}]}

- key 決定資源的業務識別碼：寫進 identifier[0]，也是條件式 upsert 的條件（重跑不會產生重複資源）。
- 每個欄位的值只能來自 from（來源欄位）、const（固定值）、template（樣板）其中之一。
- from 預設必填；來源沒有值時整筆記錄拒絕。required=false 則略過該欄位，或改用 default。
- map 是代碼對照表，值不在表內就拒絕（不猜測）。
"""
import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from app.fhir import hl7v2
from app.fhir.resources import SUPPORTED_TYPES

SYSTEM_MRN = "urn:ai-platform:mrn"
SYSTEM_ENCOUNTER = "urn:ai-platform:encounter"
SYSTEM_VISIT = "urn:ai-platform:visit"
SYSTEM_LAB = "urn:ai-platform:lab"
SYSTEM_VITAL = "urn:ai-platform:vital"
LOINC = "http://loinc.org"
UCUM = "http://unitsofmeasure.org"
ACT_CODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode"
OBSERVATION_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category"

TRANSFORMS = ("string", "date", "datetime", "number", "integer", "upper", "lower")
_PATH = re.compile(r"^[A-Za-z][A-Za-z0-9]*(\[\d+\])?(\.[A-Za-z][A-Za-z0-9]*(\[\d+\])?)*$")
_TOKEN = re.compile(r"([A-Za-z][A-Za-z0-9]*)(?:\[(\d+)\])?")
_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
_ISO_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$")


class RecordRejected(Exception):
    def __init__(self, reasons: list[str]):
        super().__init__("；".join(reasons))
        self.reasons = reasons


@dataclass(frozen=True)
class Mapped:
    resource: dict
    system: str
    value: str

    @property
    def condition(self) -> str:
        return f"{self.resource['resourceType']}?identifier={self.system}|{self.value}"


def validate_mapping(mapping) -> list[str]:
    """規則組本身的結構問題（給 API 回 422 用）。"""
    if not isinstance(mapping, dict) or not isinstance(mapping.get("resources"), list) or not mapping["resources"]:
        return ["規則組需要 resources 清單，且至少一個資源"]
    problems: list[str] = []
    for i, res in enumerate(mapping["resources"]):
        where = f"resources[{i}]"
        if not isinstance(res, dict):
            problems.append(f"{where} 必須是物件")
            continue
        if res.get("resourceType") not in SUPPORTED_TYPES:
            problems.append(f"{where}.resourceType 必須是 {'、'.join(SUPPORTED_TYPES)} 之一")
        key = res.get("key")
        if not isinstance(key, dict) or not key.get("system") or ("from" in key) == ("template" in key):
            problems.append(f"{where}.key 需要 system，以及 from 或 template 其中之一")
        fields = res.get("fields")
        if not isinstance(fields, list):
            problems.append(f"{where}.fields 必須是清單")
            continue
        for j, rule in enumerate(fields):
            at = f"{where}.fields[{j}]"
            if not isinstance(rule, dict):
                problems.append(f"{at} 必須是物件")
                continue
            path = rule.get("path")
            if not isinstance(path, str) or not _PATH.match(path):
                problems.append(f"{at}.path 格式錯誤：{path!r}")
            elif path.split(".")[0].split("[")[0] in ("resourceType", "identifier", "id"):
                problems.append(f"{at}.path 不可設定 {path.split('.')[0]}（由 key 決定）")
            if sum(k in rule for k in ("from", "const", "template")) != 1:
                problems.append(f"{at} 需要 from、const、template 其中之一")
            if "transform" in rule and rule["transform"] not in TRANSFORMS:
                problems.append(f"{at}.transform 必須是 {'、'.join(TRANSFORMS)} 之一")
            if "map" in rule and not isinstance(rule["map"], dict):
                problems.append(f"{at}.map 必須是物件")
    return problems


def set_path(target: dict, path: str, value) -> None:
    tokens = [(m.group(1), m.group(2)) for m in _TOKEN.finditer(path)]
    node = target
    for i, (name, index) in enumerate(tokens):
        last = i == len(tokens) - 1
        if index is None:
            if last:
                node[name] = value
            else:
                node = node.setdefault(name, {})
            continue
        items = node.setdefault(name, [])
        position = int(index)
        while len(items) <= position:
            items.append(None if last else {})
        if last:
            items[position] = value
        else:
            if items[position] is None:
                items[position] = {}
            node = items[position]


def _empty(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _transform(name: str, value, field: str):
    if name == "string":
        return str(value)
    if name in ("upper", "lower"):
        return getattr(str(value), name)()
    if name == "date":
        if isinstance(value, datetime):
            return value.date().isoformat()
        if isinstance(value, date):
            return value.isoformat()
        text = str(value).strip()
        try:
            if re.fullmatch(r"\d{8}", text):
                return hl7v2.parse_ts(text)[0]
            return date.fromisoformat(text[:10]).isoformat()
        except ValueError:
            raise ValueError(f"欄位 {field} 的值 {text!r} 不是日期")
    if name == "datetime":
        if isinstance(value, datetime):
            if value.tzinfo is None:
                return value.strftime("%Y-%m-%dT%H:%M:%S") + hl7v2.DEFAULT_TZ
            return value.isoformat(timespec="seconds")
        text = str(value).strip()
        try:
            if re.fullmatch(r"\d{12,14}([+-]\d{4})?", text):
                return hl7v2.parse_ts(text)[0]
            if not _ISO_DATETIME.match(text):
                raise ValueError(text)
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            return text if parsed.tzinfo else text + hl7v2.DEFAULT_TZ
        except ValueError:
            raise ValueError(f"欄位 {field} 的值 {text!r} 不是日期時間")
    try:
        number = Decimal(str(value).strip())
        if not number.is_finite():
            raise InvalidOperation
    except InvalidOperation:
        raise ValueError(f"欄位 {field} 的值 {value!r} 不是數字")
    if name == "integer":
        if number != number.to_integral_value():
            raise ValueError(f"欄位 {field} 的值 {value!r} 不是整數")
        return int(number)
    return int(number) if number == number.to_integral_value() and "." not in str(value) else float(number)


def _template(template: str, record: dict, reasons: list[str]) -> str | None:
    missing = [name for name in _PLACEHOLDER.findall(template) if _empty(record.get(name))]
    if missing:
        reasons.extend(f"缺少來源欄位 {name}" for name in missing)
        return None
    return _PLACEHOLDER.sub(lambda m: str(record[m.group(1)]), template)


def _value(rule: dict, record: dict, reasons: list[str]):
    """回傳 (有值, 值)。沒有值且非必填時回 (False, None)。"""
    if "const" in rule:
        return True, rule["const"]
    if "template" in rule:
        text = _template(rule["template"], record, reasons)
        return text is not None, text
    field = rule["from"]
    value = record.get(field)
    if _empty(value):
        if "default" in rule:
            return True, rule["default"]
        if rule.get("required", True):
            reasons.append(f"缺少來源欄位 {field}")
        return False, None
    if "map" in rule:
        key = str(value).strip()
        if key not in rule["map"]:
            reasons.append(f"欄位 {field} 的值 {key!r} 不在對照表（{'、'.join(rule['map'])}）")
            return False, None
        value = rule["map"][key]
    if "transform" in rule:
        try:
            value = _transform(rule["transform"], value, field)
        except ValueError as exc:
            reasons.append(str(exc))
            return False, None
    elif isinstance(value, (date, datetime, Decimal)):
        value = value.isoformat() if not isinstance(value, Decimal) else float(value)
    return True, value


def apply(mapping: dict, record: dict) -> list[Mapped]:
    """一筆記錄 → 規則組內每個資源模板各一個資源。任何欄位有問題就丟 RecordRejected（列出全部原因）。"""
    reasons: list[str] = []
    out: list[Mapped] = []
    for res in mapping["resources"]:
        key = res["key"]
        has_key, key_value = _value({k: v for k, v in key.items() if k != "system"}, record, reasons)
        resource: dict = {"resourceType": res["resourceType"]}
        if has_key:
            resource["identifier"] = [{"system": key["system"], "value": str(key_value)}]
        for rule in res["fields"]:
            has_value, value = _value(rule, record, reasons)
            if has_value:
                set_path(resource, rule["path"], value)
        if has_key:
            out.append(Mapped(resource, key["system"], str(key_value)))
    if reasons:
        raise RecordRejected(list(dict.fromkeys(reasons)))
    return out


_PATIENT_REF = {"path": "subject.reference", "template": f"Patient?identifier={SYSTEM_MRN}|{{patient_id}}"}


def _vital(metric: str, loinc: str, display: str, unit: str, ucum: str) -> dict:
    return {
        "resourceType": "Observation",
        "key": {"system": SYSTEM_VITAL, "template": f"{{device_id}}-{{sequence}}-{metric}"},
        "fields": [
            {"path": "status", "const": "final"},
            {"path": "category[0].coding[0].system", "const": OBSERVATION_CATEGORY},
            {"path": "category[0].coding[0].code", "const": "vital-signs"},
            {"path": "code.coding[0].system", "const": LOINC},
            {"path": "code.coding[0].code", "const": loinc},
            {"path": "code.coding[0].display", "const": display},
            _PATIENT_REF,
            {"path": "effectiveDateTime", "from": "timestamp", "transform": "datetime"},
            {"path": "valueQuantity.value", "from": metric, "transform": "number"},
            {"path": "valueQuantity.unit", "const": unit},
            {"path": "valueQuantity.system", "const": UCUM},
            {"path": "valueQuantity.code", "const": ucum},
            {"path": "device.display", "from": "device_id"},
        ],
    }


# 內建規則組：對應 platform/tools/synth 的來源欄位。管理者可以複製後修改，或自己從頭建立。
BUILTIN: dict[str, dict] = {
    "sql-patient": {"source_kind": "sql", "mapping": {"resources": [{
        "resourceType": "Patient",
        "key": {"system": SYSTEM_MRN, "from": "patient_id"},
        "fields": [
            {"path": "name[0].family", "from": "family_name"},
            {"path": "name[0].given[0]", "from": "given_name"},
            {"path": "gender", "from": "sex", "map": {"M": "male", "F": "female"}},
            {"path": "birthDate", "from": "birth_date", "transform": "date"},
            {"path": "telecom[0].system", "const": "phone"},
            {"path": "telecom[0].value", "from": "phone", "required": False, "default": "unknown"},
        ]}]}},
    "csv-encounter": {"source_kind": "csv", "mapping": {"resources": [{
        "resourceType": "Encounter",
        "key": {"system": SYSTEM_ENCOUNTER, "from": "encounter_id"},
        "fields": [
            {"path": "status", "from": "status",
             "map": {"planned": "planned", "in-progress": "in-progress", "finished": "finished",
                     "cancelled": "cancelled"}},
            {"path": "class.system", "const": ACT_CODE},
            {"path": "class.code", "from": "class", "map": {"IMP": "IMP", "AMB": "AMB", "EMER": "EMER"}},
            {"path": "serviceType.text", "from": "department", "required": False},
            _PATIENT_REF,
            {"path": "period.start", "from": "start", "transform": "datetime"},
            {"path": "period.end", "from": "end", "transform": "datetime", "required": False},
        ]}]}},
    "json-lab-observation": {"source_kind": "json", "mapping": {"resources": [{
        "resourceType": "Observation",
        "key": {"system": SYSTEM_LAB, "from": "id"},
        "fields": [
            {"path": "status", "from": "status",
             "map": {"registered": "registered", "preliminary": "preliminary", "final": "final",
                     "amended": "amended"}},
            {"path": "category[0].coding[0].system", "const": OBSERVATION_CATEGORY},
            {"path": "category[0].coding[0].code", "const": "laboratory"},
            {"path": "code.coding[0].system", "const": LOINC},
            {"path": "code.coding[0].code", "from": "loinc"},
            {"path": "code.coding[0].display", "from": "display", "required": False},
            _PATIENT_REF,
            {"path": "effectiveDateTime", "from": "effective", "transform": "datetime"},
            {"path": "valueQuantity.value", "from": "value", "transform": "number"},
            {"path": "valueQuantity.unit", "from": "unit"},
            {"path": "valueQuantity.system", "const": UCUM},
            {"path": "valueQuantity.code", "from": "unit"},
            {"path": "referenceRange[0].low.value", "from": "reference_low", "transform": "number",
             "required": False},
            {"path": "referenceRange[0].high.value", "from": "reference_high", "transform": "number",
             "required": False},
        ]}]}},
    "hl7v2-adt": {"source_kind": "hl7v2", "mapping": {"resources": [
        {"resourceType": "Patient",
         "key": {"system": SYSTEM_MRN, "from": "patient_id"},
         "fields": [
             {"path": "name[0].family", "from": "family"},
             {"path": "name[0].given[0]", "from": "given", "required": False},
             {"path": "gender", "from": "sex", "required": False,
              "map": {"M": "male", "F": "female", "O": "other", "A": "other", "U": "unknown", "N": "unknown"}},
             {"path": "birthDate", "from": "birth_date", "transform": "date", "required": False},
             {"path": "address[0].line[0]", "from": "address_line", "required": False},
             {"path": "address[0].city", "from": "city", "required": False},
             {"path": "address[0].postalCode", "from": "postal_code", "required": False},
             {"path": "address[0].country", "from": "country", "required": False},
         ]},
        {"resourceType": "Encounter",
         "key": {"system": SYSTEM_VISIT, "from": "visit_number"},
         "fields": [
             {"path": "status", "const": "in-progress"},
             {"path": "class.system", "const": ACT_CODE},
             {"path": "class.code", "from": "patient_class",
              "map": {"I": "IMP", "O": "AMB", "E": "EMER", "P": "PRENC", "B": "IMP"}},
             _PATIENT_REF,
             {"path": "period.start", "from": "admit_datetime", "transform": "datetime"},
             {"path": "serviceType.text", "from": "hospital_service", "required": False},
             {"path": "location[0].location.display", "template": "{ward}-{room}-{bed}"},
             {"path": "participant[0].individual.display", "from": "attending_id", "required": False},
         ]},
    ]}},
    "monitor-vitals": {"source_kind": "json", "mapping": {"resources": [
        _vital("heart_rate", "8867-4", "Heart rate", "/min", "/min"),
        _vital("spo2", "59408-5", "Oxygen saturation in Arterial blood by Pulse oximetry", "%", "%"),
        _vital("resp_rate", "9279-1", "Respiratory rate", "/min", "/min"),
    ]}},
}
