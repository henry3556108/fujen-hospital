"""Synthetic CT/MR DICOM studies (stand-in for the TCIA 20-study baseline)."""

import datetime as dt
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian

from .common import UID_ROOT, balanced, patients, rng, uid, write_manifest

CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2"
MR_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.4"
IMPLEMENTATION_CLASS_UID = UID_ROOT + "0.1"

SLICES = 5
SIZE = 64
DESCRIPTIONS = {
    "CT": {
        "study": ["CT CHEST WO CONTRAST", "CT ABDOMEN PELVIS W CONTRAST"],
        "series": ["AXIAL 5MM SOFT TISSUE", "AXIAL 1MM LUNG"],
    },
    "MR": {
        "study": ["MR BRAIN WWO CONTRAST", "MR KNEE WO CONTRAST"],
        "series": ["AX T1", "AX T2 FLAIR"],
    },
}

# UID "kind" component so study/series/instance/frame UIDs never collide.
STUDY, SERIES, INSTANCE, FRAME = 1, 2, 3, 4


def _dataset(meta: dict, slice_idx: int, pixels: np.ndarray, seed: int, study_no: int) -> Dataset:
    modality = meta["modality"]
    sop_class = CT_IMAGE_STORAGE if modality == "CT" else MR_IMAGE_STORAGE
    sop_uid = uid(seed, INSTANCE, study_no, slice_idx + 1)

    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = sop_class
    fm.MediaStorageSOPInstanceUID = sop_uid
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    fm.ImplementationClassUID = IMPLEMENTATION_CLASS_UID
    fm.ImplementationVersionName = "SYNTH_0_1"

    ds = Dataset()
    ds.file_meta = fm
    ds.SpecificCharacterSet = "ISO_IR 100"
    ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop_uid
    ds.StudyDate = meta["study_date"]
    ds.SeriesDate = meta["study_date"]
    ds.StudyTime = "090000"
    ds.AccessionNumber = meta["accession_number"]
    ds.Modality = modality
    ds.Manufacturer = "SYNTH"
    ds.InstitutionName = "SYNTHETIC HOSPITAL"
    ds.ReferringPhysicianName = "SYNTH^REFERRER"
    ds.StudyDescription = meta["study_description"]
    ds.SeriesDescription = meta["series_description"]
    ds.PatientName = meta["patient_name"]
    ds.PatientID = meta["patient_id"]
    ds.PatientBirthDate = meta["patient_birth_date"]
    ds.PatientSex = meta["patient_sex"]
    ds.SliceThickness = "5"
    if modality == "CT":
        ds.KVP = "120"
    else:
        ds.ScanningSequence = "SE"
        ds.SequenceVariant = "NONE"
        ds.ScanOptions = ""
        ds.MRAcquisitionType = "2D"
        ds.RepetitionTime = "500"
        ds.EchoTime = "15"
        ds.MagneticFieldStrength = "1.5"
    ds.StudyInstanceUID = meta["study_instance_uid"]
    ds.SeriesInstanceUID = meta["series_instance_uid"]
    ds.StudyID = str(study_no)
    ds.SeriesNumber = 1
    ds.InstanceNumber = slice_idx + 1
    ds.ImagePositionPatient = [0, 0, slice_idx * 5]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.FrameOfReferenceUID = uid(seed, FRAME, study_no)
    ds.PositionReferenceIndicator = ""
    ds.SliceLocation = slice_idx * 5
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows = SIZE
    ds.Columns = SIZE
    ds.PixelSpacing = [1, 1]
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    if modality == "CT":
        ds.RescaleIntercept = "-1024"
        ds.RescaleSlope = "1"
        ds.RescaleType = "HU"
    ds.PixelData = pixels.astype("<u2").tobytes()
    return ds


def _volume(r: np.random.Generator, modality: str) -> np.ndarray:
    """Noise plus a bright ellipsoid 'lesion' so images are not pure noise."""
    z, y, x = np.mgrid[0:SLICES, 0:SIZE, 0:SIZE]
    cy, cx = r.integers(20, 44, size=2)
    rad = r.integers(6, 12)
    blob = ((y - cy) ** 2 + (x - cx) ** 2 + ((z - 2) * 4) ** 2) < rad**2
    base = 1024 if modality == "CT" else 200
    vol = base + r.normal(0, 30, size=z.shape) + blob * (400 if modality == "CT" else 600)
    return np.clip(vol, 0, 4095).astype(np.uint16)


def generate(out: Path, seed: int = 42, studies: int = 20) -> dict:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    r = rng(seed, "dicom")
    modalities = ["CT" if i % 2 == 0 else "MR" for i in range(studies)]
    roster = patients(seed, studies)
    days = r.choice(366, size=studies, replace=False)
    desc = {}
    for mod in ("CT", "MR"):
        n = modalities.count(mod)
        desc[mod] = (
            iter(balanced(r, DESCRIPTIONS[mod]["study"], n)),
            iter(balanced(r, DESCRIPTIONS[mod]["series"], n)),
        )

    records = []
    for i in range(studies):
        no = i + 1
        mod = modalities[i]
        pat = roster[i]
        study_date = (dt.date(2024, 1, 1) + dt.timedelta(days=int(days[i]))).strftime("%Y%m%d")
        meta = {
            "accession_number": f"ACC{no:04d}",
            "patient_id": pat["patient_id"],
            "patient_name": f"{pat['family']}^{pat['given']}",
            "patient_sex": pat["sex"],
            "patient_birth_date": pat["birth_date"],
            "modality": mod,
            "study_date": study_date,
            "study_description": next(desc[mod][0]),
            "series_description": next(desc[mod][1]),
            "study_instance_uid": uid(seed, STUDY, no),
            "series_instance_uid": uid(seed, SERIES, no, 1),
        }
        vol = _volume(r, mod)
        files, sops = [], []
        for s in range(SLICES):
            ds = _dataset(meta, s, vol[s], seed, no)
            rel = f"study_{no:04d}/series_001/IM{s + 1:04d}.dcm"
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            ds.save_as(out / rel, enforce_file_format=True)
            files.append(rel)
            sops.append(ds.SOPInstanceUID)
        records.append({**meta, "files": files, "sop_instance_uids": sops})

    ct = [m["accession_number"] for m in records if m["modality"] == "CT"]
    mr = [m["accession_number"] for m in records if m["modality"] == "MR"]
    half = 5 if studies >= 20 else max(1, len(ct) // 2)
    allow = sorted(
        [ct[int(i)] for i in r.choice(len(ct), size=min(half, len(ct)), replace=False)]
        + [mr[int(i)] for i in r.choice(len(mr), size=min(half, len(mr)), replace=False)]
    )
    manifest = {
        "kind": "dicom",
        "seed": seed,
        "uid_root": UID_ROOT,
        "counts": {"studies": studies, "series": studies, "instances": studies * SLICES},
        "filter_fields": {
            "Modality": "modality",
            "PatientSex": "patient_sex",
            "StudyDescription": "study_description",
            "StudyDate": "study_date",
            "SeriesDescription": "series_description",
        },
        "accession_allowlist": allow,
        "studies": records,
    }
    return write_manifest(out, manifest)
