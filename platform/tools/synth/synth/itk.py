"""ITK MetaImage (.mha) image/label pairs written with SimpleITK."""

from pathlib import Path

import SimpleITK as sitk

from .common import rng, write_manifest
from .volume import SPACING, make_case


def _to_sitk(arr):
    img = sitk.GetImageFromArray(arr.transpose(2, 1, 0))  # numpy x,y,z -> ITK z,y,x
    img.SetSpacing(SPACING)
    img.SetOrigin((0.0, 0.0, 0.0))
    return img


def generate(out: Path, seed: int = 42, count: int = 3) -> dict:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    r = rng(seed, "itk")
    cases = []
    for i in range(count):
        image, label, classes = make_case(r, i)
        stem = f"case_{i + 1:03d}"
        sitk.WriteImage(_to_sitk(image), str(out / f"{stem}_image.mha"), useCompression=False)
        sitk.WriteImage(_to_sitk(label), str(out / f"{stem}_label.mha"), useCompression=False)
        cases.append({
            "case_id": stem,
            "image": f"{stem}_image.mha",
            "label": f"{stem}_label.mha",
            "shape": list(image.shape),
            "spacing": list(SPACING),
            "classes": classes,
        })
    return write_manifest(out, {"kind": "itk", "seed": seed, "counts": {"cases": count}, "cases": cases})
