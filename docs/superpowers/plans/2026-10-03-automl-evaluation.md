# AutoML 評估紀錄（2026-10-03）

結論：**暫不導入**，先完成參考 QOCA AIM 的操作改善（`2026-10-03-qoca-ux.md`）。之後若要讓醫護人員「不必選演算法與超參數」，
建議以 **Optuna** 在現有 scikit-learn 範本上做自動搜尋。影像不導入 AutoML。

## 為什麼考慮

合約 B-05 要求「選擇訓練型態與參數並直接執行自動訓練，過程無須撰寫程式」。目前結構式訓練只提供 3 種演算法，
且要使用者自行填超參數（例如「正則化強度的倒數」），醫護人員不易理解。

## 硬限制

TC-B05-06：匯出的 pkl 必須能在平台外用 Python 載入並預測。AutoML 產出的模型必須在只裝 scikit-learn 的環境也能載入。

## 各框架現況（版本與授權取自 PyPI，2026-10-03）

| 框架 | 最新版本 | 授權 | 結論 |
|---|---|---|---|
| Optuna | 5.0.0（2026-09） | MIT | 建議。輕量，搜尋我們自己的範本，產出純 scikit-learn pipeline，沿用亂數種子可重現 |
| FLAML | 2.7.0（2026-09） | MIT | 備選。AutoML 模組連帶裝 LightGBM、XGBoost（環境約 1.1 GB）；必須限制只用 scikit-learn 估計器，否則平台外要裝 LightGBM |
| MLJAR supervised | 1.3.2（2026-07） | MIT | 模型存成目錄、要裝 mljar 才能載入，不符 TC-B05-06；自動報表（混淆矩陣、SHAP、學習曲線）值得參考 |
| AutoGluon | 1.6.3（2026-09） | Apache-2.0 | 準確度強，但模型要裝 AutoGluon 才能載入，套件含 PyTorch 很大 |
| H2O | 3.46（2026-08） | Apache-2.0 | 需要 Java 執行環境 |
| TPOT | 1.1.0（2025-07） | LGPL-3.0 | 授權需另行審查；遺傳演算法搜尋慢 |
| auto-sklearn | 0.15.0（2022-09） | BSD-3 | 停止維護，只支援到 Python 3.9 |
| NNI | 3.0（2023-09） | MIT | 停止維護 |
| PyCaret、EvalML | 2024 | MIT、BSD-3 | 停止維護，不支援 Python 3.12 與新版 scikit-learn |
| AutoKeras | 3.0.0（2025-11） | Apache-2.0 | 影像。實測與 Keras 3.15 不相容（`Dense(units=numpy.int64)` 被拒）；Keras 3.12 可執行但 CPU 上 15 分鐘跑不完 3 組試驗 |
| nnU-Net、MONAI Auto3DSeg | 2026 | Apache-2.0 | 醫學影像分割的業界標竿，但為 PyTorch，與「影像一律 Keras H5」的裁定衝突；需甲方同意 |

## 實測（合成資料 100 筆、7 個特徵、預測 diagnosis，各給 20 秒）

| 工具 | 試驗數 | 5 折交叉驗證 AUC | 測試集 AUC | 只裝 scikit-learn 1.9.1 能否載入 pkl |
|---|---|---|---|---|
| Optuna（搜尋 Logistic、RandomForest、HistGradientBoosting） | 38 | 0.801 | 0.870 | 可以 |
| FLAML（限制 rf、extra_tree、lrl1、histgb） | 5 | 0.804 | 0.867 | 可以 |

## 若之後導入的做法

1. 新增「自動找最佳模型」訓練模式：使用者只選資料集、Target、最多花幾分鐘；以 Optuna 搜尋演算法與超參數並用 K 折交叉驗證，產出合約格式的 pkl。
2. 搜尋以排程工作送進 cpu-data 佇列，不佔 GPU。
3. 結果報表參考 MLJAR，但以 scikit-learn 自行計算；SHAP 可單獨加 MIT 授權的 shap 套件。
4. 分割準確度若甲方在意，提出 nnU-Net 或 MONAI Auto3DSeg 作為選項，列入書面確認事項。
