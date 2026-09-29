"""WP6 FHIR 驗收的共用工具：compose 指令、合成資料、由來源檔獨立算出的預期資源、逐欄位比對。

預期資源刻意不引用平台的對應規則程式碼：由來源檔直接寫出「應該長什麼樣」，才驗得出轉換有沒有錯。
"""
import csv
import json
import os
import re
import subprocess
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
SYNTH = ROOT / "tools" / "synth"
LOCAL = ROOT / "deploy" / "local"
COMPOSE_PROJECT = os.environ.get("COMPOSE_PROJECT")
MAILPIT = os.environ.get("MAILPIT_URL", "http://127.0.0.1:8025")
HIS_DSN = os.environ.get("HIS_DSN", "postgresql+psycopg://platform:platform-dev@postgres:5432/his")

MRN = "urn:ai-platform:mrn"
ACT_CODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode"
CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category"
LOINC = "http://loinc.org"
UCUM = "http://unitsofmeasure.org"
VITALS = {"heart_rate": ("8867-4", "Heart rate", "/min"),
          "spo2": ("59408-5", "Oxygen saturation in Arterial blood by Pulse oximetry", "%"),
          "resp_rate": ("9279-1", "Respiratory rate", "/min")}


def compose(*args: str, stdin: str | None = None, timeout: float = 300, check: bool = True
            ) -> subprocess.CompletedProcess:
    assert COMPOSE_PROJECT, "需要環境變數 COMPOSE_PROJECT"
    return subprocess.run(["docker", "compose", "-p", COMPOSE_PROJECT, "-f", str(LOCAL / "compose.yaml"),
                           "-f", str(LOCAL / "compose.fhir.yaml"), *args],
                          input=stdin, capture_output=True, text=True, timeout=timeout, check=check)


def container_ids(service: str) -> list[str]:
    return compose("ps", "-q", service).stdout.split()


def container_address(container: str) -> str:
    return subprocess.run(
        ["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container],
        capture_output=True, text=True, check=True).stdout.strip()


def fetch_from_network(network: str, url: str, timeout: int = 5) -> subprocess.CompletedProcess:
    """從指定 Docker 網路上的臨時容器發出 GET（用已經在本機的 postgres 映像裡的 wget）。"""
    return subprocess.run(["docker", "run", "--rm", "--network", network, "postgres:16-alpine", "wget", "-q",
                           "-T", str(timeout), "-O", "-", url], capture_output=True, text=True)


def psql(database: str, sql: str) -> str:
    return compose("exec", "-T", "postgres", "psql", "-U", "platform", "-d", database, "-v", "ON_ERROR_STOP=1",
                   "-qtA", "-f", "-", stdin=sql).stdout


def synth(out: Path, *args: str) -> None:
    subprocess.run(["uv", "run", "python", "-m", "synth", *args, "--out", str(out)], cwd=SYNTH, check=True,
                   capture_output=True)


def wait_until(probe, *, timeout: float, interval: float = 2.0, what: str = "條件"):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = probe()
            if last:
                return last
        except (httpx.HTTPError, AssertionError) as exc:
            last = exc
        time.sleep(interval)
    raise AssertionError(f"等待逾時（{timeout:.0f} 秒）：{what}；最後結果 {last!r}")


# ---------- 由來源檔算出的預期資源 ----------

_INSERT = re.compile(r"VALUES \('([^']*)', '([^']*)', '([^']*)', '([^']*)', '([^']*)', '([^']*)'\);")


def sql_rows(clinical: Path) -> list[dict]:
    keys = ["patient_id", "family_name", "given_name", "sex", "birth_date", "phone"]
    return [dict(zip(keys, m.groups())) for m in _INSERT.finditer((clinical / "patients.sql").read_text("utf-8"))]


def csv_rows(clinical: Path) -> list[dict]:
    with open(clinical / "encounters.csv", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def lab_rows(clinical: Path) -> list[dict]:
    return json.loads((clinical / "labs.json").read_text("utf-8"))


def hl7_text(clinical: Path) -> str:
    return "\n".join(p.read_bytes().decode("ascii").replace("\r", "\n")
                     for p in sorted((clinical / "hl7").glob("*.hl7")))


def vitals_rows(vitals: Path) -> list[dict]:
    return [json.loads(line) for line in (vitals / "vitals.jsonl").read_text("utf-8").splitlines() if line.strip()]


def _gender(code: str) -> str:
    return {"M": "male", "F": "female"}[code]


def expected_sql_patient(row: dict) -> dict:
    return {"resourceType": "Patient", "identifier": [{"system": MRN, "value": row["patient_id"]}],
            "name": [{"family": row["family_name"], "given": [row["given_name"]]}],
            "gender": _gender(row["sex"]), "birthDate": row["birth_date"],
            "telecom": [{"system": "phone", "value": row["phone"]}]}


def expected_csv_encounter(row: dict, patient_ref: str) -> dict:
    return {"resourceType": "Encounter",
            "identifier": [{"system": "urn:ai-platform:encounter", "value": row["encounter_id"]}],
            "status": row["status"], "class": {"system": ACT_CODE, "code": row["class"]},
            "serviceType": {"text": row["department"]}, "subject": {"reference": patient_ref},
            "period": {"start": row["start"], "end": row["end"]}}


def expected_lab_observation(row: dict, patient_ref: str) -> dict:
    return {"resourceType": "Observation", "identifier": [{"system": "urn:ai-platform:lab", "value": row["id"]}],
            "status": row["status"],
            "category": [{"coding": [{"system": CATEGORY, "code": "laboratory"}]}],
            "code": {"coding": [{"system": LOINC, "code": row["loinc"], "display": row["display"]}]},
            "subject": {"reference": patient_ref}, "effectiveDateTime": row["effective"],
            "valueQuantity": {"value": row["value"], "unit": row["unit"], "system": UCUM, "code": row["unit"]},
            "referenceRange": [{"low": {"value": row["reference_low"]}, "high": {"value": row["reference_high"]}}]}


def expected_hl7(message: str, patient_ref: str | None) -> tuple[dict, dict]:
    """由 HL7 V2 原文（不經平台的解析器）寫出預期的 Patient 與 Encounter。"""
    seg = {line.split("|")[0]: line.split("|") for line in message.splitlines() if line}
    pid, pv1, evn = seg["PID"], seg["PV1"], seg["EVN"]
    family, given = pid[5].split("^")[:2]
    address = pid[11].split("^")
    birth, ts = pid[7], evn[2]
    patient = {"resourceType": "Patient", "identifier": [{"system": MRN, "value": pid[3].split("^")[0]}],
               "name": [{"family": family, "given": [given]}], "gender": _gender(pid[8]),
               "birthDate": f"{birth[:4]}-{birth[4:6]}-{birth[6:8]}",
               "address": [{"line": [address[0]], "city": address[2], "postalCode": address[4],
                            "country": address[5]}]}
    ward, room, bed = pv1[3].split("^")[:3]
    encounter = {"resourceType": "Encounter",
                 "identifier": [{"system": "urn:ai-platform:visit", "value": pv1[19]}],
                 "status": "in-progress", "class": {"system": ACT_CODE, "code": {"I": "IMP"}[pv1[2]]},
                 "subject": {"reference": patient_ref},
                 "period": {"start": f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}T{ts[8:10]}:{ts[10:12]}:{ts[12:14]}+08:00"},
                 "serviceType": {"text": pv1[10]},
                 "location": [{"location": {"display": f"{ward}-{room}-{bed}"}}],
                 "participant": [{"individual": {"display": pv1[7].split("^")[0]}}]}
    return patient, encounter


def expected_vital(reading: dict, metric: str, patient_ref: str) -> dict:
    loinc, display, unit = VITALS[metric]
    return {"resourceType": "Observation",
            "identifier": [{"system": "urn:ai-platform:vital",
                            "value": f"{reading['device_id']}-{reading['sequence']}-{metric}"}],
            "status": "final", "category": [{"coding": [{"system": CATEGORY, "code": "vital-signs"}]}],
            "code": {"coding": [{"system": LOINC, "code": loinc, "display": display}]},
            "subject": {"reference": patient_ref}, "effectiveDateTime": reading["timestamp"],
            "valueQuantity": {"value": reading[metric], "unit": unit, "system": UCUM, "code": unit},
            "device": {"display": reading["device_id"]}}


# ---------- 逐欄位比對 ----------

def flatten(node, prefix="") -> dict:
    out = {}
    if isinstance(node, dict):
        for key, value in node.items():
            out.update(flatten(value, f"{prefix}.{key}" if prefix else key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            out.update(flatten(value, f"{prefix}[{index}]"))
    else:
        out[prefix] = node
    return out


def _same(expected, actual) -> bool:
    if isinstance(expected, (int, float)) and not isinstance(expected, bool) \
            and isinstance(actual, (int, float)) and not isinstance(actual, bool):
        return float(expected) == float(actual)
    return expected == actual


def _same_instant(a, b) -> bool:
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(a).replace("Z", "+00:00")) == datetime.fromisoformat(
            str(b).replace("Z", "+00:00"))
    except ValueError:
        return False


def stored_fields(resource: dict) -> dict:
    """伺服器自己加的欄位（id、meta、敘述）不算資料欄位。"""
    return flatten({k: v for k, v in resource.items() if k not in ("id", "meta", "text")})


def compare(expected: dict, actual: dict | None) -> tuple[int, list[str]]:
    """回傳（比對的欄位數, 差異清單）。預期有的欄位值要相同；實際多出來的欄位也算差異。"""
    want = flatten(expected)
    if actual is None:
        return len(want), [f"{expected['resourceType']} {expected['identifier'][0]['value']}：找不到資源"]
    have = stored_fields(actual)
    label = f"{expected['resourceType']} {expected['identifier'][0]['value']}"
    diffs = []
    for path, value in want.items():
        got = have.get(path)
        same = _same(value, got) or (("DateTime" in path or path.startswith("period.")) and _same_instant(value, got))
        if not same:
            diffs.append(f"{label} {path}：預期 {value!r}，實際 {got!r}")
    diffs.extend(f"{label} {path}：多出欄位 {have[path]!r}" for path in have.keys() - want.keys())
    return len(want | have), diffs


class Accuracy:
    """精確度統計：比對過的欄位數與差異數。"""

    def __init__(self):
        self.resources = 0
        self.fields = 0
        self.diffs: list[str] = []

    def add(self, expected: dict, actual: dict | None) -> None:
        fields, diffs = compare(expected, actual)
        self.resources += 1
        self.fields += fields
        self.diffs.extend(diffs)

    def summary(self) -> dict:
        matched = self.fields - len(self.diffs)
        return {"resources": self.resources, "fields": self.fields, "mismatches": len(self.diffs),
                "accuracy": round(matched / self.fields, 6) if self.fields else None,
                "examples": self.diffs[:20]}
