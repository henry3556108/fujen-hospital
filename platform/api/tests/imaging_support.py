"""影像測試共用：在記憶體中產生小型合成 DICOM／NIfTI／MetaImage／makesense，不依賴外部檔案。"""
import gzip
import io
import json
import struct

import pytest
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian

from app.imaging.orthanc import InMemoryOrthanc
from app.models import Membership, Project

ROOT = "1.2.826.0.1.3680043.10.9999.77."
CT = "1.2.840.10008.5.1.4.1.1.2"
MR = "1.2.840.10008.5.1.4.1.1.4"

# 4 個研究，5 個篩選欄位各有區別
STUDIES = {
    1: dict(modality="CT", sex="F", date="20240115", study="CT CHEST WO CONTRAST", series="AXIAL 5MM SOFT TISSUE"),
    2: dict(modality="MR", sex="M", date="20240220", study="MR BRAIN WWO CONTRAST", series="AX T1"),
    3: dict(modality="CT", sex="M", date="20240310", study="CT ABDOMEN PELVIS W CONTRAST", series="AXIAL 1MM LUNG"),
    4: dict(modality="MR", sex="F", date="20240405", study="MR KNEE WO CONTRAST", series="AX T2 FLAIR"),
}
SLICES = 3


def study_uid(no: int) -> str:
    return f"{ROOT}1.{no}"


def series_uid(no: int) -> str:
    return f"{ROOT}2.{no}.1"


def sop_uid(no: int, s: int) -> str:
    return f"{ROOT}3.{no}.{s}"


def accession(no: int) -> str:
    return f"ACC{no:04d}"


def make_dicom(no: int, s: int = 1, *, size: int = 8) -> bytes:
    meta = STUDIES[no]
    sop_class = CT if meta["modality"] == "CT" else MR
    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = sop_class
    fm.MediaStorageSOPInstanceUID = sop_uid(no, s)
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset()
    ds.file_meta = fm
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop_uid(no, s)
    ds.StudyInstanceUID = study_uid(no)
    ds.SeriesInstanceUID = series_uid(no)
    ds.AccessionNumber = accession(no)
    ds.PatientID = f"PAT{no:04d}"
    ds.PatientName = f"SYNTH^{no}"
    ds.PatientSex = meta["sex"]
    ds.StudyDate = meta["date"]
    ds.StudyDescription = meta["study"]
    ds.SeriesDescription = meta["series"]
    ds.Modality = meta["modality"]
    ds.SeriesNumber = 1
    ds.InstanceNumber = s
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = size
    ds.Columns = size
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.PixelData = bytes(size * size * 2)
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def study_files(no: int) -> list[tuple[str, bytes]]:
    return [(f"study_{no:04d}/series_001/IM{s:04d}.dcm", make_dicom(no, s)) for s in range(1, SLICES + 1)]


def make_nifti(dims=(4, 4, 2), *, gz: bool = True) -> bytes:
    hdr = bytearray(348)
    struct.pack_into("<i", hdr, 0, 348)
    struct.pack_into("<8h", hdr, 40, 3, *dims, 1, 1, 1, 1)
    struct.pack_into("<h", hdr, 70, 4)       # datatype int16
    struct.pack_into("<h", hdr, 72, 16)      # bitpix
    struct.pack_into("<f", hdr, 108, 352.0)  # vox_offset
    hdr[344:348] = b"n+1\x00"
    n = dims[0] * dims[1] * dims[2]
    data = bytes(hdr) + b"\x00" * 4 + bytes(n * 2)
    return gzip.compress(data, mtime=0) if gz else data


def make_mha(dims=(4, 4, 2)) -> bytes:
    header = (
        "ObjectType = Image\nNDims = 3\nBinaryData = True\nBinaryDataByteOrderMSB = False\n"
        f"DimSize = {dims[0]} {dims[1]} {dims[2]}\nElementType = MET_SHORT\nElementDataFile = LOCAL\n"
    )
    return header.encode() + bytes(dims[0] * dims[1] * dims[2] * 2)


def make_makesense(no: int) -> bytes:
    images = [{"id": s, "file_name": f"study_{no:04d}/series_001/IM{s:04d}.dcm", "width": 8, "height": 8}
              for s in range(1, SLICES + 1)]
    annotations = [{"id": s, "image_id": s, "category_id": 1, "bbox": [1, 1, 2, 2], "area": 4,
                    "iscrowd": 0, "segmentation": []} for s in range(1, SLICES + 1)]
    return json.dumps({"images": images, "annotations": annotations,
                       "categories": [{"id": 1, "name": "nodule"}]}).encode()


# ---- fixtures：測試模組以 `from imaging_support import orthanc, project, member` 匯入 ----

@pytest.fixture
def orthanc(app):
    o = InMemoryOrthanc(pacs=[make_dicom(no, s) for no in STUDIES for s in range(1, SLICES + 1)])
    app.state.orthanc = o
    return o


@pytest.fixture
def project(session):
    def _make(name="P1"):
        p = Project(name=name)
        session.add(p)
        session.commit()
        return p
    return _make


@pytest.fixture
def member(add_user, session):
    """建立帳號並加入專案；回傳 headers。"""
    def _make(username, project, permissions=("project", "labeling")):
        user, headers = add_user(username)
        session.add(Membership(user_id=user.id, project_id=project.id, role="custom", permissions=list(permissions)))
        session.commit()
        return headers
    return _make


def upload(client, headers, pid, files, kind="dicom"):
    return client.post(f"/api/projects/{pid}/imaging/{kind}", headers=headers,
                       files=[("files", (name, data)) for name, data in files])
