"""NIfTI、ITK MetaImage（.mha）、makesense（COCO JSON）的解析驗證與檔名規則。

只讀標頭與長度，不載入整個影像陣列，所以不需要 nibabel／SimpleITK。
`.nii.gz` 以串流方式解壓：只留下標頭，其餘只計長度，而且解壓後總長度有上限（防壓縮炸彈）。
"""
import json
import math
import posixpath
import re
import struct
import zlib
from dataclasses import dataclass, field


class InvalidFile(ValueError):
    pass


@dataclass(frozen=True)
class ParsedFile:
    format: str          # nifti | itk | makesense
    role: str            # image | label
    case: str | None     # NIfTI／ITK 的配對鍵；makesense 以 meta["file_names"] 配對
    meta: dict = field(default_factory=dict)


_EXTENSIONS = [(".nii.gz", "nifti"), (".nii", "nifti"), (".mha", "itk"), (".json", "makesense")]
_SUFFIX = re.compile(r"^(?P<case>.+?)[_-](?P<role>image|img|label|seg|mask)$", re.IGNORECASE)
_LABEL_DIRS = {"labels", "labelstr", "labelsts", "label", "masks"}
_IMAGE_DIRS = {"images", "imagestr", "imagests", "image"}


def _classify(filename: str) -> tuple[str, str]:
    lower = filename.lower()
    for ext, fmt in _EXTENSIONS:
        if lower.endswith(ext):
            return fmt, posixpath.basename(filename)[: -len(ext)]
    raise InvalidFile("不支援的副檔名（可用 .nii、.nii.gz、.mha、makesense .json）")


def _role_and_case(filename: str, stem: str) -> tuple[str, str]:
    m = _SUFFIX.match(stem)
    if m:
        return ("image" if m["role"].lower() in ("image", "img") else "label"), m["case"]
    parent = posixpath.basename(posixpath.dirname(filename)).lower()
    if parent in _LABEL_DIRS:
        return "label", stem
    return "image", stem  # 其他一律當影像（含 _IMAGE_DIRS）


DEFAULT_MAX_DECOMPRESSED = 2048 * 1024 * 1024
_NIFTI_HEADER = 352          # 348 位元組標頭 + 4 位元組 extension 旗標
_BLOCK = 1 << 16


def _mb(size: int) -> str:
    return f"{size / 1024 / 1024:g} MB"


def _gunzip_stream(data: bytes):
    """逐塊解壓 gzip（可多個 member、尾端可補 0）。每次最多產出 _BLOCK 位元組，不會一次展開整個檔案。"""
    view, pos = memoryview(data), 0
    inflater, fresh = zlib.decompressobj(wbits=31), True
    try:
        while pos < len(view):
            piece = bytes(view[pos:pos + _BLOCK])
            pos += len(piece)
            while piece:
                if fresh:
                    piece = piece.lstrip(b"\x00")
                    if not piece:
                        break
                    fresh = False
                out = inflater.decompress(piece, _BLOCK)
                if out:
                    yield out
                if inflater.eof:
                    piece = inflater.unused_data
                    inflater, fresh = zlib.decompressobj(wbits=31), True
                else:
                    piece = inflater.unconsumed_tail
    except zlib.error as exc:
        raise InvalidFile("NIfTI 解壓縮失敗（檔案可能被截斷）") from exc
    if not fresh:
        raise InvalidFile("NIfTI 解壓縮失敗（檔案可能被截斷）")


def _nifti_header(head: bytes) -> tuple[list[int], int]:
    """驗證標頭，回傳（維度, 完整檔案至少需要的位元組數）。"""
    if len(head) < 348:
        raise InvalidFile("NIfTI 標頭不完整")
    for endian in ("<", ">"):
        if struct.unpack_from(endian + "i", head, 0)[0] == 348:
            break
    else:
        raise InvalidFile("NIfTI 標頭錯誤（sizeof_hdr 不是 348，或不是 NIfTI-1）")
    if head[344:348] not in (b"n+1\x00", b"ni1\x00"):
        raise InvalidFile("NIfTI magic 錯誤")
    dim = struct.unpack_from(endian + "8h", head, 40)
    if not 1 <= dim[0] <= 7 or any(d < 1 for d in dim[1: dim[0] + 1]):
        raise InvalidFile("NIfTI 維度錯誤")
    dims = list(dim[1: dim[0] + 1])
    bitpix = struct.unpack_from(endian + "h", head, 72)[0]
    vox_offset = int(struct.unpack_from(endian + "f", head, 108)[0])
    needed = 348
    if head[344:348] == b"n+1\x00":
        needed = vox_offset + (math.prod(dims) * bitpix + 7) // 8
    return dims, needed


def _nifti(data: bytes, max_decompressed: int = DEFAULT_MAX_DECOMPRESSED) -> dict:
    if data[:2] != b"\x1f\x8b":
        dims, needed = _nifti_header(data[:_NIFTI_HEADER])
        if needed > max_decompressed:
            raise InvalidFile(f"NIfTI 影像大小 {_mb(needed)} 超過上限 {_mb(max_decompressed)}")
        if len(data) < needed:
            raise InvalidFile(f"NIfTI 影像資料不完整：{len(data)} 位元組，應至少 {needed}")
        return {"dims": dims}

    chunks = _gunzip_stream(data)
    head, total = b"", 0
    for chunk in chunks:
        total += len(chunk)
        head += chunk
        if len(head) >= _NIFTI_HEADER:
            break
    dims, needed = _nifti_header(head[:_NIFTI_HEADER])
    if needed > max_decompressed:
        raise InvalidFile(f"NIfTI 解壓縮後 {_mb(needed)} 超過上限 {_mb(max_decompressed)}")
    del head
    for chunk in chunks:          # 其餘只計長度：驗證整個壓縮串流，但不留在記憶體
        total += len(chunk)
        if total > max_decompressed:
            raise InvalidFile(f"NIfTI 解壓縮後超過上限 {_mb(max_decompressed)}（可能是壓縮炸彈）")
    if total < needed:
        raise InvalidFile(f"NIfTI 影像資料不完整：{total} 位元組，應至少 {needed}")
    return {"dims": dims}


_MET_SIZES = {"MET_CHAR": 1, "MET_UCHAR": 1, "MET_SHORT": 2, "MET_USHORT": 2, "MET_INT": 4, "MET_UINT": 4,
              "MET_LONG": 8, "MET_ULONG": 8, "MET_LONG_LONG": 8, "MET_ULONG_LONG": 8,
              "MET_FLOAT": 4, "MET_DOUBLE": 8}


def _mha(data: bytes) -> dict:
    header: dict[str, str] = {}
    pos = 0
    while True:
        end = data.find(b"\n", pos)
        if end < 0:
            raise InvalidFile("MetaImage 標頭不完整（缺 ElementDataFile）")
        line = data[pos:end].decode("latin-1").strip()
        pos = end + 1
        if "=" in line:
            k, v = (s.strip() for s in line.split("=", 1))
            header[k] = v
            if k == "ElementDataFile":
                break
    if header.get("ElementDataFile") != "LOCAL":
        raise InvalidFile("MetaImage 必須是單檔 .mha（ElementDataFile = LOCAL）")
    try:
        ndims = int(header["NDims"])
        dims = [int(x) for x in header["DimSize"].split()]
        element = _MET_SIZES[header["ElementType"]]
    except (KeyError, ValueError) as exc:
        raise InvalidFile("MetaImage 標頭缺少 NDims／DimSize／ElementType") from exc
    if len(dims) != ndims or any(d < 1 for d in dims):
        raise InvalidFile("MetaImage 維度錯誤")
    channels = int(header.get("ElementNumberOfChannels", "1"))
    if header.get("CompressedData", "False").lower() != "true":
        needed = math.prod(dims) * element * channels
        if len(data) - pos < needed:
            raise InvalidFile(f"MetaImage 影像資料不完整：{len(data) - pos} 位元組，應為 {needed}")
    return {"dims": dims}


def _makesense(data: bytes) -> dict:
    try:
        doc = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidFile("JSON 格式錯誤") from exc
    if not isinstance(doc, dict) or not all(isinstance(doc.get(k), list) for k in ("images", "annotations", "categories")):
        raise InvalidFile("不是 makesense（COCO）格式：需要 images、annotations、categories")
    ids = {}
    for img in doc["images"]:
        if (not isinstance(img, dict) or not isinstance(img.get("file_name"), str)
                or not isinstance(img.get("id"), (int, str))):
            raise InvalidFile("makesense images 每筆需要 id 與 file_name")
        ids[img["id"]] = img["file_name"]
    for ann in doc["annotations"]:
        if not isinstance(ann, dict):
            raise InvalidFile("makesense annotations 每筆必須是物件")
        bbox, image_id = ann.get("bbox"), ann.get("image_id")
        if (not isinstance(image_id, (int, str)) or image_id not in ids
                or not (isinstance(bbox, list) and len(bbox) == 4)):
            raise InvalidFile("makesense annotations 需要對應的 image_id 與 4 個數字的 bbox")
    if not ids:
        raise InvalidFile("makesense 檔案沒有任何 images")
    return {"file_names": list(ids.values()), "annotations": len(doc["annotations"])}


def parse_file(filename: str, data: bytes, *, max_decompressed: int | None = None) -> ParsedFile:
    fmt, stem = _classify(filename)
    if fmt == "makesense":
        return ParsedFile("makesense", "label", None, _makesense(data))
    role, case = _role_and_case(filename, stem)
    meta = _nifti(data, max_decompressed or DEFAULT_MAX_DECOMPRESSED) if fmt == "nifti" else _mha(data)
    return ParsedFile(fmt, role, case, meta)
