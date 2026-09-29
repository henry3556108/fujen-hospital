"""HL7 V2 訊息解析與驗證（ADT 類）。只解析平台會用到的 MSH、EVN、PID、PV1，轉成扁平記錄給對應規則用。

不合格的訊息一律整則拒絕並列出所有原因（TC-C03-13）：缺必填欄位、代碼不在 HL7 對照表、日期格式錯誤。
"""
import re
from datetime import datetime

SUPPORTED_TYPES = {"ADT^A01", "ADT^A04", "ADT^A08"}
TABLE_0001_SEX = {"F", "M", "O", "U", "A", "N"}
TABLE_0004_PATIENT_CLASS = {"I", "O", "E", "P", "R", "B", "C", "N", "U"}
DEFAULT_TZ = "+08:00"
_TS = re.compile(r"^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(?:\.\d+)?([+-]\d{4})?$")


class Hl7Rejected(Exception):
    """訊息不合格。reasons 列出每一個原因；control_id 取得到就附上，方便對回來源訊息。"""

    def __init__(self, reasons: list[str], control_id: str | None = None):
        super().__init__("；".join(reasons))
        self.reasons = reasons
        self.control_id = control_id


def split_messages(text: str) -> list[str]:
    """一份內容可含多則訊息：每則以 MSH 開頭。分段符號接受 \\r、\\n、\\r\\n。"""
    lines = [ln for ln in re.split(r"\r\n|\r|\n", text) if ln.strip()]
    messages: list[list[str]] = []
    for line in lines:
        if line.startswith("MSH"):
            messages.append([line])
        elif messages:
            messages[-1].append(line)
        else:
            messages.append([line])  # 沒有 MSH 開頭：交給 to_record 拒絕
    return ["\r".join(m) for m in messages]


def _segments(raw: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for line in re.split(r"\r\n|\r|\n", raw):
        if not line.strip():
            continue
        fields = line.split("|")
        name = fields[0]
        if name == "MSH":  # MSH-1 是分隔符號本身，補一格讓索引與 HL7 欄位編號一致
            fields = ["MSH", "|"] + fields[1:]
        out.setdefault(name, fields)
    return out


def _field(segment: list[str] | None, index: int) -> str:
    if segment is None or index >= len(segment):
        return ""
    return segment[index].split("~")[0].strip()


def _comp(value: str, index: int) -> str:
    parts = value.split("^")
    return parts[index - 1].strip() if index <= len(parts) else ""


def parse_ts(value: str, *, default_tz: str = DEFAULT_TZ) -> tuple[str, bool]:
    """HL7 TS → (ISO 8601, 是否含時間)。格式不符或日期不存在時丟 ValueError。"""
    m = _TS.match(value)
    if not m:
        raise ValueError(value)
    y, mo, d, h, mi, s, tz = m.groups()
    if h is None:
        return datetime(int(y), int(mo), int(d)).strftime("%Y-%m-%d"), False
    stamp = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s or 0))
    offset = f"{tz[:3]}:{tz[3:]}" if tz else default_tz
    return stamp.strftime("%Y-%m-%dT%H:%M:%S") + offset, True


def to_record(raw: str | bytes, *, default_tz: str = DEFAULT_TZ) -> dict:
    """驗證並轉成扁平記錄；不合格丟 Hl7Rejected（含全部原因）。"""
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise Hl7Rejected(["訊息不是 UTF-8 或 ASCII 編碼"])
    if not raw.startswith("MSH|"):
        raise Hl7Rejected(["訊息必須以 MSH 區段開頭"])
    seg = _segments(raw)
    msh, evn, pid, pv1 = seg.get("MSH"), seg.get("EVN"), seg.get("PID"), seg.get("PV1")
    reasons: list[str] = []
    control_id = _field(msh, 10) or None

    message_type = "^".join(_field(msh, 9).split("^")[:2])
    if not message_type:
        reasons.append("MSH-9（訊息類型）必填")
    elif message_type not in SUPPORTED_TYPES:
        reasons.append(f"不支援的訊息類型 {message_type}（支援：{'、'.join(sorted(SUPPORTED_TYPES))}）")
    if not control_id:
        reasons.append("MSH-10（訊息控制編號）必填")

    def ts(segment, index, label, *, required=False):
        value = _field(segment, index)
        if not value:
            if required:
                reasons.append(f"{label} 必填")
            return None
        try:
            return parse_ts(value, default_tz=default_tz)[0]
        except ValueError:
            reasons.append(f"{label} 日期時間格式錯誤：{value}")
            return None

    message_datetime = ts(msh, 7, "MSH-7（訊息時間）", required=True)

    record: dict = {}
    if pid is None:
        reasons.append("缺少 PID 區段")
    else:
        cx = _field(pid, 3)
        if not _comp(cx, 1):
            reasons.append("PID-3（病人識別碼）必填")
        name = _field(pid, 5)
        if not _comp(name, 1):
            reasons.append("PID-5（病人姓名）必填")
        sex = _field(pid, 8)
        if sex and sex not in TABLE_0001_SEX:
            reasons.append(f"PID-8 性別代碼 {sex} 不在 HL7 table 0001（{'、'.join(sorted(TABLE_0001_SEX))}）")
        birth = _field(pid, 7)
        birth_date = None
        if birth:
            try:
                birth_date = parse_ts(birth, default_tz=default_tz)[0][:10]
            except ValueError:
                reasons.append(f"PID-7（出生日期）格式錯誤：{birth}")
        address = _field(pid, 11)
        record.update({
            "patient_id": _comp(cx, 1), "assigning_authority": _comp(cx, 4), "id_type": _comp(cx, 5),
            "family": _comp(name, 1), "given": _comp(name, 2), "birth_date": birth_date or "", "sex": sex,
            "address_line": _comp(address, 1), "city": _comp(address, 3), "postal_code": _comp(address, 5),
            "country": _comp(address, 6),
        })

    if pv1 is None:
        reasons.append("缺少 PV1 區段")
    else:
        patient_class = _field(pv1, 2)
        if not patient_class:
            reasons.append("PV1-2（病人類別）必填")
        elif patient_class not in TABLE_0004_PATIENT_CLASS:
            reasons.append(f"PV1-2 病人類別代碼 {patient_class} 不在 HL7 table 0004")
        visit = _comp(_field(pv1, 19), 1)
        if not visit:
            reasons.append("PV1-19（就診號）必填")
        location, attending = _field(pv1, 3), _field(pv1, 7)
        admit = ts(pv1, 44, "PV1-44（入院時間）") or ts(evn, 2, "EVN-2（事件時間）") or message_datetime
        record.update({
            "patient_class": patient_class, "visit_number": visit,
            "ward": _comp(location, 1), "room": _comp(location, 2), "bed": _comp(location, 3),
            "attending_id": _comp(attending, 1), "attending_family": _comp(attending, 2),
            "attending_given": _comp(attending, 3), "hospital_service": _field(pv1, 10),
            "admit_datetime": admit or "",
        })

    if reasons:
        raise Hl7Rejected(reasons, control_id)
    record.update({
        "message_control_id": control_id, "message_type": message_type, "event": message_type.split("^")[1],
        "message_datetime": message_datetime, "sending_application": _field(msh, 3),
        "sending_facility": _field(msh, 4),
    })
    return record
