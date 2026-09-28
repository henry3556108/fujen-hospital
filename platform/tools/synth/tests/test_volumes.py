"""NIfTI (MSD-style) and ITK .mha image/label pairs for TC-B01-03 (parse) and
TC-B01-04 (image/label pairing)."""

import json

import nibabel as nib
import numpy as np
import pytest
import SimpleITK as sitk

from synth import itk, nifti


@pytest.fixture(scope="module")
def nifti_out(tmp_path_factory):
    out = tmp_path_factory.mktemp("nifti")
    nifti.generate(out, seed=42, count=3)
    return out, json.loads((out / "manifest.json").read_text())


@pytest.fixture(scope="module")
def itk_out(tmp_path_factory):
    out = tmp_path_factory.mktemp("itk")
    itk.generate(out, seed=42, count=3)
    return out, json.loads((out / "manifest.json").read_text())


def test_nifti_pairs_named_and_counted(nifti_out):
    out, manifest = nifti_out
    assert manifest["counts"] == {"cases": 3}
    names = sorted(p.name for p in out.glob("*.nii.gz"))
    assert names == [f"case_{i:03d}_{kind}.nii.gz" for i in (1, 2, 3) for kind in ("image", "label")]
    assert [c["image"] for c in manifest["cases"]] == [f"case_{i:03d}_image.nii.gz" for i in (1, 2, 3)]
    assert [c["label"] for c in manifest["cases"]] == [f"case_{i:03d}_label.nii.gz" for i in (1, 2, 3)]


def test_nifti_parse_and_labels_match_images(nifti_out):
    out, manifest = nifti_out
    for case in manifest["cases"]:
        img = nib.load(out / case["image"])
        lab = nib.load(out / case["label"])
        assert img.shape == lab.shape == tuple(case["shape"])
        assert np.allclose(img.affine, lab.affine)
        classes = sorted(int(v) for v in np.unique(np.asarray(lab.dataobj)) if v != 0)
        assert 1 <= len(classes) <= 2
        assert classes == case["classes"]
        assert np.asarray(img.dataobj).std() > 0


def test_itk_pairs_parse_and_align(itk_out):
    out, manifest = itk_out
    assert manifest["counts"] == {"cases": 3}
    assert [c["label"] for c in manifest["cases"]] == [f"case_{i:03d}_label.mha" for i in (1, 2, 3)]
    for case in manifest["cases"]:
        assert case["image"] == case["label"].replace("_label", "_image")
        img = sitk.ReadImage(str(out / case["image"]))
        lab = sitk.ReadImage(str(out / case["label"]))
        assert img.GetSize() == lab.GetSize()
        assert img.GetSpacing() == lab.GetSpacing()
        assert img.GetOrigin() == lab.GetOrigin()
        arr = sitk.GetArrayFromImage(lab)
        classes = sorted(int(v) for v in np.unique(arr) if v != 0)
        assert 1 <= len(classes) <= 2 and classes == case["classes"]
