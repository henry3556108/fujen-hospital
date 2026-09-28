import json

import pytest

from app.imaging.formats import InvalidFile, parse_file
from imaging_support import make_makesense, make_mha, make_nifti


@pytest.mark.parametrize("name,data,fmt,role,case", [
    ("case_001_image.nii.gz", make_nifti(), "nifti", "image", "case_001"),
    ("nifti/case_002_label.nii.gz", make_nifti(), "nifti", "label", "case_002"),
    ("case_003_image.nii", make_nifti(gz=False), "nifti", "image", "case_003"),
    ("itk/case_001_label.mha", make_mha(), "itk", "label", "case_001"),
    ("imagesTr/lung_004.nii.gz", make_nifti(), "nifti", "image", "lung_004"),
    ("labelsTr/lung_004.nii.gz", make_nifti(), "nifti", "label", "lung_004"),
    ("makesense_001.json", make_makesense(1), "makesense", "label", None),
])
def test_tc_b01_03_formats_parse(name, data, fmt, role, case):
    parsed = parse_file(name, data)
    assert (parsed.format, parsed.role, parsed.case) == (fmt, role, case)


def test_nifti_dims_recorded():
    assert parse_file("a_image.nii.gz", make_nifti((4, 4, 2))).meta["dims"] == [4, 4, 2]


def test_makesense_image_refs():
    parsed = parse_file("m.json", make_makesense(2))
    assert parsed.meta["file_names"] == [f"study_0002/series_001/IM000{s}.dcm" for s in (1, 2, 3)]
    assert parsed.meta["annotations"] == 3


@pytest.mark.parametrize("name,data,reason", [
    ("notes.txt", b"hello", "不支援的副檔名"),
    ("case_001_image.nii.gz", b"not gzip at all", "NIfTI"),
    ("case_001_image.nii.gz", make_nifti()[:40], "NIfTI"),
    ("case_001_image.nii", make_nifti(gz=False)[:360], "NIfTI"),
    ("case_001_image.mha", b"ObjectType = Image\nNDims = 3\n", "MetaImage"),
    ("case_001_image.mha", make_mha()[:-10], "MetaImage"),
    ("case_001_image.mhd", b"ObjectType = Image\n", "不支援的副檔名"),
    ("m.json", b"{not json", "JSON"),
    ("m.json", json.dumps({"images": []}).encode(), "makesense"),
    ("m.json", json.dumps({"images": [{"id": 1}], "annotations": [], "categories": []}).encode(), "makesense"),
    ("m.json", json.dumps({"images": [{"id": [1], "file_name": "a"}], "annotations": [],
                           "categories": []}).encode(), "makesense"),
    ("m.json", json.dumps({"images": [{"id": 1, "file_name": "a"}], "annotations": ["x"],
                           "categories": []}).encode(), "makesense"),
])
def test_tc_b01_05_bad_files_rejected_with_reason(name, data, reason):
    with pytest.raises(InvalidFile, match=reason):
        parse_file(name, data)
