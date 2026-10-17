"""在自己的電腦用訓練好的模型推論（不需要平台）。

    python stages/deploy/predict.py --model out --input 新資料.csv          # 結構式：輸出 CSV 加上預測欄
    python stages/deploy/predict.py --model out --input 影像.dcm 影像2.dcm  # 影像：輸出每張影像的結果（JSON）

--model 是放模型的資料夾（run_all.py 的 out/，或從平台下載的模型與 model_card.json）。
結構式會先套用 preprocess.pkl（訓練資料上擬合的前處理），所以可以直接用原始欄位的 CSV。
"""
from __future__ import annotations

import argparse
import json
import pickle
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "lib"))


def predict(model_dir: str, inputs: list[str]) -> list[dict]:
    folder = Path(model_dir)
    card = json.loads((folder / "model_card.json").read_text(encoding="utf-8"))
    if card["format"] == "pkl":
        import pandas as pd

        import tabularkit

        model = pickle.loads((folder / "model.pkl").read_bytes())
        preprocess = pickle.loads((folder / "preprocess.pkl").read_bytes())
        out = []
        for path in inputs:
            frame = pd.read_csv(path)
            predictions, notes = tabularkit.predict_frame(model, preprocess, frame)
            out += [{"input": path, "row": i + 1, "prediction": p, "note": n}
                    for i, (p, n) in enumerate(zip(predictions, notes))]
        return out
    import numpy as np

    import imagekit

    imagekit.keras_setup(0)
    import keras

    model = keras.models.load_model(folder / "model.h5", compile=False)
    size = tuple(card.get("input", {}).get("resize", (32, 32)))
    names = card.get("label_names") or []
    out = []
    for path in inputs:
        data = Path(path).read_bytes()
        fmt = "dicom" if path.lower().endswith((".dcm", ".dicom")) else "nifti" if ".nii" in path.lower() else "png"
        for index, image in enumerate(imagekit.read_slices(data, fmt)):
            batch = imagekit.prepare_image(image, size)[None, ..., None].astype("float32")
            result = model.predict(batch, verbose=0)
            entry = {"input": path, "slice": index}
            if isinstance(result, dict) or getattr(result, "ndim", 0) != 2:
                entry["note"] = "分割與偵測的輸出請參考平台的推論服務（trainer/predict.py）"
            else:
                scores = {(names[k] if k < len(names) else f"class_{k}"): round(float(v), 4)
                          for k, v in enumerate(np.asarray(result)[0])}
                entry |= {"label": max(scores, key=scores.get), "scores": scores}
            out.append(entry)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="用訓練好的模型推論")
    parser.add_argument("--model", default="out")
    parser.add_argument("--input", nargs="+", required=True)
    args = parser.parse_args(argv)
    print(json.dumps(predict(args.model, args.input), ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
