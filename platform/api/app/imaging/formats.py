"""NIfTI、ITK MetaImage（.mha）、makesense（COCO JSON）的解析驗證與檔名規則。

只讀標頭與長度，不載入整個影像陣列，所以不需要 nibabel／SimpleITK。
"""
import gzip
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


def _nifti(data: bytes) -> dict:
    if data[:2] == b"\x1f\x8b":
        try:
            data = gzip.decompress(data)
        except (OSError, EOFError, zlib.error) as exc:
            raise InvalidFile("NIfTI 解壓縮失敗（檔案可能被截斷）") from exc
    if len(data) < 348:
        raise InvalidFile("NIfTI 標頭不完整")
    for endian in ("<", ">"):
        if struct.unpack_from(endian + "i", data, 0)[0] == 348:
            break
    else:
        raise InvalidFile("NIfTI 標頭錯誤（sizeof_hdr 不是 348，或不是 NIfTI-1）")
    if data[344:348] not in (b"n+1\x00", b"ni1\x00"):
        raise InvalidFile("NIfTI magic 錯誤")
    dim = struct.unpack_from(endian + "8h", data, 40)
    if not 1 <= dim[0] <= 7 or any(d < 1 for d in dim[1: dim[0] + 1]):
        raise InvalidFile("NIfTI 維度錯誤")
    dims = list(dim[1: dim[0] + 1])
    bitpix = struct.unpack_from(endian + "h", data, 72)[0]
    vox_offset = int(struct.unpack_from(endian + "f", data, 108)[0])
    if data[344:348] == b"n+1\x00":
        needed = vox_offset + (math.prod(dims) * bitpix + 7) // 8
        if len(data) < needed:
            raise InvalidFile(f"NIfTI 影像資料不完整：{len(data)} 位元組，應至少 {needed}")
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


def parse_file(filename: str, data: bytes) -> ParsedFile:
    fmt, stem = _classify(filename)
    if fmt == "makesense":
        return ParsedFile("makesense", "label", None, _makesense(data))
    role, case = _role_and_case(filename, stem)
    meta = _nifti(data) if fmt == "nifti" else _mha(data)
    return ParsedFile(fmt, role, case, meta)
