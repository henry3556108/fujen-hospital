# WP5b 自動訓練、模型匯出、部署與推論（B-05、B-06）Implementation Plan

> **For agentic workers:** 依 superpowers:test-driven-development 逐 Task 執行；每個 Task 一個 commit。

**Goal:** 使用者不寫程式就能：存訓練設定 → 凍結資料版本 → 送出訓練（走 WP4 的佇列）→ 得到可匯出的模型（影像 Keras H5、結構式 scikit-learn pkl）與可修改再跑的原始碼 → 批次／上傳／線上推論，並留下歷史與稽核。驗收案例 TC-B05-01～07、TC-B06-01～06。

**Architecture:**

- 平台 API 新增 `app/training/` 一包，只負責「設定、資料凍結、工作編排、紀錄、授權」，**不載入任何模型、不 import TensorFlow**。
- 訓練範本、Job 進入點、推論服務放在獨立的 uv 專案 `platform/training/`（套件名 `trainer`），打成一個映像 `platform-trainer`，同一個映像用兩種方式啟動：Kubernetes Job（`python -m trainer.runner`）與推論服務（`uvicorn trainer.serve:app`）。
- 訓練工作沿用 WP4 的 `JobBackend`：`JobSpec` 加上 `image／command／env`，由 Kueue 依專案綁定的 GPU 群組排隊。
- **Job 容器沒有平台憑證**：不掛 ServiceAccount token、不帶資料庫／物件儲存／Keycloak／Orthanc 的帳密。資料進出只靠平台 API 的「工作 I/O 端點」與一組只對這一次訓練有效的隨機 token（只能下載自己的資料包、上傳自己的產出；訓練結束即失效）。
- **資料凍結**：送出訓練當下把來源資料複製成內容定址的 blob（`sha256`），寫一份 manifest；訓練只讀 manifest 指到的 blob。之後來源被刪、被新增都不影響這次訓練。內容相同的凍結會得到同一個版本雜湊。
- 外部服務都藏在介面後面，單元測試不需 Docker：`JobBackend`（既有）、`Tracker`（MLflow／記憶體）、`InferenceBackend`（推論服務 HTTP／記憶體假實作）、`LabelProvider`（標註來源）。

**Tech Stack:** FastAPI、SQLAlchemy 2；TensorFlow CPU 2.21＋Keras 3.15（H5）、scikit-learn（pkl）、pydicom、nibabel、SimpleITK、scipy；MLflow 3（REST，API 端不裝 mlflow 套件）。

## Global Constraints

- 沿用 WP1a～WP4：錯誤訊息繁體中文；401／403／404／409／422；測試名稱帶 TC ID；稽核與業務變更同交易；稽核類別固定 8 類（訓練類用 `training`、推論類用 `inference`）。
- 權限：訓練設定、送出訓練、模型下載、部署管理＝`training`；匯出原始碼與執行修改後的原始碼＝`coding`；批次／上傳推論與歷史＝`prediction`；線上推論＝部署的授權帳號清單（不看角色）。
- `main.py` 只加 1 個 import＋1 個 `include_router`。
- 只用合成資料（`platform/tools/synth`）；不下載任何模型。
- 不改 `docs/TODO.md`、路線圖、根目錄 README；compose 的新增服務放在疊加檔 `compose.training.yaml`。

## File Structure

```
platform/libs/tabular/tabular/fitted.py      fit_pipeline()／FittedPipeline：在訓練資料上擬合、套用到其他資料
platform/training/                           獨立 uv 專案（套件 trainer）
  trainer/templates/                         匯出原始碼時整包帶走，單獨可執行
    runtime.py                               讀設定、固定亂數種子、切分、寫 metrics.json
    imagekit.py                              讀 DICOM／NIfTI／ITK、Resize、6 項資料增強（影像、遮罩、方框一致）
    image_classification.py  image_segmentation.py  image_detection.py        Keras → model.h5
    tabular_classification.py  tabular_regression.py                          scikit-learn → model.pkl
  trainer/fake_trainer.py                    假訓練：睡幾秒、寫出隨機初始化的極小模型（不需 TensorFlow）
  trainer/runner.py                          Job 進入點：下載資料包 → 執行範本或使用者原始碼 → 上傳產出
  trainer/predict.py                         載入 H5／pkl 並預測（推論服務與平台外腳本共用邏輯）
  trainer/serve.py                           推論服務（FastAPI）：管理端點載入模型、predict
  scripts/load_exported_models.py            TC-B05-06：在不含平台程式的環境載入 4 個匯出檔並預測
  Dockerfile                                 platform-trainer 映像
platform/api/app/training/
  models.py        TrainingSetting、DatasetVersion、TrainingRun、TrainedModel、Deployment、InferenceRecord
  config.py        訓練設定的驗證與正規化（5 種類、參數、6 項增強、超參數）
  labels.py        LabelProvider 介面；內建 makesense、inline
  snapshot.py      資料凍結：來源 → blob＋manifest → 版本雜湊
  bundle.py        Job 資料包（tar）、匯出原始碼（zip）、使用者原始碼檢查
  tracking.py      Tracker 介面、InMemoryTracker、MlflowTracker（REST）
  inference.py     InferenceBackend 介面、FakeInferenceBackend、HttpInferenceBackend
  service.py       業務邏輯
  router.py        使用者端點＋工作 I/O 端點
platform/api/app/scheduling/   backend.py（JobSpec 加 image／command／env）、kube.py（manifest）、service.py（submit_job 接受 workload）
platform/api/tests/training/   conftest.py 與 test_train_*.py
platform/deploy/local/compose.training.yaml   mlflow、inference 兩個服務與 api 的環境變數
platform/deploy/kind/load-trainer-image.sh    建映像並載入 kind 的 GPU 節點
platform/acceptance/test_tc_b05.py、test_tc_b06.py、training_support.py
platform/web/src/pages/inference/             推論結果頁（影像結果呈現）＋ e2e/inference.spec.ts
```

## 資料流

1. **存設定**：`POST settings` → 正規化後存成 JSON（重新載入逐欄相同）。
2. **送出**：`POST settings/{id}/runs` →（同一交易）凍結資料版本、建立 TrainingRun（複製一份設定，之後改設定不影響這次訓練）、建立排程 Job、寫 `training` 稽核 → `JobBackend.submit`。
3. **Job 內**：`trainer.runner` 以 run token 下載資料包（`config.json`＋`dataset/`＋選用的 `source/`）→ 以**清掉環境變數**的子程序執行範本 → 產出 `model.h5|pkl`、`metrics.json`、`train.log`（結構式另有 `preprocess.pkl`）→ 上傳 → 回報完成。
4. **收尾**：查詢訓練時同步排程狀態；Job 成功且模型已上傳 → 登記 TrainedModel、寫入 Tracker（參數、指標、資料版本雜湊、模型 sha256）；Job 成功但沒有模型 → 記為失敗。
5. **推論**：平台 API 把模型檔推給推論服務（服務重啟後查無模型時自動重推）；批次推論讀凍結資料的指定切分；結果存物件儲存，寫 InferenceRecord 與 `inference` 稽核。
6. **線上部署**：建立 Deployment（名稱、授權帳號清單）→ `POST /api/inference/{name}/predict` 經 Gateway 進平台 API：檢查帳號在清單內 → 轉給推論服務 → 記歷史與稽核（拒絕也記）。推論服務不對主機開連接埠，也沒有 Gateway 路由。

## API

前綴 `/api/projects/{pid}`；所有路徑都在既有的 Gateway 路由 `/api/*` 之下。

| 方法與路徑 | 權限 | 說明 |
|---|---|---|
| GET `/training/catalogue` | training | 5 種訓練、可用參數與預設值、6 項增強 |
| POST／GET `/training/settings`，GET／PUT／DELETE `/training/settings/{sid}` | training | 訓練設定 |
| POST `/training/settings/{sid}/runs` | training | 凍結資料並送出訓練；`{"executor": "template"｜"fake"}` |
| GET `/training/runs`、`/training/runs/{rid}` | training | 狀態（先同步）、設定快照、資料版本、指標 |
| POST `/training/runs/{rid}/rerun` | training | 同一資料版本、設定、種子再跑一次 |
| POST `/training/runs/{rid}/cancel` | training | 取消 |
| GET `/training/runs/{rid}/log` | training | 訓練輸出 |
| GET `/training/runs/{rid}/source` | coding | 匯出原始碼 zip（範本＋設定＋說明） |
| POST `/training/runs/{rid}/source-runs` | coding | 上傳修改後的 zip，以同一資料版本執行 |
| GET `/training/dataset-versions/{vid}` | training | manifest 摘要 |
| GET `/models`、`/models/{mid}` | prediction | 模型清單與模型卡 |
| GET `/models/{mid}/download` | training | 下載 H5／pkl |
| POST `/models/{mid}/inference/batch` | prediction | `{"subset": "test"｜"validation"｜"train"｜"all"}` |
| POST `/models/{mid}/inference/upload` | prediction | 上傳 CSV、DICOM、NIfTI、PNG |
| GET `/models/{mid}/inference`、`/inference/{iid}`、`/inference/{iid}/download` | prediction | 歷史、結果、下載 |
| POST／GET `/deployments`，PUT `/deployments/{did}/access`，DELETE `/deployments/{did}` | training | 線上部署與授權帳號 |
| POST `/api/inference/{name}/predict` | 授權帳號清單 | 線上即時推論 |
| GET `/api/job-io/runs/{rid}/bundle`，PUT `.../artifacts/{name}`，POST `.../complete` | run token（`X-Job-Token`） | 只給 Job 容器用 |

## Tasks

1. 結構式前處理拆成擬合與套用（`tabular/fitted.py`）：66 種方法全部分類為「逐列可獨立套用」或「需擬合」，後者保存訓練資料上的統計量。
2. 結構式範本 2 種＋重現性（同資料、設定、種子 → 指標與模型位元組相同）＋pkl 只含 scikit-learn 原生物件。
3. 影像範本 3 種＋6 項資料增強＋重現性＋H5 匯出。
4. fake-trainer：不需 TensorFlow 也能寫出 Keras 可載入的 H5 與 scikit-learn pkl。
5. 訓練設定 API（TC-B05-02、03）。
6. 資料凍結與標註來源（TC-B05-04、07 的資料面）。
7. 排程擴充（`JobSpec` 帶映像與指令；WP4 測試維持全過）、訓練執行 API、工作 I/O 端點、資料包（TC-B05-01）。
8. 匯出原始碼與執行修改後的原始碼；Job manifest 不含憑證（TC-B05-05）。
9. Tracker：記憶體版與 MLflow REST。
10. 模型登記與下載、推論後端、批次／上傳推論、歷史與下載（TC-B06-01～05）。
11. 線上部署與授權、稽核（TC-B06-06）。
12. Job 進入點 `runner`、推論服務 `serve`、映像。
13. 部署：`compose.training.yaml`、載入 kind 的腳本。
14. 網頁：推論結果頁與 Playwright（TC-B06-04 影像 9 筆）。
15. S0 smoke：把訓練、匯出、推論三個 skip 換成真的步驟。
16. 經 Gateway＋kind 的驗收測試、平台外載入腳本（TC-B05-06），記錄結果。

## Test List

| TC | 單元測試（不需 Docker） | 驗收（經 Gateway＋kind） |
|---|---|---|
| TC-B05-01 5 種訓練建立與狀態流轉 | `test_tc_b05_01_*`（FakeJobBackend） | 5 種各 1 次，真的在 kind 內訓練 |
| TC-B05-02 參數保存 | `test_tc_b05_02_*` | 存檔後重新讀取逐欄比對 |
| TC-B05-03 資料增強 6 項 | `test_tc_b05_03_*`（API 產生的 config.json＝輸入；範本實際套用） | — |
| TC-B05-04 重現 3 筆 | `test_tc_b05_04_*`（API：版本、設定、種子相同；範本：指標與權重相同） | 3 筆重跑，指標差異 0 |
| TC-B05-05 匯出原始碼再跑 | `test_tc_b05_05_*`（zip 內容、修改後可執行、manifest 無憑證） | 匯出 3 次、改 1 個參數執行；容器內掃描憑證 |
| TC-B05-06 模型匯出 | 範本測試內載入 | `scripts/load_exported_models.py` 在只有 scikit-learn／TensorFlow 的環境載入 2 pkl＋2 H5 |
| TC-B05-07 訓練資料被刪除 | `test_tc_b05_07_*` | 排隊中刪除來源，訓練仍以凍結版本完成 |
| TC-B06-01 批次推論 | `test_tc_b06_01_*` | 20 筆以上 |
| TC-B06-02 上傳推論 10 次 | `test_tc_b06_02_*` | 10 次 |
| TC-B06-03 歷史與下載 | `test_tc_b06_03_*` | 抽 10 筆、下載 5 次 |
| TC-B06-04 結果呈現 | `test_tc_b06_04_*`（結構式 20 筆新增預測欄；影像 9 筆） | 同左＋Playwright `inference.spec.ts` |
| TC-B06-05 模型下載 3 次 | `test_tc_b06_05_*` | 3 次，sha256 相同 |
| TC-B06-06 線上部署授權 | `test_tc_b06_06_*` | 授權 10 次、未授權 10 次、`inference` 稽核 |

## 只能在甲方驗證

- 真實 GPU 上的訓練時間與效能、GPU 記憶體用量；TensorFlow 與 CUDA／cuDNN 的相容性（TC-A01-03）。
- GPU 上的重現性：本機以 CPU 單執行緒＋`enable_op_determinism` 驗證差異 0；GPU 上部分運算不保證逐位元相同，需在甲方實測並視需要放寬為容許誤差。
- 真實影像與真實標註下的模型品質（本機資料是合成的，指標沒有臨床意義）。
- 推論服務在甲方叢集以 Deployment 方式水平擴充、線上推論的延遲。

## 結果

（完成後填寫）
