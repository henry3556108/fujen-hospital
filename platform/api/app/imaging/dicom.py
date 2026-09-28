"""DICOM 解析與驗證：只取索引需要的欄位，並攔下截斷或不是 DICOM 的檔案。"""
import io
from dataclasses import dataclass

import pydicom
from pydicom.errors import InvalidDicomError


class InvalidDicom(ValueError):
    pass


@dataclass(frozen=True)
class DicomInfo:
    sop_instance_uid: str
    study_instance_uid: str
    series_instance_uid: str
    accession_number: str
    patient_id: str
    patient_sex: str
    study_date: str
    study_description: str
    series_description: str
    modality: str


_REQUIRED = ("SOPInstanceUID", "StudyInstanceUID", "SeriesInstanceUID")


def _text(ds, name: str) -> str:
    value = ds.get(name)
    return "" if value is None else str(value).strip()


def _expected_pixel_bytes(ds) -> int | None:
    """未壓縮影像的像素資料應有位元組數；壓縮格式無法事先算出，回 None。"""
    if ds.file_meta.get("TransferSyntaxUID") is None or ds.file_meta.TransferSyntaxUID.is_compressed:
        return None
    frames = int(ds.get("NumberOfFrames", 1) or 1)
    bits = int(ds.BitsAllocated)
    total_bits = int(ds.Rows) * int(ds.Columns) * int(ds.get("SamplesPerPixel", 1)) * bits * frames
    return (total_bits + 7) // 8


def parse_dicom(data: bytes) -> DicomInfo:
    try:
        ds = pydicom.dcmread(io.BytesIO(data))
    except (InvalidDicomError, EOFError, ValueError, TypeError, KeyError) as exc:
        raise InvalidDicom("不是 DICOM 檔案（缺少 DICM 檔頭或格式錯誤）") from exc
    except Exception as exc:  # pydicom 對壞檔可能丟出各種例外
        raise InvalidDicom(f"DICOM 無法解析：{type(exc).__name__}") from exc

    missing = [n for n in _REQUIRED if not _text(ds, n)]
    if missing:
        raise InvalidDicom(f"DICOM 不完整（可能被截斷），缺少：{', '.join(missing)}")

    if "Rows" in ds:
        pixels = ds.get("PixelData")
        if pixels is None:
            raise InvalidDicom("DICOM 不完整（可能被截斷），缺少像素資料")
        try:
            expected = _expected_pixel_bytes(ds)
        except (AttributeError, TypeError, ValueError) as exc:
            raise InvalidDicom("DICOM 影像欄位不完整（可能被截斷）") from exc
        if expected is not None and len(pixels) < expected:
            raise InvalidDicom(f"DICOM 被截斷：像素資料 {len(pixels)} 位元組，應為 {expected}")

    return DicomInfo(
        sop_instance_uid=_text(ds, "SOPInstanceUID"),
        study_instance_uid=_text(ds, "StudyInstanceUID"),
        series_instance_uid=_text(ds, "SeriesInstanceUID"),
        accession_number=_text(ds, "AccessionNumber"),
        patient_id=_text(ds, "PatientID"),
        patient_sex=_text(ds, "PatientSex"),
        study_date=_text(ds, "StudyDate"),
        study_description=_text(ds, "StudyDescription"),
        series_description=_text(ds, "SeriesDescription"),
        modality=_text(ds, "Modality"),
    )
