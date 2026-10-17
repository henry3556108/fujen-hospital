"""在自己的電腦重做整個流程：依序合併各環節的設定檔、組好各環節的程式，再訓練。

    pip install -r requirements.txt
    python run_all.py --data dataset --out out

各環節（stages/<環節>/）的設定檔與程式檔都可以修改；修改後重新執行即可。
產出：out/config.json（合併後交給訓練程式的設定）、out/model.pkl 或 out/model.h5、out/metrics.json、
out/splits.json、out/model_card.json（結構式另有 out/preprocess.pkl）。
"""
from __future__ import annotations

import argparse
import copy
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IMAGE_KINDS = ("image_classification", "image_segmentation", "image_detection")


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def merge(config: dict, stage: str, values: dict) -> dict:
    """把環節的設定檔寫回完整設定（與平台的合併規則相同）。"""
    out = copy.deepcopy(config)
    image = out["kind"] in IMAGE_KINDS
    hyper = out.setdefault("hyperparameters", {})
    if stage == "labels":
        if image:
            out["image"]["labels"] = values.get("labels")
            if out["source"]["type"] == "dicom":
                out["source"]["label_source"] = values.get("label_source")
        else:
            out["tabular"]["target"], out["tabular"]["features"] = values.get("target"), values.get("features")
    elif stage == "preprocess":
        if image:
            out["image"]["resize"] = values.get("resize", [32, 32])
            out["augmentation"] = values.get("augmentation")
            hyper.pop("augmentation_copies", None)
            if values.get("augmentation_copies") is not None:
                hyper["augmentation_copies"] = values["augmentation_copies"]
        else:
            out["tabular"]["steps"] = values.get("steps") or []
            out["tabular"].pop("missing", None)
            if values.get("missing") is not None:
                out["tabular"]["missing"] = values["missing"]
    elif stage == "train":
        kept = {k: v for k, v in hyper.items() if k == "augmentation_copies"}
        out["hyperparameters"] = {**dict(values.get("hyperparameters") or {}), **kept}
        out["split"], out["seed"] = values.get("split"), values.get("seed", 42)
        if not image:
            out["validation"] = values.get("validation")
            out["tabular"]["algorithm"] = values.get("algorithm")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="重做整個流程")
    parser.add_argument("--data", default="dataset", help="資料夾：manifest.json 與 blobs/<sha256>")
    parser.add_argument("--out", default="out")
    args = parser.parse_args(argv)
    out = Path(args.out).resolve()
    work = out / "_work"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    config = load(ROOT / "config.json")
    for stage in ("labels", "preprocess", "train"):
        path = ROOT / "stages" / stage / f"{stage}.json"
        if path.is_file():
            config = merge(config, stage, load(path))
    job = {k: v for k, v in config.items() if k != "source"}     # 資料來源已在資料夾內
    (out / "config.json").write_text(json.dumps(job, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                                     encoding="utf-8")

    for path in (ROOT / "lib").iterdir():                       # 共用模組與 tabular 函式庫
        target = work / path.name
        shutil.copytree(path, target) if path.is_dir() else shutil.copy(path, target)
    shutil.copy(ROOT / "stages" / "train" / "train.py", work / "train.py")
    for stage in ("labels", "preprocess"):                      # 有這兩個檔時，訓練程式會依序呼叫
        code = ROOT / "stages" / stage / f"{stage}.py"
        if code.is_file():
            shutil.copy(code, work / f"{stage}.py")

    command = [sys.executable, str(work / "train.py"), "--config", str(out / "config.json"),
               "--data", str(Path(args.data).resolve()), "--out", str(out)]
    print("執行：" + " ".join(command), flush=True)
    return subprocess.run(command, cwd=work).returncode


if __name__ == "__main__":
    raise SystemExit(main())
