"""測試資料一律來自 platform/tools/synth；以內容定址的方式擺成平台凍結資料的格式。"""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PLATFORM = Path(__file__).resolve().parents[2]
TEMPLATES = PLATFORM / "training" / "trainer" / "templates"
sys.path.insert(0, str(TEMPLATES))

SPLIT = {"train": 0.6, "validation": 0.2, "test": 0.2}


@pytest.fixture(scope="session")
def synth(tmp_path_factory) -> Path:
    if os.environ.get("SYNTH_DIR"):     # 預先產生的資料（GPU 映像內沒有 uv，見 scripts/test-gpu-image.sh）
        return Path(os.environ["SYNTH_DIR"])
    out = tmp_path_factory.mktemp("synth")
    subprocess.run(["uv", "run", "-q", "python", "-m", "synth", "all", "--out", str(out)],
                   cwd=PLATFORM / "tools" / "synth", check=True, capture_output=True)
    return out


class DatasetBuilder:
    """寫出 dataset/manifest.json 與 dataset/blobs/<sha256>，格式與平台 API 的凍結結果相同。"""

    def __init__(self, root: Path, kind: str, label_names=()):
        self.root, self.kind, self.items, self.label_names = Path(root), kind, [], list(label_names)
        (self.root / "blobs").mkdir(parents=True, exist_ok=True)

    def blob(self, data: bytes, fmt: str) -> dict:
        digest = hashlib.sha256(data).hexdigest()
        (self.root / "blobs" / digest).write_bytes(data)
        return {"blob": digest, "format": fmt, "size": len(data)}

    def add(self, item_id: str, group: str, files: dict, **extra) -> None:
        self.items.append({"id": item_id, "group": group, "files": files, **extra})

    def write(self) -> Path:
        body = {"version": 1, "kind": self.kind, "label_names": self.label_names, "items": self.items}
        body["content_hash"] = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        (self.root / "manifest.json").write_text(json.dumps(body, ensure_ascii=False, indent=1))
        return self.root


@pytest.fixture
def tabular_dataset(synth, tmp_path) -> Path:
    b = DatasetBuilder(tmp_path / "dataset", "tabular")
    tab = synth / "tabular"
    b.add("cohort_01", "cohort_01", {"csv": b.blob((tab / "cohort_01.csv").read_bytes(), "csv"),
                                     "schema": b.blob((tab / "schema.json").read_bytes(), "json")})
    return b.write()


def run_template(name: str, config: dict, data: Path, out: Path, *, env=None) -> dict:
    """以子程序執行範本，與 Job 容器和匯出後的用法相同。"""
    out.mkdir(parents=True, exist_ok=True)
    config_path = out.parent / f"{out.name}-config.json"
    config_path.write_text(json.dumps(config, ensure_ascii=False))
    result = subprocess.run([sys.executable, str(TEMPLATES / f"{name}.py"), "--config", str(config_path),
                             "--data", str(data), "--out", str(out)],
                            capture_output=True, text=True, cwd=TEMPLATES, env=env)
    assert result.returncode == 0, result.stdout[-2000:] + result.stderr[-4000:]
    return json.loads((out / "model_card.json").read_text())


def _dicom_items(synth: Path, builder: DatasetBuilder, studies: int, boxes_by_file=None, label_of=None):
    import pydicom

    for study in sorted((synth / "dicom").glob("study_*"))[:studies]:
        for path in sorted(study.rglob("*.dcm")):
            data = path.read_bytes()
            ds = pydicom.dcmread(path, stop_before_pixels=True)
            extra = {}
            if label_of:
                extra["label"] = label_of(ds)
            if boxes_by_file is not None:
                extra["boxes"] = boxes_by_file.get(path.relative_to(synth / "dicom").as_posix(), [])
            builder.add(str(ds.SOPInstanceUID), str(ds.StudyInstanceUID), {"image": builder.blob(data, "dicom")},
                        **extra)


@pytest.fixture
def classification_dataset(synth, tmp_path) -> Path:
    """20 個研究 × 5 張切片；Label 取 DICOM 的 Modality（CT／MR），讓小模型學得起來。"""
    b = DatasetBuilder(tmp_path / "dataset", "image_classification", ["CT", "MR"])
    _dicom_items(synth, b, 20, label_of=lambda ds: str(ds.Modality))
    return b.write()


@pytest.fixture
def detection_dataset(synth, tmp_path) -> Path:
    """makesense 標註涵蓋的 3 個研究（15 張切片）。"""
    boxes, names = {}, {}
    for path in sorted((synth / "makesense").glob("makesense_*.json")):
        coco = json.loads(path.read_text())
        names = {c["id"]: c["name"] for c in coco["categories"]}
        files = {i["id"]: i["file_name"] for i in coco["images"]}
        for a in coco["annotations"]:
            boxes.setdefault(files[a["image_id"]], []).append({"label": names[a["category_id"]], "bbox": a["bbox"]})
    b = DatasetBuilder(tmp_path / "dataset", "image_detection", list(names.values()))
    _dicom_items(synth, b, 3, boxes_by_file=boxes)
    return b.write()


@pytest.fixture
def segmentation_dataset(synth, tmp_path) -> Path:
    b = DatasetBuilder(tmp_path / "dataset", "image_segmentation", ["class_1", "class_2"])
    for image in sorted((synth / "nifti").glob("*_image.nii.gz")):
        case = image.name.replace("_image.nii.gz", "")
        label = image.with_name(f"{case}_label.nii.gz")
        b.add(case, case, {"image": b.blob(image.read_bytes(), "nifti"), "mask": b.blob(label.read_bytes(), "nifti")})
    return b.write()
