# 建模端使用性改善（QOCA 參考，B 組）Implementation Plan

> **For agentic workers:** 依 superpowers:test-driven-development 逐 Task 執行；每個 Task 一個 commit。

**Goal:** 依 `2026-10-03-qoca-ux.md` 的 B 組，讓不寫程式的醫師與護理人員能從資料集一路走到部署：從資料集頁「用這份資料建立訓練」、看得懂的超參數說明、K 折交叉驗證、用圖表看模型好不好（每個指標一句話說明什麼叫好）、可列印的報表、圖示步驟條、「部署此模型」捷徑。匯出的 pkl 仍只依賴 scikit-learn。

**Architecture:**

- 訓練範本（`platform/training/trainer/templates/`）多寫一個產出 `charts.json`；圖表資料**不進模型檔**，也不進 `metrics.json` 與模型卡（模型卡只放指標）。K 折結果放在 `metrics.json` 的 `cv`。
- 平台 API：設定多一個選填的 `validation`（只限結構式）；目錄（catalogue）的每個超參數多 `help`（白話說明與建議）與 `advanced`（是否收在進階設定）；工作 I/O 多收 `charts.json`；新增兩個讀取端點（圖表、報表）。
- 網頁：只改 `pages/training/`、`pages/deployment/`、`mocks/training.ts`；資料集頁只加一個連結元件（放在 `pages/training/` 內，`DatasetLayout.tsx` 只加 import 與一行）。

## 設定（config）變更

結構式訓練新增選填欄位 `validation`：

```json
{"validation": {"method": "holdout"}}                // 固定比例切分（預設；舊設定沒有這個欄位就是它）
{"validation": {"method": "kfold", "folds": 5}}      // K 折交叉驗證，folds 2～10，預設 5
```

- 正規化後結構式設定一定帶 `validation`；影像設定帶 `validation` 回 422「影像訓練目前只支援固定比例切分」。
- 向下相容：已存的設定與已送出的訓練（`config.json` 沒有 `validation`）照舊讀取、照舊以固定比例切分執行。`normalise(normalise(x)) == normalise(x)` 不變。
- K 折的資料用法：`split.test` 的列先保留為測試集（與固定比例相同，以種子洗牌）；其餘列（訓練＋驗證）做 K 折交叉驗證，分類用分層 K 折（每類至少 K 筆時；否則改一般 K 折並在指標註明），亂數種子固定洗牌。每折的前處理只在該折的訓練列上擬合。最後的模型以全部非測試列訓練，測試集評估一次。網頁在 K 折時只問測試集比例，送出 `train = 1 - test, validation = 0`。

## 產出與資料格式

`metrics.json`（既有欄位不變，新增）：

- 二元分類的各切分多 `auc`。
- K 折時多 `cv`：

```json
{"cv": {"method": "kfold", "folds": 5, "stratified": true, "rows": 80,
        "accuracy": {"mean": 0.81, "std": 0.04, "values": [0.8, 0.85, 0.75, 0.81, 0.84]},
        "f1_macro": {...}, "auc": {...}}}                              // 迴歸為 r2、mae、rmse
```

`charts.json`（新產出，只有結構式範本寫；fake-trainer 與影像不寫）：

```json
{"version": 1, "kind": "tabular_classification", "subset": "test", "rows": 20,
 "confusion_matrix": {"labels": ["0", "1"], "matrix": [[9, 2], [3, 6]]},          // 列＝實際，欄＝預測
 "roc": {"positive": "1", "auc": 0.83, "points": [[0.0, 0.0], [0.1, 0.5], [1.0, 1.0]]},   // 只有二元分類
 "feature_importance": {"method": "permutation", "metric": "accuracy", "repeats": 5,
                        "items": [{"feature": "age", "mean": 0.12, "std": 0.03}]},      // 依 mean 由大到小
 "regression": null}
```

迴歸：`confusion_matrix`、`roc` 為 null，`feature_importance.metric = "r2"`，

```json
"regression": {"points": [[actual, predicted]], "total": 20, "sampled": false,
               "residuals": [{"start": -10.0, "end": -5.0, "count": 3}]}
```

- `subset`：測試集有資料用測試集，否則驗證集，再否則訓練集（網頁註明「以訓練資料計算，結果可能過度樂觀」）。
- 散佈點最多 500 點（超過時依固定間隔取樣）；ROC 點最多 200 點；數值四捨五入到 6 位。
- 重現：同資料、設定、種子 → `metrics.json`、`charts.json` 逐位元組相同（permutation importance 用種子、單執行緒）。

## API 變更

前綴 `/api/projects/{pid}`。

| 方法與路徑 | 權限 | 說明 |
|---|---|---|
| GET `/training/catalogue` | training | 每個超參數多 `help`、`advanced`；多 `validation_methods`（`holdout`、`kfold`，K 範圍與預設） |
| POST／PUT `/training/settings[/{sid}]` | training | 接受 `validation`（見上） |
| GET `/training/runs/{rid}/charts` | training | `{"run_id", "kind", "charts": {...} \| null}`；沒有圖表（影像、fake-trainer、舊訓練）時 `charts` 為 null |
| GET `/training/runs/{rid}/report` | training | 可列印的 HTML 報表（附件 `training-run-{rid}-report.html`）：設定、指標與白話說明、K 折平均±標準差、圖表（內嵌 SVG）、模型 SHA-256。訓練未完成回 409；寫 `training` 稽核 `training.report` |
| PUT `/api/job-io/runs/{rid}/artifacts/charts.json` | run token | 工作 I/O 多收 `charts.json` |

## 網頁

- **B1** 資料集頁標題下「用這份資料建立訓練」（需要 Training）→ `/training?dataset={id}`：開啟新增表單，帶入資料集、Target、Feature、前處理步驟（資料集已存的 Target／Feature 設定），設定名稱預設「{資料集名稱} 訓練」；依 Target 預選種類：類別、文字、是否 → 分類；數字且不同值不超過 10 個 → 分類；其他數字 → 迴歸。
- **B2** 每個超參數旁一行白話說明與建議值；不常調的收在「進階設定（一般不需要調整）」。切分、亂數種子也有說明。
- **B3** 結構式「驗證方式」：固定比例切分／K 折交叉驗證（K 預設 5）。
- **B4** 訓練紀錄清單：依主要分數排序（分類 AUC，沒有 AUC 用準確率；迴歸 R²；K 折用平均），點「展開」在清單內看細節。細節：主要指標卡（數值＋一句話說明什麼叫好）、K 折平均±標準差、混淆矩陣、ROC、特徵重要性、預測值對實際值、殘差分布；「下載報表」。
- **B5** 圖示步驟條：已送出 → 排隊中 → 訓練中 → 完成（或失敗、已取消），進行中每 1.5 秒自動更新。
- **B6** 完成且有模型的訓練上「部署此模型」→ `/deployment?model={id}`：部署表單預選該模型、預填部署名稱並捲到表單。

## Tasks

1. 本計畫。
2. 範本：K 折、AUC、`charts.json`（混淆矩陣、ROC、permutation importance、迴歸散佈與殘差）；runner 上傳 `charts.json`；重現與 pkl 測試。
3. API：`validation` 設定、目錄的 `help`／`advanced`／`validation_methods`、工作 I/O 收 `charts.json`、圖表端點、報表端點。
4. 網頁 API 用戶端與模擬（目錄、`validation`、圖表、報表）。
5. 設定表單：超參數說明與進階收合（B2）、驗證方式（B3）。
6. 從資料集建立訓練（B1）。
7. 訓練紀錄：排序、展開、指標說明、圖表、下載報表（B4），步驟條（B5）。
8. 「部署此模型」（B6）。
9. Playwright、`demo-flow.spec.ts` 段落 4、教材段落 4。

## Test List

| 項目 | 測試 |
|---|---|
| TC-B05-01 結構式分類、迴歸（固定比例與 K 折） | `platform/training` `test_tabular_templates.py`：三種演算法 × 兩種驗證方式都完成，`charts.json` 形狀正確 |
| TC-B05-04 重現（含 K 折與圖表） | 同設定與種子跑 3 次：`metrics.json`、`charts.json`、模型檔逐位元組相同；換種子不同 |
| TC-B05-06 pkl 平台外載入 | 既有子程序測試（只 import scikit-learn），K 折產出的 pkl 也測；`model.pkl` 不含圖表資料 |
| K 折不洩漏 | 每折前處理只在該折訓練列擬合；測試列不參與交叉驗證 |
| 設定相容 | `platform/api`：沒有 `validation` 的舊設定可讀、可送出、`config.json` 不多欄位；`validation` 驗證錯誤為繁中 422；影像帶 `validation` 回 422 |
| 目錄 | 每個超參數都有 `help` 與 `advanced` |
| 圖表與報表端點 | 401／403／404／409；沒有圖表時 `charts: null`；報表含指標說明與 SVG；`training.report` 稽核 |
| 網頁 | Vitest：說明與進階收合、K 折存檔後重新載入一致（TC-B05-02）、舊設定（無 `validation`）可開啟與儲存、從資料集帶入與預選種類、步驟條、排序與展開、圖表與指標說明、下載報表、部署捷徑預選 |
| Playwright（Chromium＋Edge） | `training.spec.ts`：從資料集建立 K 折訓練 → 步驟條 → 圖表 → 報表 → 部署此模型；`demo-flow.spec.ts` 段落 4 |
