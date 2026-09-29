"""自動標註輸入輸出格式規格（程式可讀）。文件：docs/specs/autolabel-io-format.md，兩者必須一致（TC-B03-04）。"""
from app.labeling.payloads import InvalidPayload, normalize

SPEC_VERSION = "1.0"
INFO_PATH = "/info/"
INFER_PATH = "/infer/{model}"
IMAGE_PARAM = "image"
MODEL_TYPES = ("segmentation", "detection")

# (欄位, 型別, 必填)
Field = tuple[str, str, bool]
INFO_FIELDS: list[Field] = [
    ("name", "string", True), ("description", "string", False), ("version", "string", True),
    ("labels", "array<string>", True), ("models", "object", True),
]
MODEL_FIELDS: list[Field] = [
    ("type", "string", True), ("labels", "array<string>", True),
    ("dimension", "integer", True), ("description", "string", False),
]
SEGMENTATION_FIELDS: list[Field] = [
    ("model", "string", True), ("image", "string", True), ("shape", "array<integer>", True),
    ("encoding", "string", True), ("rle_order", "string", False),
    ("rle", "array<array<integer>>", True), ("label_names", "object", True),
]
DETECTION_FIELDS: list[Field] = [
    ("model", "string", True), ("image", "string", True), ("shape", "array<integer>", True),
    ("box_format", "string", True), ("boxes", "array<object>", True),
]
RESULT_FIELDS = {"segmentation": SEGMENTATION_FIELDS, "detection": DETECTION_FIELDS}
# 回存到平台標註時保留的欄位
STORED_FIELDS = {"segmentation": ("shape", "encoding", "rle", "label_names"),
                 "detection": ("shape", "box_format", "boxes")}


class FormatError(ValueError):
    """自動標註服務的回應不合規格。"""


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


_CHECKS = {
    "string": lambda v: isinstance(v, str),
    "integer": _is_int,
    "object": lambda v: isinstance(v, dict),
    "array<string>": lambda v: isinstance(v, list) and all(isinstance(i, str) for i in v),
    "array<integer>": lambda v: isinstance(v, list) and all(_is_int(i) for i in v),
    "array<object>": lambda v: isinstance(v, list) and all(isinstance(i, dict) for i in v),
    "array<array<integer>>": lambda v: isinstance(v, list) and all(
        isinstance(i, list) and all(_is_int(j) for j in i) for i in v),
}


def check_fields(body, fields: list[Field], what: str) -> None:
    if not isinstance(body, dict):
        raise FormatError(f"{what}必須是 JSON 物件")
    for name, kind, required in fields:
        if name not in body or body[name] is None:
            if required:
                raise FormatError(f"{what}缺少必填欄位 {name}")
            continue
        if not _CHECKS[kind](body[name]):
            raise FormatError(f"{what}的欄位 {name} 型別應為 {kind}")


def validate_info(body) -> dict[str, dict]:
    """回傳 模型名稱 → 模型資訊。"""
    check_fields(body, INFO_FIELDS, "模型清單")
    for name, model in body["models"].items():
        check_fields(model, MODEL_FIELDS, f"模型 {name} ")
        if model["type"] not in MODEL_TYPES:
            raise FormatError(f"模型 {name} 的 type 必須是 {'、'.join(MODEL_TYPES)} 其中之一")
    return body["models"]


def to_payload(model_type: str, body, *, model: str, image: str) -> dict | None:
    """驗證自動標註結果並轉成平台標註內容；偵測模型沒有框時回 None。"""
    if model_type not in MODEL_TYPES:
        raise FormatError(f"不支援的模型種類 {model_type}")
    check_fields(body, RESULT_FIELDS[model_type], "自動標註結果")
    if body["model"] != model or body["image"] != image:
        raise FormatError("自動標註結果的 model 或 image 與送出的不一致")
    if model_type == "detection" and not body["boxes"]:
        return None
    try:
        return normalize(model_type, {k: body[k] for k in STORED_FIELDS[model_type]})
    except InvalidPayload as exc:
        raise FormatError(f"自動標註結果不合規格：{exc}")
