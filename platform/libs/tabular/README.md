# tabular — 結構式資料核心函式庫

供平台 FastAPI 後端呼叫的結構式（表格）資料核心。所有公開函式回傳純 JSON 可序列化的 dict / list（無 numpy 型別、無 NaN，缺值一律為 `None`）；可預期的輸入錯誤一律拋出 `tabular.errors.TabularError`（繁體中文訊息，`to_dict()` 供 API 轉成 4xx 回應）。

```bash
uv sync && uv run pytest
```

## 模組

| 模組 | 功能 | 對應驗收案例 |
|---|---|---|
| `tabular.schema` | 欄位結構定義（int / float / str / category / date / bool；required、min、max、allowed、unique），可由 dict / JSON 載入 | TC-B01-10 |
| `tabular.validate` | `validate_csv` 驗證報告、`load_clean_csv` 取得乾淨資料；逐列攔截欄位數錯誤、型別、範圍、允許值、必填、重複值；缺必要欄位與空檔為檔案層級錯誤，未知欄位為警告 | TC-B01-10 |
| `tabular.explore` | `describe`、`histogram`、`value_counts`、`preview`（可指定可見欄位）、`column_info`、`correlation`、`scatter` | TC-B04-01、TC-B04-02、TC-B04-05、TC-B04-08 |
| `tabular.preprocess` | 前處理方法註冊表 `catalogue()`、`validate_steps` 與 `apply_pipeline(df, steps)` | TC-B04-04、TC-B04-06 |
| `tabular.modeling_config` | `TargetFeatureConfig(target, features, steps)`，`to_dict` / `from_dict` 往返一致，檢查 Target 不在 Features、欄位存在 | TC-B04-03 |
| `tabular.stats` | `logistic`（係數、勝算比與 95% CI、AIC、pseudo-R²、ROC）、`linear`（係數、CI、R²、調整 R²、殘差對預測值）、`kaplan_meier`（各組存活曲線、中位存活時間、分組時 log-rank 檢定）、`cox`（HR、CI、p、concordance、森林圖與基準存活曲線）；與 statsmodels / lifelines 直接計算差異 < 1e-9 | TC-B04-07、TC-B04-08 |

欄位型別防護（TC-B04-08）：文字、類別、日期或全空欄位送入數值分析（直方圖、相關、散佈圖、四種統計、數值前處理）時，一律回 `TabularError`（如「欄位「diagnosis」不是數值欄位，無法進行數值分析」），不會拋出原始例外。

設計取捨：前處理步驟為無狀態（在傳入的資料上 fit + transform）；統計模型對用到的欄位做整列刪除缺值並回報 `n_dropped`；類別特徵需先以 `onehot` 等步驟編碼。測試資料 `tests/fixtures/patients.csv`（100 列，由 `tests/fixtures/generate.py` 以固定亂數種子產生），Cox 另以 lifelines 內建 `load_rossi` 驗證。

## 前處理方法清單（共 66 種）

<!-- catalogue:start -->
| ID | 名稱 | 類別 | 適用欄位型別 |
|---|---|---|---|
| `impute_mean` | 平均數補值 | 缺值處理 | numeric |
| `impute_median` | 中位數補值 | 缺值處理 | numeric |
| `impute_most_frequent` | 眾數補值 | 缺值處理 | any |
| `impute_constant` | 固定值補值 | 缺值處理 | any |
| `impute_knn` | K 近鄰補值 | 缺值處理 | numeric |
| `impute_ffill` | 向前填補 | 缺值處理 | any |
| `impute_bfill` | 向後填補 | 缺值處理 | any |
| `impute_interpolate` | 線性內插補值 | 缺值處理 | numeric |
| `drop_missing_rows` | 刪除含缺值的列 | 缺值處理 | any |
| `drop_columns_missing_ratio` | 刪除缺值比例過高的欄位 | 缺值處理 | any |
| `add_missing_indicator` | 新增缺值指示欄 | 缺值處理 | any |
| `scale_standard` | 標準化（Z 分數） | 縮放與數值轉換 | numeric |
| `scale_minmax` | 最小最大值縮放 | 縮放與數值轉換 | numeric |
| `scale_maxabs` | 最大絕對值縮放 | 縮放與數值轉換 | numeric |
| `scale_robust` | 穩健縮放（中位數與四分位距） | 縮放與數值轉換 | numeric |
| `normalize_l1` | 列向量 L1 正規化 | 縮放與數值轉換 | numeric |
| `normalize_l2` | 列向量 L2 正規化 | 縮放與數值轉換 | numeric |
| `normalize_max` | 列向量最大值正規化 | 縮放與數值轉換 | numeric |
| `quantile_uniform` | 分位數轉換（均勻分布） | 縮放與數值轉換 | numeric |
| `quantile_normal` | 分位數轉換（常態分布） | 縮放與數值轉換 | numeric |
| `power_yeo_johnson` | Yeo-Johnson 冪轉換 | 縮放與數值轉換 | numeric |
| `power_box_cox` | Box-Cox 冪轉換 | 縮放與數值轉換 | numeric |
| `log1p` | log(1+x) 轉換 | 縮放與數值轉換 | numeric |
| `log` | 自然對數轉換 | 縮放與數值轉換 | numeric |
| `log10` | 常用對數（log10）轉換 | 縮放與數值轉換 | numeric |
| `sqrt` | 平方根轉換 | 縮放與數值轉換 | numeric |
| `square` | 平方轉換 | 縮放與數值轉換 | numeric |
| `reciprocal` | 倒數轉換 | 縮放與數值轉換 | numeric |
| `scale_zscore_clip` | 標準化後截斷 | 縮放與數值轉換 | numeric |
| `clip_values` | 指定範圍截斷 | 縮放與數值轉換 | numeric |
| `onehot` | One-Hot 編碼 | 類別編碼 | categorical, text, boolean |
| `ordinal` | 順序編碼 | 類別編碼 | categorical, text, boolean |
| `label` | 標籤編碼 | 類別編碼 | categorical, text, boolean |
| `frequency` | 頻率編碼 | 類別編碼 | categorical, text, boolean |
| `count` | 計數編碼 | 類別編碼 | categorical, text, boolean |
| `binary_map` | 二元對應（指定陽性值為 1） | 類別編碼 | any |
| `kbins_uniform` | 等寬分箱 | 離散化 | numeric |
| `kbins_quantile` | 等頻（分位數）分箱 | 離散化 | numeric |
| `kbins_kmeans` | K-Means 分箱 | 離散化 | numeric |
| `binarize` | 二值化（大於門檻為 1） | 離散化 | numeric |
| `iqr_clip` | IQR 截斷離群值 | 離群值處理 | numeric |
| `iqr_remove` | IQR 刪除離群列 | 離群值處理 | numeric |
| `zscore_clip` | Z 分數截斷離群值 | 離群值處理 | numeric |
| `zscore_remove` | Z 分數刪除離群列 | 離群值處理 | numeric |
| `winsorize_1` | 縮尾處理（1% / 99%） | 離群值處理 | numeric |
| `winsorize_5` | 縮尾處理（5% / 95%） | 離群值處理 | numeric |
| `polynomial_2` | 二次多項式特徵 | 特徵工程 | numeric |
| `interaction_terms` | 交互作用項 | 特徵工程 | numeric |
| `pca` | 主成分分析（PCA） | 特徵工程 | numeric |
| `drop_duplicate_rows` | 刪除重複列 | 資料清理 | any |
| `drop_constant_columns` | 刪除常數欄位 | 資料清理 | any |
| `strip_text` | 去除前後空白 | 資料清理 | categorical, text |
| `lower_text` | 轉小寫 | 資料清理 | categorical, text |
| `upper_text` | 轉大寫 | 資料清理 | categorical, text |
| `replace_value` | 取代特定值 | 資料清理 | any |
| `to_numeric` | 轉為數值（無法轉換者設為缺值） | 資料清理 | any |
| `to_datetime` | 轉為日期時間（無法轉換者設為缺值） | 資料清理 | any |
| `extract_year` | 擷取年份 | 資料清理 | datetime, text, categorical |
| `extract_month` | 擷取月份 | 資料清理 | datetime, text, categorical |
| `extract_day` | 擷取日 | 資料清理 | datetime, text, categorical |
| `extract_weekday` | 擷取星期（週一為 0） | 資料清理 | datetime, text, categorical |
| `rename_columns` | 重新命名欄位 | 資料清理 | any |
| `drop_columns` | 刪除欄位 | 資料清理 | any |
| `select_columns` | 只保留指定欄位 | 資料清理 | any |
| `cast_type` | 轉換資料型別 | 資料清理 | any |
| `round` | 四捨五入 | 資料清理 | numeric |
<!-- catalogue:end -->

每種方法的參數以 JSON Schema 定義，請由 `catalogue()` 取得。`numeric` 型別的方法亦接受布林欄位；欄位清單留空時自動套用到所有適用欄位。

## 訓練用：在訓練資料上擬合、套用到其他資料

`apply_pipeline` 每一步都用收到的資料自己擬合，適合探索單一資料集。訓練模型時統計量只能來自訓練切分，否則測試資料的資訊會洩漏進模型。

```python
from tabular.fitted import fit_pipeline

fitted, train_out = fit_pipeline(train_df, steps)      # 在訓練資料上擬合
test_out = fitted.transform(test_df)                    # 套用到驗證、測試資料
rows_out = fitted.transform(upload_df, optional=["target"])   # 推論資料可以沒有目標欄
```

66 種方法各屬一種模式（`tabular.fitted.STEP_MODES`）：

| 模式 | 行為 | 例子 |
|---|---|---|
| `stateless` | 不涉及統計量，各資料各自套用 | 對數轉換、固定值補值、型別轉換 |
| `fitted` | 統計量在訓練資料上取得並保存 | 平均數補值、縮放、One-Hot、分箱、離群值界線、PCA |
| `train_only` | 會刪除列；只在擬合時執行，`transform` 不刪列 | 刪除含缺值的列、刪除重複列、IQR／Z 分數刪除離群列 |

在訓練資料上，`fit_pipeline` 的結果與 `apply_pipeline` 完全相同。訓練資料沒出現過的類別：One-Hot 全為 0、頻率與計數編碼為 0、順序與標籤編碼為空值。
