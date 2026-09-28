"""DICOM studies for TC-B01-02 (batch import), TC-B01-06 (dedupe by SOP UID),
TC-B01-08 (accession allowlist) and TC-B01-09 (5-field filter)."""

import json
import re
from collections import Counter
from pathlib import Path

import pydicom
import pytest

from synth import dicom

CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2"
MR_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.4"
UID_ROOT = "1.2.826.0.1.3680043.10.9999."
FILTER_FIELDS = {
    "Modality": "modality",
    "PatientSex": "patient_sex",
    "StudyDescription": "study_description",
    "StudyDate": "study_date",
    "SeriesDescription": "series_description",
}


@pytest.fixture(scope="module")
def generated(tmp_path_factory):
    out = tmp_path_factory.mktemp("dicom")
    dicom.generate(out, seed=42, studies=20)
    manifest = json.loads((out / "manifest.json").read_text())
    return out, manifest


def _read_all(out: Path, manifest):
    for study in manifest["studies"]:
        for rel in study["files"]:
            yield study, pydicom.dcmread(out / rel)


def test_manifest_counts_match_baseline(generated):
    _, manifest = generated
    assert len(manifest["studies"]) == 20
    assert manifest["counts"] == {"studies": 20, "series": 20, "instances": 100}
    assert all(len(s["files"]) == 5 for s in manifest["studies"])


def test_half_ct_half_mr(generated):
    _, manifest = generated
    assert Counter(s["modality"] for s in manifest["studies"]) == {"CT": 10, "MR": 10}


def test_files_are_valid_dicom_with_pixels(generated):
    out, manifest = generated
    for study, ds in _read_all(out, manifest):
        assert ds.file_meta.TransferSyntaxUID == pydicom.uid.ExplicitVRLittleEndian
        expected_class = CT_IMAGE_STORAGE if study["modality"] == "CT" else MR_IMAGE_STORAGE
        assert ds.SOPClassUID == expected_class
        assert ds.file_meta.MediaStorageSOPClassUID == expected_class
        assert ds.file_meta.MediaStorageSOPInstanceUID == ds.SOPInstanceUID
        assert ds.pixel_array.shape == (64, 64)
        assert ds.pixel_array.dtype.name == "uint16"


def test_headers_match_manifest(generated):
    out, manifest = generated
    for study, ds in _read_all(out, manifest):
        assert ds.StudyInstanceUID == study["study_instance_uid"]
        assert ds.SeriesInstanceUID == study["series_instance_uid"]
        assert ds.AccessionNumber == study["accession_number"]
        assert ds.PatientID == study["patient_id"]
        assert str(ds.PatientName) == study["patient_name"]
        for keyword, key in FILTER_FIELDS.items():
            assert getattr(ds, keyword) == study[key], keyword


def test_identifiers_unique_and_uids_valid(generated):
    out, manifest = generated
    studies = manifest["studies"]
    for key in ("study_instance_uid", "series_instance_uid", "accession_number", "patient_id", "patient_name"):
        values = [s[key] for s in studies]
        assert len(set(values)) == 20, key
    assert [s["accession_number"] for s in studies] == [f"ACC{i:04d}" for i in range(1, 21)]
    sop_uids = [ds.SOPInstanceUID for _, ds in _read_all(out, manifest)]
    assert len(set(sop_uids)) == 100
    uid_re = re.compile(r"^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$")
    for uid in sop_uids + [s["study_instance_uid"] for s in studies] + [s["series_instance_uid"] for s in studies]:
        assert uid.startswith(UID_ROOT)
        assert len(uid) <= 64 and uid_re.match(uid), uid


def test_slices_are_ordered_and_distinct(generated):
    out, manifest = generated
    by_series = {}
    for study, ds in _read_all(out, manifest):
        by_series.setdefault(study["series_instance_uid"], []).append(ds)
    for slices in by_series.values():
        assert [int(d.InstanceNumber) for d in slices] == [1, 2, 3, 4, 5]
        assert len({float(d.ImagePositionPatient[2]) for d in slices}) == 5


def test_filter_fields_give_nontrivial_subsets(generated):
    _, manifest = generated
    for keyword, key in FILTER_FIELDS.items():
        counts = Counter(s[key] for s in manifest["studies"])
        assert len(counts) >= 2, keyword
        assert max(counts.values()) < 20, keyword
    assert {s["patient_sex"] for s in manifest["studies"]} == {"M", "F"}
    assert all(s["study_date"].startswith("2024") and len(s["study_date"]) == 8 for s in manifest["studies"])


def test_accession_allowlist_has_10_known_entries(generated):
    _, manifest = generated
    allow = manifest["accession_allowlist"]
    assert len(allow) == 10 and len(set(allow)) == 10
    known = {s["accession_number"] for s in manifest["studies"]}
    assert set(allow) <= known


def test_manifest_paths_are_relative(generated):
    out, manifest = generated
    for study in manifest["studies"]:
        for rel in study["files"]:
            assert not Path(rel).is_absolute()
            assert (out / rel).is_file()
