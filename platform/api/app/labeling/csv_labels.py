"""CSV 診斷結果的解析（純函式）。對齊到研究在 service.classify_from_csv。

- 鍵：病歷號（patient_id）或影像編號（accession_number）。
- 欄名可用預設別名自動辨識，也可由呼叫端指定。
- 編碼：UTF-8（可帶 BOM），失敗時改用 Big5（cp950）——院內系統匯出的 CSV 常見。
"""
import csv
import io
from dataclasses import dataclass

KEYS = ("patient_id", "accession_number")
KEY_ALIASES = {
    "patient_id": ("patient_id", "patientid", "病歷號", "病歷號碼", "chart_no", "mrn"),
    "accession_number": ("accession_number", "accessionnumber", "accession", "影像編號", "檢查單號"),
}
LABEL_ALIASES = ("diagnosis", "label", "診斷", "診斷結果")
MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 100_000


class CsvError(ValueError):
    """整份檔案無法處理；訊息為繁體中文（422）。"""


@dataclass(frozen=True)
class CsvRow:
    row: int       # 檔案中的行號（標題列是第 1 行）
    key: str
    label: str


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp950"):
        try:
            text = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        if "\x00" not in text:
            return text
    raise CsvError("無法讀取 CSV：請使用 UTF-8 或 Big5 編碼的文字檔")


def _find(header: list[str], wanted: str | None, aliases: tuple[str, ...], what: str) -> int:
    names = [h.strip() for h in header]
    lowered = [n.lower() for n in names]
    candidates = [wanted.strip().lower()] if wanted else list(aliases)
    hits = [i for i, n in enumerate(lowered) if n in candidates]
    if not hits:
        hint = wanted if wanted else "、".join(aliases)
        raise CsvError(f"CSV 找不到{what}欄位（{hint}）；目前的欄位：{'、'.join(names)}")
    if len(hits) > 1:
        raise CsvError(f"CSV 有多個{what}欄位（{'、'.join(names[i] for i in hits)}），請指定欄名")
    return hits[0]


def parse(data: bytes, *, key: str, key_column: str | None = None, label_column: str | None = None) -> list[CsvRow]:
    if key not in KEYS:
        raise CsvError("key 必須是 patient_id（病歷號）或 accession_number（影像編號）")
    if not data.strip():
        raise CsvError("CSV 是空的")
    if len(data) > MAX_BYTES:
        raise CsvError(f"CSV 不可超過 {MAX_BYTES // 1024 // 1024} MB")
    try:
        reader = csv.reader(io.StringIO(_decode(data), newline=""))
        header = next(reader)
        key_at = _find(header, key_column, KEY_ALIASES[key], "鍵")
        label_at = _find(header, label_column, LABEL_ALIASES, "診斷")
        if key_at == label_at:
            raise CsvError("鍵欄位與診斷欄位不可相同")
        rows = []
        for line in reader:
            if not any(cell.strip() for cell in line):
                continue    # 空行不算一筆
            cell = lambda i: line[i].strip() if i < len(line) else ""  # noqa: E731
            rows.append(CsvRow(row=reader.line_num, key=cell(key_at), label=cell(label_at)))
            if len(rows) > MAX_ROWS:
                raise CsvError(f"CSV 不可超過 {MAX_ROWS} 筆")
    except csv.Error as exc:
        raise CsvError(f"CSV 格式錯誤：{exc}")
    if not rows:
        raise CsvError("CSV 沒有資料列")
    return rows
