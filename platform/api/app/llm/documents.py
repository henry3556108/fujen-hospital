"""知識庫文件解析：PDF、DOCX、TXT、CSV、JSON、HTML → 純文字 → 切片。

DOCX、HTML、CSV、JSON、TXT 用標準函式庫；PDF 用 pypdf。解析失敗一律丟 DocumentError，訊息說明原因。
"""
import csv
import io
import json
import re
import zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree

FORMATS = ("pdf", "docx", "txt", "csv", "json", "html")
_EXTENSIONS = {"pdf": "pdf", "docx": "docx", "txt": "txt", "csv": "csv", "json": "json", "html": "html",
               "htm": "html"}
MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
MAX_DOCX_XML_BYTES = 50 * 1024 * 1024
MAX_TEXT_CHARS = 5_000_000


class DocumentError(Exception):
    pass


def detect_format(filename: str) -> str:
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension not in _EXTENSIONS:
        raise DocumentError(f"不支援的檔案格式（支援：{'、'.join(f.upper() for f in FORMATS)}）")
    return _EXTENSIONS[extension]


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "cp950"):
        if encoding == "utf-16" and not data.startswith((b"\xff\xfe", b"\xfe\xff")):
            continue
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise DocumentError("無法辨識文字編碼（支援 UTF-8、UTF-16、Big5）")


def _pdf(data: bytes) -> str:
    from pypdf import PdfReader
    from pypdf.errors import PyPdfError
    if not data.lstrip()[:5] == b"%PDF-":
        raise DocumentError("不是 PDF 檔")
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise DocumentError("PDF 有密碼保護，無法讀取")
        pages = [page.extract_text() or "" for page in reader.pages]
    except DocumentError:
        raise
    except (PyPdfError, ValueError, KeyError, RecursionError, OSError) as exc:
        raise DocumentError(f"PDF 無法解析：{type(exc).__name__}")
    text = "\n\n".join(p.strip() for p in pages if p.strip())
    if not text:
        raise DocumentError("PDF 沒有可擷取的文字（可能是掃描影像）")
    return text


_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _docx(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > MAX_DOCX_XML_BYTES:
                raise DocumentError("DOCX 內容過大")
            xml = archive.read(info)
    except (zipfile.BadZipFile, KeyError):
        raise DocumentError("不是 DOCX 檔（找不到 word/document.xml）")
    if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
        raise DocumentError("DOCX 含有不允許的 XML 宣告")
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError:
        raise DocumentError("DOCX 的內容不是合法的 XML")
    paragraphs = []
    for paragraph in root.iter(f"{_W}p"):
        parts = []
        for node in paragraph.iter():
            if node.tag == f"{_W}t":
                parts.append(node.text or "")
            elif node.tag == f"{_W}tab":
                parts.append("\t")
            elif node.tag in (f"{_W}br", f"{_W}cr"):
                parts.append("\n")
        text = "".join(parts).strip()
        if text:
            paragraphs.append(text)
    return "\n\n".join(paragraphs)


def _csv(data: bytes) -> str:
    text = _decode(data)
    try:
        rows = list(csv.reader(io.StringIO(text, newline="")))
    except csv.Error as exc:
        raise DocumentError(f"CSV 無法解析：{exc}")
    rows = [r for r in rows if any(cell.strip() for cell in r)]
    if not rows:
        return ""
    header, body = rows[0], rows[1:]
    if not body:
        return "、".join(header)
    lines = []
    for row in body:
        cells = [f"{header[i] if i < len(header) and header[i] else f'欄位{i + 1}'}：{cell}"
                 for i, cell in enumerate(row) if cell.strip()]
        lines.append("；".join(cells))
    return "\n".join(lines)


def _json(data: bytes) -> str:
    try:
        value = json.loads(_decode(data))
    except ValueError as exc:
        raise DocumentError(f"JSON 無法解析：{exc}")
    lines: list[str] = []

    def walk(node, path: str, depth: int) -> None:
        if depth > 50:
            raise DocumentError("JSON 巢狀層數過深")
        if isinstance(node, dict):
            if node and all(not isinstance(v, (dict, list)) for v in node.values()):
                # 一筆扁平的紀錄寫成一行，檢索時整筆一起命中
                body = "；".join(f"{k}：{v}" for k, v in node.items() if v is not None)
                lines.append(f"{path}　{body}" if path else body)
                return
            for key, item in node.items():
                walk(item, f"{path}.{key}" if path else str(key), depth + 1)
        elif isinstance(node, list):
            for index, item in enumerate(node):
                walk(item, f"{path}[{index}]", depth + 1)
        elif node is not None:
            lines.append(f"{path}：{node}" if path else str(node))

    walk(value, "", 0)
    return "\n".join(lines)


class _HtmlText(HTMLParser):
    _SKIP = {"script", "style", "noscript", "template", "svg", "head"}
    _BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table",
              "ul", "ol", "blockquote", "pre", "title"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        elif tag in self._SKIP:
            self._skip += 1
        if tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag in self._SKIP and self._skip:
            self._skip -= 1
        if tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def _html(data: bytes) -> str:
    parser = _HtmlText()
    parser.feed(_decode(data))
    parser.close()
    body = "".join(parser.parts)
    title = parser.title.strip()
    return f"{title}\n\n{body}" if title and title not in body else body


_PARSERS = {"pdf": _pdf, "docx": _docx, "txt": _decode, "csv": _csv, "json": _json, "html": _html}


def normalise(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    lines = [re.sub(r"[ \t　]+", " ", line).strip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def extract_text(filename: str, data: bytes) -> tuple[str, str]:
    """回傳 (格式, 純文字)。"""
    fmt = detect_format(filename)
    if not data:
        raise DocumentError("檔案是空的")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise DocumentError(f"檔案超過 {MAX_DOCUMENT_BYTES // (1024 * 1024)} MB 上限")
    text = normalise(_PARSERS[fmt](data))
    if not text:
        raise DocumentError("檔案沒有文字內容")
    if len(text) > MAX_TEXT_CHARS:
        raise DocumentError("文字內容過長")
    return fmt, text


_BOUNDARY = "。！？!?\n；;"


def chunk_text(text: str, *, size: int = 500, overlap: int = 50) -> list[str]:
    """固定長度切片，盡量在句尾或換行處斷開；相鄰片段重疊 overlap 個字。"""
    if size < 50 or not 0 <= overlap < size // 2:
        raise ValueError("切片長度至少 50，重疊需小於長度的一半")
    chunks, start, length = [], 0, len(text)
    while start < length:
        end = min(start + size, length)
        if end < length:
            window = text[start:end]
            cut = max(window.rfind(ch) for ch in _BOUNDARY)
            if cut >= size * 0.6:
                end = start + cut + 1
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= length:
            break
        start = end - overlap
    return chunks
