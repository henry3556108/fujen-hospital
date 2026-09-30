# 批次推論改為背景工作（async inference）Implementation Plan

> **For agentic workers:** 依 superpowers:test-driven-development 逐 Task 執行；每個 Task 一個 commit。

**Goal:** 批次推論不再在平台 API 的請求內同步執行。送出後立即回傳推論編號與狀態（排隊中），實際推論在背景工作完成；使用者之後查狀態、看結果、下載。大批量不會卡住或逾時請求。TC-B06-01～04 的驗收行為不變（筆數、預測欄、影像結果、歷史與下載），只是改為「送出 → 輪詢 → 結果」。

**Architecture:**

- **批次推論是一件 Kubernetes Job**，走 WP4 既有的 `JobBackend`、Kueue 佇列與 WP5b 的 `platform-trainer` 映像（新進入點 `python -m trainer.batch`）。不另起 API 旁的 worker 程序。理由：
  - 與訓練同一套機制：排隊、GPU 配額、取消、執行時限、GPU Dashboard 都已經有，也已在 kind 驗證過。
  - 甲方的 GPU 是依專案綁定的群組（獨占池 2 張、共享池時間片）。影像模型的大批量推論需要 GPU，就應該跟訓練一樣排進專案綁定的群組，而不是在 API 容器或推論服務（CPU、單一副本）裡搶資源。
  - API 旁的 worker 需要另一套佇列（資料庫輪詢或 Redis）、另一個部署單元、自己的並行與記憶體控制，而且無法使用 GPU 池；worker 當掉時進行中的批次也需要另外的回收機制。
  - 推論服務（`trainer.serve`）保持只服務上傳推論與線上推論；大批次不會把它拖慢。
- **依模型選池**：影像模型（Keras）→ 專案綁定的 GPU 群組（工作種類 `inference`）；結構式模型（scikit-learn，不用 GPU）→ CPU 池 `cpu-data`（工作種類 `inference-cpu`），不占 GPU 卡。
- **Job 容器沒有平台憑證**，與訓練相同：只拿到 `INFERENCE_ID`、`JOB_IO_URL`、`JOB_IO_TOKEN`。token 只對這一筆推論有效（下載這一筆的輸入包、回報這一筆的結果），結束即失效，資料庫只存雜湊。
- **輸入包在下載時才組**：送出時只讀 manifest 與切分紀錄、決定要推論哪些列或影像（存在推論紀錄的 `input`）；影像與 CSV 內容等 Job 來下載時才從凍結的 blob 組成 tar（模型、前處理、模型卡、欄位規格、輸入）。送出請求因此與批量大小無關。
- **結果組裝在 API**：容器只回報原始預測（結構式 `predictions/notes`，影像 `results`）。API 以既有的 `_tabular_result` 在原始資料後加預測欄、影像組成 JSON，存物件儲存，更新推論紀錄並寫稽核，全部同一個交易。結果格式與同步版完全相同，歷史、檢視、下載端點不變。
- **狀態**沿用排程的五種：`queued → running → succeeded | failed | cancelled`。推論紀錄的狀態在查詢時與排程工作同步（與訓練相同的做法）；容器回報完成時立即定案，不必等 Pod 結束。
- **資料表**：新增 `inference_batches`（推論紀錄 1 對 1：排程工作、token 雜湊、開始／結束時間）。`inference_records` 不加欄位——平台以 `create_all` 建表、沒有遷移工具，既有資料庫加欄位不會生效，新增資料表則會。

## Global Constraints

- 沿用 WP1a～WP5b：錯誤訊息繁體中文；401／403／404／409／422；稽核與業務變更同交易；稽核類別固定 8 類（批次推論一律 `inference`，包括它的排程工作 `job.submit`／`job.cancel`）。
- 權限：送出、查詢、取消批次推論＝`prediction`（與同步版相同）。
- 上傳推論（TC-B06-02）與線上推論（TC-B06-06）維持同步：上傳有 50 MB 上限、線上一次最多 1000 筆，本來就是有界的；使用者（與呼叫端程式）期待當下拿到答案。
- 掃毒（`app/scanning.py`）不變：上傳推論與線上影像照舊先掃毒。批次推論的輸入是凍結資料，來源在進平台時已掃過，Job 只讀凍結的 blob。
- 共用檔案最少改動：`scheduling/service.py` 只加工作種類與一個不 commit 的取消函式；`compose.training.yaml` 只把 `TRAINING_IMAGE` 改成可覆寫；網頁只改推論頁與它的 mock。
- 不改 `docs/TODO.md`、路線圖、根目錄 README。

## API

前綴 `/api/projects/{pid}`。

| 方法與路徑 | 權限 | 舊行為 | 新行為 |
|---|---|---|---|
| POST `/models/{mid}/inference/batch` `{"subset": "test"｜"validation"｜"train"｜"all"}` | prediction | 201，同步推論完才回，body＝完整結果（`result`） | **202**，立即回推論紀錄：`status: "queued"`、`job_id`、`count`＝輸入筆數、`result: null`。subset 錯 422；切分沒有資料、沒有切分紀錄、影像模型但專案沒綁 GPU 群組 409；排程系統連不上 503 |
| GET `/inference/{iid}` | prediction | 結果 | 先與排程同步再回傳。`status` 為 `queued`／`running` 時 `result: null`；`succeeded` 時 `result` 與舊格式相同；`failed`／`cancelled` 時 `message` 說明原因 |
| GET `/models/{mid}/inference` | prediction | 歷史 | 同左；進行中的批次會先同步狀態。每筆多了 `job_id`、`started_at`、`finished_at`（非批次為 null） |
| GET `/inference/{iid}/download` | prediction | 下載；沒有結果 404 | 同左；**還在排隊或執行中回 409**「推論尚未完成」 |
| POST `/inference/{iid}/cancel` | prediction | — | **新增**。排隊或執行中的批次推論 → 刪除 Job、狀態 `cancelled`、稽核 `inference.batch.cancel`。已結束 409；不是批次推論 409 |
| POST `/models/{mid}/inference/upload` | prediction | 201 同步 | 不變 |
| POST `/api/inference/{name}/predict` | 部署授權帳號 | 200 同步 | 不變 |
| GET `/api/job-io/inference/{iid}/bundle` | `X-Job-Token` | — | **新增**，只給 Job 容器：tar（`batch.json`、模型、前處理、欄位規格、輸入） |
| POST `/api/job-io/inference/{iid}/complete` `{"status", "message", "answer"}` | `X-Job-Token` | — | **新增**，只給 Job 容器：回報預測，API 組結果並定案 |

呼叫端（網頁或程式）的改法：把「POST batch 拿到結果」改成「POST batch 拿到 `id` → 每 1～5 秒 GET `/inference/{id}`，直到 `status` 是 `succeeded`／`failed`／`cancelled`」。結果物件的格式沒有改。網頁的 `src/pages/inference/api.ts` 提供 `waitForRecord(api, id)` 可直接使用。

稽核（類別都是 `inference`）：

| action | 時機 | result |
|---|---|---|
| `inference.batch` | 送出（與推論紀錄、批次列、排程工作同一交易） | success |
| `job.submit`、`job.cancel` | 排程工作（WP4 的動作名稱，推論工作歸類為 `inference`） | success |
| `inference.batch.finish` | 成功、失敗、排程工作失敗或消失時定案（與狀態變更同一交易） | success／failure |
| `inference.batch.cancel` | 使用者取消（與狀態變更、`job.cancel` 同一交易） | cancelled |

## 失敗、取消、刪除

- 容器回報 `failed`（模型無法載入、輸入不符欄位規格）→ `failed`，訊息是容器給的原因。
- Job 失敗但沒有回報（映像拉不到、OOM、超過共享池時限）→ 同步時 `failed`，訊息是排程的原因。
- Job 成功結束卻沒有回報結果 → `failed`「工作結束，但沒有回報推論結果」。
- Job 在叢集中消失 → `failed`（沿用排程的判定）。
- 推論服務故障不影響批次推論（批次不經過它）。
- **排隊中刪除專案**（模型只會隨專案刪除而消失，沒有單獨刪除模型的功能）：`inference_records`、`inference_batches`、`jobs` 都 ON DELETE CASCADE。之後 Job 開始執行時以 token 下載輸入包 → 紀錄已不存在 → 401，容器以非 0 結束，不會拿到任何資料，也不會寫回任何結果。叢集內的 Job 由 `ttlSecondsAfterFinished` 清掉，與訓練的裁定一致。
- token 在定案（成功、失敗、取消）時立即失效；對別筆推論無效。

## File Structure

```
platform/api/app/training/models.py      InferenceBatch（inference_batches）
platform/api/app/training/batch.py       送出、同步、取消、工作 I/O（輸入包、完成）
platform/api/app/training/service.py     移除同步的 batch_inference；record_out 帶批次欄位
platform/api/app/training/router.py      202 送出、取消、下載 409、工作 I/O 端點
platform/api/app/scheduling/service.py   工作種類 inference／inference-cpu；mark_cancelled（不 commit）
platform/api/tests/training/test_train_batch.py         新增
platform/api/tests/training/test_train_inference.py     改為送出 → 模擬 Job → 輪詢
platform/api/tests/training/conftest_training.py        run_batch：以真的 trainer.batch 進入點模擬 Job
platform/training/trainer/batch.py       Job 進入點：下載輸入包 → 載入模型 → 分批預測 → 回報
platform/training/tests/test_batch.py
platform/web/src/pages/inference/*        送出 → 輪詢 → 結果、取消、狀態文字
platform/web/src/mocks/inference.ts       批次改為 202＋狀態推進
platform/web/tests/unit/inference-page.test.tsx、e2e/inference.spec.ts
platform/smoke/s0/test_scenarios.py       情境 5（與情境 6 的批次推論步驟）
platform/acceptance/test_tc_b05_b06.py    批次改為送出後輪詢，Job 在 kind 執行
platform/deploy/local/compose.training.yaml  TRAINING_IMAGE 可覆寫
platform/deploy/kind/load-trainer-image.sh   預設也載入 cpu-data 節點
```

## Tasks

1. 本計畫。
2. `trainer.batch` 進入點（platform/training）：輸入包格式、結構式與影像預測、分批、失敗回報；單元測試。
3. 排程：工作種類 `inference`（GPU）與 `inference-cpu`（cpu-data），推論工作的排程稽核歸 `inference`；`mark_cancelled` 讓呼叫端在同一交易取消；WP4 測試維持全過。
4. API：`InferenceBatch` 資料表、送出（202）、工作 I/O、同步、定案、取消、下載 409；單元測試（狀態流轉、失敗、取消、token、刪除專案、稽核同交易、選池）。
5. 既有推論測試改為非同步流程（TC-B06-01、03、權限、推論服務重啟）。
6. 網頁：推論頁送出 → 輪詢 → 結果，狀態與取消；mock 與單元測試、Playwright。
7. S0 smoke 情境 5（與 6 的批次步驟）改為送出 → 以真的 `trainer.batch` 進入點跑 Job → 輪詢。
8. 驗收：`test_tc_b05_b06.py` 批次改為送出後輪詢；部署設定；經 Gateway＋kind 執行並記錄結果。

## Test List

| TC | 單元測試（不需 Docker） | 驗收（經 Gateway＋kind） |
|---|---|---|
| TC-B06-01 批次推論 20 筆以上 | `test_tc_b06_01_*`：送出回 202／queued → 以 `trainer.batch` 跑 Job → succeeded、20 筆、預測欄、不含目標欄 | 結構式 test 切分 ≥20 筆在 cpu-data 跑完；影像 test 切分 ≥20 筆在 gpu-exclusive 跑完 |
| TC-B06-02 上傳推論 10 次 | 不變（同步） | 不變 |
| TC-B06-03 歷史與下載 | `test_tc_b06_03_*`：10 筆批次，歷史全在、最新在前、下載 5 次；未完成下載 409 | 送出 10 筆批次，全部跑完後抽 10 筆、下載 5 次 |
| TC-B06-04 結果呈現 | 結構式 20 筆、影像 9 筆（上傳，不變）；網頁：批次送出 → 輪詢 → 20 列預測欄 | 同左＋Playwright `inference.spec.ts` |
| TC-B06-06 線上部署 | 不變 | 不變 |
| 非同步行為 | `test_train_batch.py`：狀態流轉、容器回報失敗、Job 失敗未回報、Job 成功未回報、取消（排隊中、已結束 409）、token 範圍與失效、環境變數無憑證、刪除專案後 token 401、稽核與狀態同交易、影像→GPU 群組／結構式→cpu-data、沒綁 GPU 群組 409、subset 422 | 驗收中檢查送出請求在數秒內回應、狀態序列 queued→…→succeeded、`inference` 稽核 |
