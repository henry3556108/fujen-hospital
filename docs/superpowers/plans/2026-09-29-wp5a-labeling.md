# WP5a 影像標註與自動標註（B-02、B-03）Implementation Plan

> **For agentic workers:** 依 superpowers:test-driven-development 逐 Task 執行；每個 Task 一個 commit。

**Goal:** 醫師在平台上開啟研究、調窗位、做分類／分割／偵測標註並評分；以 CSV 診斷結果自動做分類標註；把影像送給自動標註服務，結果回存平台後可在標註工作台開啟修正；標完可直接建立訓練任務。OHIF 檢視器部署在 Gateway 後面，DICOMweb 一律走 `/dicomweb/projects/{pid}`，Accession 清單照樣生效。

**Architecture:** `app/labeling/` 自成一包：資料表（標註、自動標註執行紀錄）、標註內容驗證（純函式）、`AutolabelClient` 介面（記憶體假實作供單元測試、HTTP 實作接 MONAI Label 相容服務）、服務層、路由。標註只存在平台資料庫（PostgreSQL JSON），不寫回 Orthanc；DICOMweb 維持唯讀。
網頁的標註工作台是平台自己的頁面：經 DICOMweb 取 metadata 與 frame 原始像素，在瀏覽器端做窗位、旋轉、排列與三種標註。OHIF 是另外部署的進階檢視器（多平面重組、量測），用同一個 Keycloak 登入，從工作台以連結開啟。

**Spec:** 驗收案例 TC-B02-01～07、TC-B03-01～05（`docs/test-cases/acceptance-test-cases.md`），次數與判準不放寬。

**Tech Stack:** FastAPI、SQLAlchemy 2、httpx；React 19、Canvas 2D；OHIF Viewer v3（官方映像 `ohif/app`）；APISIX 3.11；`platform/fakes` 的 fake-autolabel（MONAI Label 介面子集）。

## Global Constraints

- 沿用 WP1a：錯誤訊息繁體中文；401／403／404／409／422；測試名稱帶 TC ID。
- 讀取需 `project` 權限，寫入（新增、修改、刪除、評分、CSV 標註、送自動標註）需 `labeling` 權限。
- 標註寫入與 `dataset` 類稽核同一個交易；8 類稽核固定，不新增類別。
- 標註對象必須是專案索引內、且在 Accession 清單內的研究；series／instance 必須屬於該研究，否則 404。
- 自動標註服務失敗時不寫入任何標註或執行紀錄（只留一筆 `result=failure` 的稽核）。
- `main.py` 只加 1 個 import 與 1 個 `include_router`。
- 只用合成資料（`platform/tools/synth`）；不下載模型。
- compose 新增內容放 `deploy/local/compose.labeling.yaml`；APISIX 路由附加在 `apisix.yaml` 結尾的 WP5a 區塊。

## File Structure

```
platform/api/app/labeling/
  __init__.py
  models.py        Annotation、AutolabelRun（繼承 app.models.Base，專案外鍵 ON DELETE CASCADE）
  payloads.py      三種標註內容的驗證與正規化（純函式）；RLE 編解碼
  autolabel.py     AutolabelClient 介面、InMemoryAutolabel、HttpAutolabel、autolabel_from_env()
  formats.py       自動標註輸入輸出格式規格（程式可讀），對照 docs/specs/autolabel-io-format.md
  csv_labels.py    CSV 診斷結果解析與對齊（純函式）
  service.py       標註 CRUD、評分、CSV 自動分類、自動標註送出與回存、摘要
  router.py        /api/projects/{project_id}/labels/*
platform/api/tests/labeling/     conftest.py 與 test_label_*.py
docs/specs/autolabel-io-format.md   自動標註輸入輸出格式（TC-B03-04 的比對基準）
platform/deploy/local/
  compose.labeling.yaml        autolabel（fake）、ohif；api 的 AUTOLABEL_URL；apisix 多開一個埠
  apisix/config.labeling.yaml  node_listen 9080＋9081（OHIF 專用埠）
  ohif/app-config.js           資料來源、OIDC、器官窗、快捷鍵
platform/web/src/pages/labeling/   標註清單、工作台、CSV 標註、自動標註、建立訓練任務
platform/web/src/mocks/labeling.ts MSW：標註 API 與合成 DICOMweb
platform/web/e2e/labeling.spec.ts  TC-B02-01～04、06，TC-B03-03
platform/acceptance/test_tc_b02.py  test_tc_b03.py  test_ohif.py  labeling_support.py
```

## Data Model

| 資料表 | 欄位 |
|---|---|
| `label_annotations` | id、project_id、study_instance_uid、series_instance_uid?、sop_instance_uid?、kind（classification｜segmentation｜detection）、payload（JSON）、source（manual｜csv｜autolabel）、rating（1–5，可空）、version（每次修改 +1）、autolabel_run_id?、created_by、updated_by、created_at、updated_at |
| `label_autolabel_runs` | id、project_id、model、model_type、study_instance_uid、sop_instance_uid、annotation_id、duration_ms、created_by、created_at |

標註內容（payload）：

| kind | payload |
|---|---|
| classification | `{"label": "nodule"}` |
| segmentation | `{"shape": [高, 寬], "encoding": "rle", "rle": [[標籤值, 長度], …], "label_names": {"background": 0, …}}`；row-major；長度總和＝高×寬 |
| detection | `{"shape": [高, 寬], "box_format": "xyxy", "boxes": [{"label", "box": [x1, y1, x2, y2], "score"?}]}` |

分類標註可掛在研究層級（不帶 sop）或單張影像；分割與偵測必須指定影像。

## API（前綴 `/api/projects/{project_id}/labels`）

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| GET | `/annotations?study_uid=&sop_uid=&kind=&source=` | project | 列出標註 |
| POST | `/annotations` | labeling | 新增；回 201 |
| GET | `/annotations/{id}` | project | 單筆 |
| PUT | `/annotations/{id}` | labeling | 修改內容（version +1） |
| PUT | `/annotations/{id}/rating` | labeling | 評分 1–5；`null` 清除 |
| DELETE | `/annotations/{id}` | labeling | 刪除；回 204 |
| GET | `/summary` | project | 各研究的標註數、各標籤筆數（給訓練選 Label 用） |
| POST | `/classification-csv` | labeling | 上傳 CSV；`key`＝`patient_id`｜`accession_number`；逐列結果 |
| GET | `/autolabel/models` | project | 自動標註服務提供的模型 |
| POST | `/autolabel` | labeling | `{model, study_instance_uid, sop_instance_uid}`；成功回 201 與標註 |
| GET | `/autolabel/runs` | project | 執行紀錄 |

## Data Flow

1. 手動標註：工作台 → `POST /annotations` → 驗證內容 → 檢查研究可存取 → 寫入標註＋稽核（同交易）→ 重新載入時 `GET /annotations` 取回同一份 payload。
2. CSV 自動分類：解析 CSV（鍵欄、診斷欄）→ 依病歷號（Patient ID）或影像編號（Accession Number）對到專案內可存取的研究 → 每個研究一筆 `source=csv` 的研究層級分類標註（同一研究重傳時更新）→ 回傳逐列結果（matched／unmatched／conflict）。同一鍵出現不同診斷視為衝突，該鍵不寫入。
3. 自動標註：`POST /autolabel` → 檢查影像 → `AutolabelClient.infer(model, image_id)` → 以格式規格驗證回應 → 轉成標註內容 → 寫入標註＋執行紀錄＋稽核（同交易）。服務離線、逾時、回應不合規格 → 503／502，不寫標註。
4. 開啟編輯：工作台載入 `source=autolabel` 的標註，修改後 `PUT /annotations/{id}`；source 不變、version 增加、`updated_by` 記修改者。
5. 影像顯示：工作台向 Gateway 取 `/dicomweb/projects/{pid}/studies/{uid}/series/{uid}/metadata` 與 `…/instances/{uid}/frames/1`（帶使用者 token），在瀏覽器套用 Rescale 與窗位。
6. OHIF：`http://localhost:9081/viewer?StudyInstanceUIDs=<uid>&project=<pid>`；`app-config.js` 依 `project` 參數把資料來源指到 `/dicomweb/projects/{pid}`；以 Keycloak OIDC 登入後帶 Bearer token。

## Tasks

1. 標註內容驗證與 RLE：三種 payload 的合法／非法案例。
2. 資料表與標註 CRUD API：權限、研究可存取性、稽核、重新載入差異 0。
3. 評分與摘要。
4. CSV 自動分類標註：依病歷號、依影像編號、未對到、衝突、重傳更新。
5. 自動標註：格式規格文件與程式、AutolabelClient（記憶體版、HTTP 版）、送出回存、離線處理、執行紀錄。
6. DICOMweb 授權放行 OHIF 的查詢形式；BulkDataURI 經 Gateway 改寫（技術債：Orthanc `PublicRoot`）。
7. 部署：fake-autolabel、OHIF、APISIX 路由、Keycloak redirect URI。
8. 網頁：標註清單、工作台（工具列、器官窗、快捷鍵、三種標註、評分）、CSV 標註、自動標註頁、建立訓練任務；單元測試與 Playwright。
9. 經 Gateway 驗收（compose）與 S0 smoke 補上情境 3；記錄結果。

## Test List

| TC | 單元測試（`platform/api/tests/labeling`、`platform/web`） | 經 Gateway 驗收／瀏覽器 |
|---|---|---|
| TC-B02-01 檢視工具列 | 視窗運算、旋轉座標轉換（vitest） | Playwright：10 研究 × 排列、旋轉、WW/WC 各 3 次；器官窗 ≥3 |
| TC-B02-02 快捷鍵 | — | Playwright：5 組快捷鍵各 1 次 |
| TC-B02-03 評分 | `test_tc_b02_03_*` | Playwright：評分 10 筆後重新載入 |
| TC-B02-04 三種標註 | `test_tc_b02_04_*`（各 10 筆，重新載入差異 0） | Playwright：分類、分割、偵測各 10 筆 |
| TC-B02-05 CSV 分類 | `test_tc_b02_05_*` | `test_tc_b02.py`（10 筆對齊錯誤 0） |
| TC-B02-06 標註後訓練 | — | Playwright：建立訓練任務 3 次 |
| TC-B02-07 無權限 | `test_tc_b02_07_*` | `test_tc_b02.py`（vw01 5 次，成功 0） |
| TC-B03-01 送出 | `test_tc_b03_01_*` | `test_tc_b03.py`（5 次） |
| TC-B03-02 回存時間 | — | `test_tc_b03.py` 量測並記錄（30 秒判準在甲方驗） |
| TC-B03-03 開啟編輯 | `test_tc_b03_03_*` | Playwright |
| TC-B03-04 格式規格 | `test_tc_b03_04_*`（文件、程式、服務回應三方比對） | — |
| TC-B03-05 工具離線 | `test_tc_b03_05_*` | `test_tc_b03.py`（停止服務後送出） |

## 只能在甲方驗證

- TC-B03-02 的 30 秒：需在甲方環境以實際自動標註工具與實際影像大小量測。
- 真實自動標註工具（MONAI Label 或甲方指定者）的模型與 GPU 推論；本機只驗介面與流程。
- 實際臨床影像（多幀、壓縮傳輸語法、大矩陣）在工作台與 OHIF 的顯示效能。

## 結果（2026-09-29）

| 範圍 | 指令 | 結果 |
|---|---|---|
| 平台 API 單元（含標註 106、DICOMweb 授權新增 9） | `cd platform/api && uv run pytest -q` | 472 passed, 2 skipped |
| 網頁單元 | `cd platform/web && npx vitest run` | 189 passed（標註 37） |
| Playwright（Chromium，模擬 API） | `npx playwright test --project=chromium` | 30 passed（標註 10） |
| S0 smoke | `cd platform/api && uv run pytest ../smoke/s0` | 10 passed, 7 skipped（情境 3 已換成真步驟） |
| 經 Gateway 驗收（compose ＋ `compose.labeling.yaml`） | `COMPOSE_PROJECT=… uv run pytest -q` | 45 passed, 15 skipped（新增 11；略過的是 kind 叢集測試） |
| 假服務 | `cd platform/fakes && uv run pytest` | 45 passed |

- TC-B03-02 在開發機量到送出到可讀取 0.21 秒（假服務 9 毫秒），只證明流程；30 秒判準在甲方量。
- TC-B03-04 的測試抓到規格漏寫 `/info/` 的 `description` 欄位，已補進文件與程式。
- 以 HTTP 驗過 OHIF 實際送出的 DICOMweb 請求形式（研究查詢、序列 includefield、metadata、bulk data）經 9081 埠可用，且清單外、非成員、列出全部研究都被擋。
  **未驗證**：真實瀏覽器中 OHIF 經 Keycloak 登入後畫出影像。原因是 Keycloak 的 `KC_HOSTNAME` 固定為 `localhost:8080`，
  並行的第二套堆疊（18080）無法完成 OHIF 的登入導向；請在預設埠的堆疊手動開一次 `http://localhost:9081/viewer?StudyInstanceUIDs=<uid>&project=1`。
- 工作台的畫面測試用 MSW 模擬 API 與合成影像；與真實堆疊的串接以經 Gateway 驗收（API 與 DICOMweb）涵蓋，未另寫真環境的 Playwright。

### 裁定

- 自動標註工具採 MONAI Label 介面（`docs/TODO.md` 第 2 節：「MONAI Label 是否算 Clara 等級或同等」待甲方確認）；平台只依賴 `AutolabelClient` 介面，換工具只改 `AUTOLABEL_URL`。
- 自動標註輸入輸出格式 1.0 版以 2D 單張影像為範圍（`docs/specs/autolabel-io-format.md`），待甲方開工前書面確認；3D 另訂。
- 標註存在平台資料庫，不寫回 Orthanc；DICOMweb 維持唯讀。
- 標註以 UID 指向影像、不設外鍵；可否存取每次以影像索引與 Accession 清單重新判斷，所以清單縮小後清單外研究的標註看不到也改不了。
- 評分（1–5）不算內容修改，不增加 version；分類標註可掛在研究或單張影像，分割與偵測必須指定影像。
- CSV 同一鍵出現不同診斷視為衝突、整個鍵不寫入；重傳時更新既有的 CSV 標註，不重複建立，也不動手動標註。
- 自動標註失敗（離線、逾時、5xx、4xx、格式不符）不留標註與執行紀錄，只寫一筆 `result=failure` 的 dataset 稽核；偵測沒有框時不建立標註。
- 工作台是平台自己的頁面（Canvas，只支援未壓縮單色影像），OHIF 做為進階檢視器另開分頁；兩者用同一個 DICOMweb 入口。
- 器官窗 5 組（軟組織、肺、骨、腦、腹部），快捷鍵 9 組（見工作台「快捷鍵」表）。
- 「標註後直接訓練」目前呼叫 WP4 的 `POST /api/projects/{pid}/jobs`（`kind: training`），訓練型態與參數一併送出但 WP4 API 尚未使用；WP5b 接手後只改 `platform/web/src/pages/labeling/api.ts` 的 `createTrainingJob`。
- DICOMweb 授權放寬兩處以配合 OHIF：查詢字串允許 `%2C`（只解碼逗號，研究 UID 仍不可多值）、允許 `fuzzymatching=false`。

### 共用檔案異動（合併時注意）

`platform/api/app/main.py`（1 個 import、1 個 include_router）、`platform/api/app/authz.py`、`platform/deploy/local/apisix/apisix.yaml`（dicomweb 路由加 CORS 與 BulkDataURI 改寫，結尾加 WP5a 區塊）、
`platform/deploy/local/keycloak/realm-ai-platform.json`（新增 `ai-platform-ohif`）、`platform/deploy/local/README.md`、
`platform/web/src/App.tsx`、`access/entries.ts`（影像標註、自動影像分類標註改為非骨架）、`mocks/handlers.ts`、`theme/tokens.css`（viewer 與標註色 token）、`env.d.ts`、`platform/smoke/s0/test_scenarios.py`。
