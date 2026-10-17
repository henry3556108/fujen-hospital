"""標註環節（結構式）：決定要預測的欄位（Target）。

平台預設：資料表原樣傳回，Target 與 Feature 依 labels.json。
可以修改 build_labels，例如由數值欄位產生「是否」的 Target：

    frame["dm_within_1y"] = (frame["hba1c"] >= 6.5).astype(int)

限制（訓練時檢查，不符合時訓練失敗）：
  - 只能新增或修改 Target 欄位、刪除列
  - 不能新增、修改或刪除其他欄位（推論時沒有這段程式，特徵必須與原始資料相同）
"""
import pandas


def build_labels(frame: pandas.DataFrame, config: dict) -> pandas.DataFrame:
    """frame：驗證後的資料表；config：labels.json（target、features）。回傳加上或修正 Target 後的資料表。"""
    return frame
