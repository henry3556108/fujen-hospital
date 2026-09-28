# WP3 結構式資料 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. 每個 Task 嚴格 TDD：先寫測試、看它因預期原因失敗、最小實作、看它通過、跑整個 `platform/api` 測試，再 commit。

**Goal:** 把已完成的結構式資料函式庫（`platform/libs/tabular`）經平台 API 開放：CSV＋結構定義上傳驗證、資料集管理、資料探索、前處理、Target／Feature 設定、四種醫學統計。

**Architecture:** 新套件 `platform/api/app/tabular_api/`（models / service / router），掛在 `/api/projects/{project_id}/tabular`。權限一律用 `require_project_permission`；稽核用 `app.audit.record`，與資料庫變更同一交易。原始檔與乾淨檔（只含通過驗證的列）存在 `request.app.state.store`，key 為 `projects/{pid}/tabular/{dataset_id}/{original.csv,clean.csv,report.json}`。探索與統計時以資料集的結構定義重新載入乾淨檔（型別與上傳時一致），同一 app 內以小型 LRU 快取（8 筆）避免重複解析。

**Tech Stack:** 既有 FastAPI／SQLAlchemy 2／pytest；`tabular`（pandas、scikit-learn、statsmodels、lifelines）以 uv 路徑相依（editable）加入；函式庫改用 hatchling 建置。

**Spec:** `docs/test-cases/acceptance-test-cases.md` 的 TC-B01-10、TC-B04-01～08；`platform/libs/tabular/README.md`。

## Global Constraints（沿用 WP1a，另加）

- 只在 `app/main.py` 加一行 import、一行 `include_router`；不改其他既有模組。
- 資料表名一律 `tabular_` 開頭，避免與 WP2／WP4 衝突。
- `TabularError` → 422，body 為 `{"detail": err.to_dict()}`（在本路由的 `route_class` 內轉換，不動 `main.py` 的例外處理）。
- 上傳大小上限預設 50 MB：`app.state.tabular_max_upload_bytes`（測試用）> 環境變數 `TABULAR_MAX_UPLOAD_MB` > 50；超過回 413「檔案超過上限 N MB」。
- 測試資料由 `platform/tools/synth` 產生（`uv run python -m synth tabular --out <tmp>`，session fixture），不複製其他分支檔案。

## File Structure

```
platform/libs/tabular/pyproject.toml      加 [build-system]（hatchling）
platform/api/pyproject.toml, uv.lock      加 tabular 路徑相依
platform/api/app/main.py                  +1 import、+1 include_router
platform/api/app/tabular_api/
  __init__.py
  models.py      TabularDataset、TabularTargetFeature（import app.models.Base）
  service.py     上傳、查詢、刪除、載入 DataFrame（快取）、設定存取、稽核
  router.py      /api/projects/{project_id}/tabular/*
platform/api/tests/
  tabular_helpers.py                       synth 產生、成員設定、上傳 helper
  test_tabular_upload.py  test_tabular_datasets.py  test_tabular_explore.py
  test_tabular_preprocess.py  test_tabular_target_feature.py  test_tabular_stats.py
platform/api/Dockerfile                    build context 改為 platform/，安裝 libs/tabular
platform/api/Dockerfile.dockerignore       只送入 api 與 libs/tabular
platform/deploy/local/compose.yaml         只改 api.build
platform/acceptance/test_tc_b01_10.py, test_tc_b04.py
```

## Endpoints（prefix `/api/projects/{project_id}/tabular`）

| Method | Path | 權限 | 稽核 | 說明 |
|---|---|---|---|---|
| POST | `/datasets` | project | dataset / `tabular_upload`（含列數；檔案層級錯誤記 `result=rejected`） | multipart：`file`（CSV）、`schema`（JSON 字串）、`name`（選填）。201 `{dataset, report}` |
| GET | `/datasets` | project | – | 本專案資料集清單 |
| GET | `/datasets/{id}` | project | – | 資料集＋`columns`（`column_info`，給顯示／隱藏 UI） |
| GET | `/datasets/{id}/report` | project | – | 上傳時的驗證報告 |
| DELETE | `/datasets/{id}` | project | dataset / `tabular_delete`（含列數） | 204；刪 DB 列、設定與物件 |
| GET | `/datasets/{id}/describe` | project | – | `explore.describe` |
| GET | `/datasets/{id}/histogram?column&bins` | project | – | |
| GET | `/datasets/{id}/value-counts?column&limit` | project | – | |
| GET | `/datasets/{id}/preview?offset&limit&columns=…` | project | – | `columns` 可重複，代表可見欄位 |
| GET | `/datasets/{id}/correlation?columns=…&method` | project | – | |
| GET | `/datasets/{id}/scatter?x&y&limit` | project | – | |
| GET | `/preprocessing/catalogue` | project | – | 66 種方法 |
| POST | `/datasets/{id}/preprocess/preview` | project | – | `{steps, offset, limit}` → `{columns, preview}` |
| PUT | `/datasets/{id}/target-feature` | **training** | training / `target_feature_save`（含列數） | 以套用 steps 後的欄位檢查 target/features；回正規化設定 |
| GET | `/datasets/{id}/target-feature` | project | – | 404 若未設定 |
| POST | `/datasets/{id}/stats/logistic` | project | – | `{target, features, steps?}` |
| POST | `/datasets/{id}/stats/linear` | project | – | `{target, features, steps?}` |
| POST | `/datasets/{id}/stats/kaplan-meier` | project | – | `{duration, event, group?, steps?}` |
| POST | `/datasets/{id}/stats/cox` | project | – | `{duration, event, covariates, steps?}` |

錯誤：401 未登入、403 無權限（沿用 `require_project_permission`）、404 資料集不存在或不屬於此專案、409 同專案重名、413 超過大小、422 `TabularError`。

## Tasks

- [x] **Task 1: 函式庫可安裝、API 加相依** — 函式庫加 hatchling，函式庫 199 測試仍過；`uv add --editable ../libs/tabular`；測試：`test_tabular_library_importable`。
- [x] **Task 2: 上傳與驗證（TC-B01-10）** — models、upload、`TabularError`→422、413、稽核。
- [x] **Task 3: 資料集清單／查詢／刪除／報告** — 跨專案 404、刪除清物件、稽核。
- [x] **Task 4: 探索（TC-B04-01、02、05、08）**
- [x] **Task 5: 前處理清單與預覽（TC-B04-04、06）**
- [x] **Task 6: Target／Feature 設定（TC-B04-03）** — training 權限、稽核。
- [x] **Task 7: 四種統計（TC-B04-07、08）**
- [x] **Task 8: Docker 映像含函式庫** — `docker compose build api`。
- [x] **Task 9: 經 Gateway 的驗收測試** — `platform/acceptance/test_tc_b01_10.py`、`test_tc_b04.py`。

## 測試對照

| 驗收案例 | API 單元測試（platform/api/tests） | 經 Gateway（platform/acceptance） |
|---|---|---|
| TC-B01-10 | `test_tc_b01_10_three_clean_csvs_all_rows_accepted`、`test_tc_b01_10_bad_csv_rejects_exactly_the_broken_rows`、`test_tc_b01_10_clean_and_original_stored` | `test_tc_b01_10_csv_upload_validation` |
| TC-B04-01 | `test_tc_b04_01_describe_matches_pandas`、`test_tc_b04_01_histogram_and_value_counts_match`、`test_tc_b04_01_preview_matches_csv` | `test_tc_b04_01_describe_and_preview` |
| TC-B04-02 | `test_tc_b04_02_preview_only_visible_columns`（API 部分；UI 為 playwright） | – |
| TC-B04-03 | `test_tc_b04_03_target_feature_round_trip_three_times` | `test_tc_b04_03_target_feature_round_trip` |
| TC-B04-04 | `test_tc_b04_04_impute_and_onehot_match_sklearn` | – |
| TC-B04-05 | `test_tc_b04_05_correlation_and_scatter` | `test_tc_b04_05_correlation_and_scatter` |
| TC-B04-06 | `test_tc_b04_06_catalogue_at_least_50_and_matches_library` | `test_tc_b04_06_catalogue` |
| TC-B04-07 | `test_tc_b04_07_logistic_matches_statsmodels`、`…_linear_…`、`…_kaplan_meier_matches_lifelines`、`…_cox_matches_lifelines` | `test_tc_b04_07_four_statistics` |
| TC-B04-08 | `test_tc_b04_08_text_and_empty_columns_give_clear_422` | `test_tc_b04_08_text_column_is_422` |

另有權限、稽核、413、跨專案 404、壞結構定義 422 等測試。

## 經 Gateway 驗收的執行方式

需先以含 WP3 的映像重建並重啟 API（整合者執行；共用環境不要在開發分支上自行重啟）：

```bash
cd platform/deploy/local
docker compose build api && docker compose up -d api
docker compose exec -T api /app/.venv/bin/python -m app.seed      # 若需要重建種子
cd ../../acceptance && uv run pytest -q test_tc_b01_10.py test_tc_b04.py
```

測試會暫時把 pi01（PI）與 vw01（Viewer）加入 `P2-tabular`，結束時移除成員資格與上傳的資料集，可重複執行。映像未更新前，這些案例會因 404 失敗（預期）。

## 需與甲方確認的決定

1. 同專案資料集名稱不可重複（409）；是否要允許同名多版本？
2. 檔案層級錯誤（缺必要欄位、空檔、標題重複）與「全部列都不合格」都回 422、不建立資料集；只要有合格列就建立資料集，被拒的列只出現在報告中。是否需要「有任何錯誤列就整檔拒收」的嚴格模式？
3. 每個資料集只存一份 Target／Feature 設定（覆寫）；是否需要多份具名設定或版本歷史？
4. 上傳與刪除只需 `project` 權限（依任務說明）；是否應改為 `training` 或另設權限？
5. 上傳大小上限 50 MB。
6. 刪除專案時資料集列以資料庫外鍵 `ON DELETE CASCADE` 移除（PostgreSQL），物件儲存中的檔案不會自動清除，需由後續的清理工作處理。
