# 介面改版第二期 API：實作說明與合約差異

合約見改版共同說明「第二期 API 合約」。以下只列實作細節、補充與和合約不同的地方。

## 與合約不同或補充的地方

1. **資料範圍的 filters key 照研究列表既有查詢參數**：`modality`、`patient_sex`、`study_description`、`study_date`（`YYYYMMDD` 或 `YYYYMMDD-YYYYMMDD`）、`series_description`。合約寫的 `sex`、`study_date_from/to` 也接受（選用），`sex` 存檔時改成 `patient_sex`。
   研究列表 API 新增 `study_date_from`、`study_date_to`（`YYYYMMDD` 或 `YYYY-MM-DD`）與 `scope_id`。細節見 `imaging/README-scopes.md`。
2. **`POST /labels/datasets/{id}/versions` 的狀態碼**：建新版回 201，沿用最新版回 200；兩者 body 都是
   `{id, version, created_at, created_by, annotations, by_class, created}`。資料集沒有任何已確認標註時回 422。
   權限：Labeling 或 Training 任一。
3. **LabelDataset 多 `auto: boolean`**：系統自動建立的預設資料集（「P1 分類標註」，專案名與「分類標註」之間有一個空格）。
   既有專案（上線前已有標註、沒有資料集）第一次 `GET /labels/datasets` 時補建。自動建立不寫稽核。
4. **標註資料集 `PUT`**：可改 `name`、`scope_id`（給 `null`＝不限範圍）、`classes`；只改有給的欄位。`task` 不可改（不同就 422）。
5. **訓練設定的 `label_dataset_id`**：可放頂層或 `source.label_dataset_id`；存檔後一律在 `config.source.label_dataset_id`，
   `source.label_source` 會被設成 `{"provider": "annotations"}`。資料集的任務必須與訓練種類一致（`image_classification`↔`classification`），
   否則送出訓練回 422；資料集不存在回 404。
   **`image.labels` 仍必填**（影像分類至少 2 個）：建議前端帶資料集的 `classes`（或 `current.by_class` 的 key）。
6. **run 回應**：`label_dataset: {id, name, version} | null`（資料集已刪除時 `name` 為 `null`，版本號保留）、
   `test_count: number | null`（訓練成功時由 `splits.json` 的 test 清單算出；之前的舊 run 為 `null`）。
   依原版本重跑（rerun）與改原始碼再跑會沿用原 run 的資料集與版本。
7. **CSV 匯入** `dataset_id`／`dataset_name`：
   - `dataset_id`：加入既有分類資料集；該資料集有限定類別時，自動把這次的診斷類別加進 `classes`。不是分類資料集回 422。
   - `dataset_name`：建立新分類資料集，`classes`＝這次的診斷類別；同名回 409。
   - 都不給：回應的 `dataset_id` 是預設分類資料集（沒有就是 `null`）。
8. **Annotation 確認**：`POST /labels/annotations/{id}/confirm` 對已確認的標註不改紀錄、直接回傳。直接確認不改 `version`；
   PUT 修改草稿會 `version + 1` 並確認。
9. **專案首頁 `GET /overview`**：
   - `me.role` 是成員資格的角色；Admin 沒有成員資格時是 `"admin"`。`me.permissions` 依字母排序。
   - `training.recent[].task` 是訓練種類（例 `image_classification`）；`setting_name` 是 run 名稱（＝送出時的設定名稱）。
   - `queue_position` 只有 `queued` 的 run 有值，算法與排程總覽的「等待中」位置相同；排程服務讀不到時是 `null`。
   - `models[].metric_name/metric_value`：依序取 test、validation、train 的主要指標
     （影像分類先 `auc` 再 `accuracy`；分割 `dice`；偵測 `mean_iou`；結構式分類 `auc`；迴歸 `r2`），沒有時 `null`。
     `name` 是分享時取的名稱，沒分享過用模型名稱。
   - `predictions` 是專案最近 5 筆預測紀錄（上傳、批次、線上），`rows`＝筆數。
   - `labeling.last`：這個人最近存過（`updated_by`）、目前看得到的那筆標註。
10. **`GET /labels/summary`** 的 `pending`／`confirmed` 只算看得到（Accession 清單內）的研究。

## 影像分類指標（trainer 範本）

寫在 `metrics.json`（也就是 run 的 `metrics`）的 `train`／`validation`／`test` 底下，與原本的 `accuracy` 同層：

- 二分類：`sensitivity`、`specificity`、`auc`、`roc: {positive, fpr: number[], tpr: number[]}`（最多 200 點；陽性類別是 `image.labels` 的第 2 個）。
  某切分只有一類時沒有 `auc`、`roc`。
- 多分類：`accuracy`、`recall_per_class: {類別: 召回率 | null}`。
- 另寫 `charts.json`（混淆矩陣；二分類另有 ROC），`GET /training/runs/{id}/charts` 與報告會顯示。
- MLflow：名稱含非英數字元的指標（例如中文類別的 `recall_per_class.*`）不送，避免整批被拒。

## 權限（CSV 越權修正）

結構式資料集的建立、刪除改需 Training（儲存想預測的欄位與前處理本來就需 Training）。上傳預檢、欄位隱藏、讀取、統計分析維持 Project。

## 部署注意

- **要跑 db-init**（`python -m app.db_init`）：新表 `label_datasets`、`label_dataset_versions`、`imaging_scopes` 由 create_all 建立，
  既有表補欄位：`label_annotations.status/confirmed_by/confirmed_at`、`training_runs.label_dataset_id/label_dataset_version/test_count`。
  平台帳號的權限由既有的 GRANT ALL TABLES／DEFAULT PRIVILEGES 涵蓋。未跑 db-init 前 API 會因缺欄位而失敗。
- **trainer 映像（CPU 與 GPU）要重建**，影像分類新指標才會出現；舊 run 沒有新欄位。
- 舊標註補欄位時一律為 `confirmed`（`confirmed_by`、`confirmed_at` 為空）。
