"""訓練範本的共用執行環境：讀設定與資料清單、固定亂數種子、切分資料、寫出結果。

這個檔案會跟著「匯出原始碼」一起帶走，只依賴標準函式庫與 numpy。
執行方式（每個範本都一樣）：

    python train.py --config config.json --data dataset --out out

資料夾 dataset/ 內有 manifest.json 與 blobs/<sha256>；範本只讀這裡的檔案。
產出寫到 out/：模型檔（model.h5 或 model.pkl）、metrics.json、splits.json、model_card.json。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import random
import sys
from pathlib import Path
from typing import Any, Callable

import numpy as np

SPLITS = ("train", "validation", "test")


def load_config(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_manifest(data_dir: str | Path) -> dict[str, Any]:
    return json.loads((Path(data_dir) / "manifest.json").read_text(encoding="utf-8"))


def blob_path(data_dir: str | Path, file_ref: dict[str, Any]) -> Path:
    return Path(data_dir) / "blobs" / file_ref["blob"]


def seed_everything(seed: int) -> None:
    """固定所有亂數來源。同一份資料、設定、種子必須得到相同的模型與指標。"""
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)


def split_counts(n: int, ratios: dict[str, float]) -> dict[str, int]:
    """把 n 筆依比例分成三份。先保證有資料的切分至少 1 筆，餘數給訓練集。"""
    total = sum(ratios[s] for s in SPLITS)
    if total <= 0:
        raise ValueError("切分比例總和必須大於 0")
    counts = {s: int(n * ratios[s] / total) for s in SPLITS}
    for s in ("validation", "test"):
        if ratios[s] > 0 and counts[s] == 0 and n >= 3:
            counts[s] = 1
    counts["train"] = n - counts["validation"] - counts["test"]
    if counts["train"] < 1:
        raise ValueError(f"資料只有 {n} 筆，無法切出訓練集")
    return counts


def split_groups(groups: list[str], ratios: dict[str, float], seed: int) -> dict[str, list[str]]:
    """以「群組」為單位切分（同一個研究或病例的影像不會同時出現在訓練與測試）。
    群組先排序再以種子洗牌，所以結果只跟群組名稱、比例、種子有關。"""
    unique = sorted(set(groups))
    order = np.random.RandomState(seed).permutation(len(unique))
    shuffled = [unique[i] for i in order]
    counts = split_counts(len(shuffled), ratios)
    a, b = counts["train"], counts["train"] + counts["validation"]
    return {"train": shuffled[:a], "validation": shuffled[a:b], "test": shuffled[b:]}


def split_rows(n: int, ratios: dict[str, float], seed: int) -> dict[str, list[int]]:
    order = np.random.RandomState(seed).permutation(n)
    counts = split_counts(n, ratios)
    a, b = counts["train"], counts["train"] + counts["validation"]
    return {"train": sorted(map(int, order[:a])), "validation": sorted(map(int, order[a:b])),
            "test": sorted(map(int, order[b:]))}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def library_versions(names: list[str]) -> dict[str, str]:
    from importlib import metadata

    versions = {"python": platform.python_version()}
    for name in names:
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            pass
    return versions


def write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def finish(out_dir: Path, *, config: dict, manifest: dict, model_file: str, model_format: str,
           metrics: dict[str, Any], splits: dict[str, Any], card: dict[str, Any], libraries: list[str]) -> dict:
    """寫出 metrics.json、splits.json、model_card.json。模型卡記錄重現所需的一切。"""
    out_dir = Path(out_dir)
    write_json(out_dir / "metrics.json", metrics)
    write_json(out_dir / "splits.json", splits)
    full_card = {
        "kind": config["kind"], "format": model_format, "model_file": model_file,
        "model_sha256": sha256_file(out_dir / model_file),
        "seed": config["seed"], "dataset_content_hash": manifest.get("content_hash"),
        "metrics": metrics, "libraries": library_versions(libraries), **card,
    }
    write_json(out_dir / "model_card.json", full_card)
    return full_card


def stage_folder() -> Path:
    """訓練程式（train.py）所在的資料夾。"""
    main_module = sys.modules.get("__main__")
    return Path(getattr(main_module, "__file__", None) or ".").resolve().parent


def stage_module(name: str):
    """匯入控制的環節程式（labels.py、preprocess.py）：與訓練程式同一個資料夾內有這個檔案才載入，否則回傳 None。
    平台範本與「匯出原始碼」都沒有這兩個檔，行為與原本相同；只有用匯入程式碼送出的訓練才會有。"""
    import importlib.util

    path = stage_folder() / f"{name}.py"
    if not path.is_file():
        return None
    loaded = sys.modules.get(name)
    if loaded is not None and Path(getattr(loaded, "__file__", "") or "").resolve() == path.resolve():
        return loaded
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main(train: Callable[[dict, Path, Path], dict], argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="平台訓練範本")
    parser.add_argument("--config", default="config.json")
    parser.add_argument("--data", default="dataset")
    parser.add_argument("--out", default="out")
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    config = load_config(args.config)
    seed_everything(int(config["seed"]))
    card = train(config, Path(args.data), out)
    print(json.dumps({"metrics": card["metrics"], "model": card["model_file"],
                      "model_sha256": card["model_sha256"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit("請執行 train.py")
