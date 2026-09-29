"""Six knowledge-base documents, one per format (PDF, DOCX, TXT, CSV, JSON, HTML).

Synthetic hospital operating notes. Each file carries one fact that appears in no other file, so a
retrieval test can tell which document an answer came from. Only the standard library is used for the
PDF and DOCX writers; output is byte-identical for the same seed.
"""

import csv
import io
import json
import zipfile
import zlib
from pathlib import Path
from xml.sax.saxutils import escape

from .common import write_manifest

# format -> (filename, title, paragraphs, the fact unique to this file)
DOCS = {
    "pdf": ("outpatient_hours.pdf", "門診時間規範",
            ["本院門診時間為週一至週五 08:30 至 17:00，週六僅上午看診。",
             "夜間門診於週二與週四 18:00 至 21:00 開放，國定假日停診。"],
            "夜間門診於週二與週四"),
    "docx": ("mri_preparation.docx", "磁振造影檢查前準備",
             ["磁振造影檢查前需取下所有金屬物品，包括手錶、髮夾與活動假牙。",
              "體內有心律調節器的病人不可進入磁振造影室，需改安排其他檢查。"],
             "心律調節器"),
    "txt": ("hand_hygiene.txt", "手部衛生五時機",
            ["接觸病人前、執行清潔或無菌技術前、暴露病人體液風險後、接觸病人後、接觸病人周遭環境後。",
             "乾洗手搓揉時間至少 20 秒，濕洗手至少 40 秒。"],
            "乾洗手搓揉時間至少 20 秒"),
    "html": ("registration_flow.html", "掛號流程",
             ["初診病人請攜帶健保卡與身分證至一樓掛號櫃檯填寫初診資料。",
              "複診病人可使用自助報到機，報到後依燈號至診間候診。"],
             "自助報到機"),
}
EXTENSIONS = [("放射科", "2301", "B1"), ("檢驗科", "2415", "2F"), ("藥劑部", "2520", "1F"),
              ("資訊室", "2688", "5F"), ("病歷室", "2733", "B1")]
LAB_REFERENCE = [
    {"item": "空腹血糖", "code": "GLU-AC", "unit": "mg/dL", "low": 70, "high": 99},
    {"item": "糖化血色素", "code": "HbA1c", "unit": "%", "low": 4.0, "high": 5.6},
    {"item": "肌酸酐", "code": "CRE", "unit": "mg/dL", "low": 0.6, "high": 1.2},
]
UNIQUE = {**{fmt: d[3] for fmt, d in DOCS.items()}, "csv": "2688", "json": "HbA1c"}
FILENAMES = {**{fmt: d[0] for fmt, d in DOCS.items()}, "csv": "department_extensions.csv",
             "json": "lab_reference_ranges.json"}


def _pdf(title: str, paragraphs: list[str]) -> bytes:
    """One-page PDF. Text is written as 16-bit codes with a ToUnicode map, so Chinese extracts correctly
    without embedding a font file (a viewer may not draw the glyphs; text extraction does not need them)."""
    lines = [title, *paragraphs]
    chars = sorted({ch for line in lines for ch in line})
    code = {ch: i + 1 for i, ch in enumerate(chars)}
    content = ["BT", "/F1 12 Tf", "72 770 Td", "16 TL"]
    for line in lines:
        content.append("<" + "".join(f"{code[ch]:04X}" for ch in line) + "> Tj T*")
    content.append("ET")
    stream = "\n".join(content).encode()
    bf = "\n".join(f"<{code[ch]:04X}> <{ord(ch):04X}>" for ch in chars)
    cmap = (
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
        f"{len(chars)} beginbfchar\n{bf}\nendbfchar\nendcmap\n"
        "CMapName currentdict /CMap defineresource pop\nend\nend"
    ).encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type0 /BaseFont /SynthSans /Encoding /Identity-H "
        b"/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
        b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SynthSans "
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
        b"/FontDescriptor 8 0 R /DW 1000 >>",
        b"<< /Length %d >>\nstream\n" % len(cmap) + cmap + b"\nendstream",
        b"<< /Type /FontDescriptor /FontName /SynthSans /Flags 4 /FontBBox [0 -200 1000 900] "
        b"/ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n" % (len(objects) + 1))
    out.write(b"0000000000 65535 f \n")
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref))
    return out.getvalue()


_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _docx(title: str, paragraphs: list[str]) -> bytes:
    body = "".join(f"<w:p><w:r><w:t xml:space=\"preserve\">{escape(text)}</w:t></w:r></w:p>"
                   for text in [title, *paragraphs])
    parts = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.'
            'wordprocessingml.document.main+xml"/></Types>'),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
            'officeDocument" Target="word/document.xml"/></Relationships>'),
        "word/document.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<w:document xmlns:w="{_W}"><w:body>{body}</w:body></w:document>'),
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in parts.items():
            info = zipfile.ZipInfo(name, date_time=(2024, 1, 1, 0, 0, 0))   # fixed timestamp: deterministic bytes
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, text.encode("utf-8"))
    return out.getvalue()


def _html(title: str, paragraphs: list[str]) -> bytes:
    body = "".join(f"<p>{escape(p)}</p>" for p in paragraphs)
    return (f"<!DOCTYPE html><html lang=\"zh-Hant\"><head><meta charset=\"utf-8\"><title>{escape(title)}</title>"
            "<style>body{font-family:sans-serif}</style><script>var tracking='should-not-be-indexed';</script>"
            f"</head><body><h1>{escape(title)}</h1>{body}</body></html>").encode("utf-8")


def _csv(seed: int) -> bytes:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["department", "extension", "floor"])
    writer.writerows(EXTENSIONS)
    writer.writerow([f"文件管制 SYN-{seed}-DOC-05", "0000", "-"])
    return out.getvalue().encode("utf-8")


def build(seed: int = 42) -> dict[str, bytes]:
    """filename -> bytes for the six documents. The seed only changes the document control number."""
    files = {}
    for number, (fmt, (filename, title, paragraphs, _)) in enumerate(DOCS.items(), start=1):
        paragraphs = [*paragraphs, f"文件管制編號 SYN-{seed}-DOC-{number:02d}"]
        if fmt == "pdf":
            files[filename] = _pdf(title, paragraphs)
        elif fmt == "docx":
            files[filename] = _docx(title, paragraphs)
        elif fmt == "html":
            files[filename] = _html(title, paragraphs)
        else:
            files[filename] = ("\n".join([title, "", *paragraphs]) + "\n").encode("utf-8")
    files[FILENAMES["csv"]] = _csv(seed)
    files[FILENAMES["json"]] = (json.dumps({"title": "檢驗項目參考值", "control_number": f"SYN-{seed}-DOC-06",
                                            "items": LAB_REFERENCE},
                                           ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    return files


def generate(out: Path, seed: int = 42) -> dict:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    files = build(seed)
    for filename, data in files.items():
        (out / filename).write_bytes(data)
    return write_manifest(out, {
        "kind": "documents",
        "seed": seed,
        "counts": {"documents": len(files)},
        "files": [{"format": fmt, "file": FILENAMES[fmt], "crc32": zlib.crc32(files[FILENAMES[fmt]]),
                   "unique_text": UNIQUE[fmt]} for fmt in sorted(FILENAMES)],
    })
