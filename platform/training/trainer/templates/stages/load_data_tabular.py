"""資料匯入環節（結構式）：依 schema.json 驗證自己的 CSV。只供地端使用，平台匯入時不讀這個檔。

    import json, load_data
    frame = load_data.load("我的資料.csv", json.load(open("schema.json", encoding="utf-8")))

平台上要改欄位結構（型別、必填、範圍、允許值、缺值寫法）時，修改 schema.json 後匯入「資料匯入」環節：
平台會用原始檔與新結構建立新的資料集，訓練設定改用新資料集，原資料集不動。
"""
import io
import sys
from pathlib import Path

import pandas

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))

from tabular.schema import Schema  # noqa: E402
from tabular.validate import validate_and_load  # noqa: E402


def load(csv_path: str, schema: dict) -> pandas.DataFrame:
    report, frame = validate_and_load(io.BytesIO(Path(csv_path).read_bytes()), Schema.from_dict(schema))
    if report["errors"]:
        raise ValueError(report["errors"][0]["message"])
    return frame
