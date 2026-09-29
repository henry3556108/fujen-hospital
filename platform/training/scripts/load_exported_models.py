"""TC-B05-06：在平台外用 Python 載入匯出的模型並預測。

只 import scikit-learn、pandas、numpy、keras；不 import 任何平台程式（trainer、tabular、範本）。

    python load_exported_models.py model_a.pkl model_b.pkl model_c.h5 model_d.h5

每個檔案印一行 JSON：檔名、格式、輸入、預測的形狀。任一檔失敗時以 1 結束。
"""
import json
import os
import pickle
import sys

PLATFORM_MODULES = ("trainer", "tabular", "runtime", "imagekit", "tabularkit", "app")


def load_pkl(path: str) -> dict:
    import pandas as pd

    with open(path, "rb") as fh:
        model = pickle.load(fh)
    names = list(model.feature_names_in_)
    rows = pd.DataFrame([[0.0] * len(names), [1.0] * len(names), [-1.0] * len(names)], columns=names)
    predictions = model.predict(rows)
    return {"model": type(model).__name__, "features": names, "predictions": [str(p) for p in predictions]}


def load_h5(path: str) -> dict:
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
    import keras
    import numpy as np

    model = keras.models.load_model(path, compile=False)
    shape = [1 if d is None else d for d in model.input_shape]
    shape[0] = 2
    out = model.predict(np.random.RandomState(0).rand(*shape).astype("float32"), verbose=0)
    shapes = {k: list(v.shape) for k, v in out.items()} if isinstance(out, dict) else list(out.shape)
    return {"model": model.name, "input": list(model.input_shape), "outputs": shapes}


def main(paths: list[str]) -> int:
    failed = 0
    for path in paths:
        try:
            info = load_pkl(path) if path.endswith(".pkl") else load_h5(path)
            print(json.dumps({"file": os.path.basename(path), "ok": True, **info}, ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(json.dumps({"file": os.path.basename(path), "ok": False, "error": f"{type(exc).__name__}: {exc}"},
                             ensure_ascii=False))
    leaked = sorted({m.split(".")[0] for m in sys.modules} & set(PLATFORM_MODULES))
    print(json.dumps({"platform_modules_imported": leaked}))
    return 1 if failed or leaked else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
