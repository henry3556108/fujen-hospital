"""資料清理與前處理環節（結構式）：補值、編碼（One-Hot 等）、縮放、離群值、特徵工程。

平台預設：依 preprocess.json 的 steps 在訓練資料上擬合（tabular.fitted.fit_pipeline），
再套用到驗證與測試資料。missing 是含缺值病人的處理：impute 補值、drop 不使用（null 等於 drop）。

修改 fit_transform 時，回傳的轉換器必須有 transform(frame) -> frame。
注意：轉換器不是平台的 fit_pipeline 產生的話，模型會標示「自訂前處理」，可以下載，但不能在平台推論或部署。
"""
import pandas
from tabular.fitted import fit_pipeline


def fit_transform(train: pandas.DataFrame, config: dict) -> tuple[object, pandas.DataFrame]:
    """train：訓練資料（只有訓練集的列）；config：preprocess.json（steps、missing）。回傳（轉換器, 轉換後的訓練資料）。"""
    return fit_pipeline(train, config.get("steps") or [])
