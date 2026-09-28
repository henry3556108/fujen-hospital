"""makesense.ai-style COCO JSON annotation exports.

Each export annotates the 5 slices of one study produced by the `dicom` command;
`file_name` is the DICOM slice path relative to that command's out dir
(e.g. ``study_0001/series_001/IM0003.dcm``). Export i covers study i.
"""

from pathlib import Path

from .common import rng, write_json, write_manifest
from .dicom import SIZE, SLICES

CATEGORIES = [{"id": 1, "name": "nodule", "supercategory": ""},
              {"id": 2, "name": "organ", "supercategory": ""}]


def generate(out: Path, seed: int = 42, count: int = 3) -> dict:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    r = rng(seed, "makesense")
    exports = []
    for i in range(count):
        study_no = i + 1
        images, annotations = [], []
        for s in range(SLICES):
            image_id = s + 1
            images.append({
                "id": image_id,
                "file_name": f"study_{study_no:04d}/series_001/IM{s + 1:04d}.dcm",
                "width": SIZE,
                "height": SIZE,
            })
            for _ in range(int(r.integers(1, 3))):  # 1-2 boxes per slice
                w, h = (int(v) for v in r.integers(4, 20, size=2))
                x = int(r.integers(0, SIZE - w + 1))
                y = int(r.integers(0, SIZE - h + 1))
                annotations.append({
                    "id": len(annotations) + 1,
                    "image_id": image_id,
                    "category_id": int(r.integers(1, len(CATEGORIES) + 1)),
                    "bbox": [x, y, w, h],
                    "area": w * h,
                    "iscrowd": 0,
                    "segmentation": [],
                })
        coco = {
            "info": {"description": "my-project-name", "contributor": "synth"},
            "images": images,
            "annotations": annotations,
            "categories": CATEGORIES,
        }
        name = f"makesense_{study_no:03d}.json"
        write_json(out / name, coco)
        exports.append({"file": name, "study": f"study_{study_no:04d}",
                        "accession_number": f"ACC{study_no:04d}",
                        "images": len(images), "annotations": len(annotations)})
    return write_manifest(out, {
        "kind": "makesense",
        "seed": seed,
        "image_source": "dicom",
        "image_source_note": "file_name = DICOM slice path relative to the `dicom` output dir",
        "counts": {"exports": count},
        "exports": exports,
    })
