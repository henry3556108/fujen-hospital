"""測試資料一律來自 platform/tools/synth；以內容定址的方式擺成平台凍結資料的格式。"""
import hashlib
import json
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
