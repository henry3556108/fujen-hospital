"""MSD-style NIfTI image/label pairs."""

from pathlib import Path

import nibabel as nib
import numpy as np

from .common import rng, write_manifest
from .volume import SPACING, make_case


def generate(out: Path, seed: int = 42, count: int = 3) -> dict:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    r = rng(seed, "nifti")
    affine = np.diag([*SPACING, 1.0])
    cases = []
    for i in range(count):
        image, label, classes = make_case(r, i)
        stem = f"case_{i + 1:03d}"
        nib.save(nib.Nifti1Image(image, affine), out / f"{stem}_image.nii.gz")
        nib.save(nib.Nifti1Image(label, affine), out / f"{stem}_label.nii.gz")
        cases.append({
            "case_id": stem,
            "image": f"{stem}_image.nii.gz",
            "label": f"{stem}_label.nii.gz",
            "shape": list(image.shape),
            "spacing": list(SPACING),
            "classes": classes,
        })
    return write_manifest(out, {"kind": "nifti", "seed": seed, "counts": {"cases": count}, "cases": cases})
