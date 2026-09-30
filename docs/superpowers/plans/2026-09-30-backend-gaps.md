# 後端缺口（backend-gaps）Implementation Plan

> **For agentic workers:** 依 superpowers:test-driven-development 逐項執行：先寫會失敗的測試，再修；每項一個 commit。

**Goal:** 補上 6 個已知缺口：刪專案時清 FHIR 租戶與停止叢集工作、欄位隱藏存在伺服器、影像研究清單分頁、
專案管理頁的 GPU 群組改成下拉選單、MinIO 映像以 digest 釘版本。

**Scope:** `platform/api`（project_cleanup、fhir client、tabular_api、imaging）、`platform/web`（表格預覽、研究清單、
專案管理頁）、`platform/deploy/local/compose.yaml`、`platform/compliance` 測試、`platform/acceptance`。
不動 `docs/TODO.md`、路線圖、根目錄 README；不動 `app/training/` 的推論程式（另一個工作者負責）。

## Global Constraints

- 錯誤訊息繁體中文；狀態碼 401／403／404／409／422。
- 稽核與業務變更同一個交易；稽核類別固定 8 類，不新增。
- 介面保留記憶體版（InMemoryFhir、FakeJobBackend），單元測試不需要 Docker。
- 既有測試全部維持通過（平台 API 單元、網頁 Vitest）。

## Items

| # | 問題 | 修正後的行為 | 證明的測試 |
|---|---|---|---|
| 1 | 刪專案後 HAPI 內該租戶的 FHIR 資料還在 | 刪專案時（FHIR 有設定才）寫 1 筆 `fhir_tenant` 待清理工作；commit 後由 `FhirClient.delete_tenant(pid)` 清掉：刪除租戶內所有資源 → `$expunge` 刪掉歷史版本 → 刪除 HAPI 分割區。失敗留在清單重試 | `tests/test_project_cleanup_gaps.py::test_delete_project_removes_fhir_tenant*`、`tests/fhir/test_client_delete_tenant.py`；真 HAPI：`acceptance/test_backend_gaps.py::test_project_delete_removes_fhir_tenant` |
| 2 | 刪專案後叢集中排隊／執行中的工作不會停 | 刪專案的同一個交易，對每筆 queued／running 的工作（含訓練）寫 1 筆 `cluster_job` 待清理工作（ref＝Kubernetes Job 名稱）；commit 後經 `JobBackend.cancel` 取消，失敗重試 | `tests/test_project_cleanup_gaps.py::test_delete_project_cancels_*` |
| 3 | 欄位隱藏只存在瀏覽器（TC-B04-02 換電腦就不見） | 新 API `GET／PUT /api/projects/{pid}/tabular/datasets/{id}/column-view` `{hidden: [...]}`，存在資料表 `tabular_column_views`；預覽頁改用這個 API | `tests/test_tabular_column_view.py`、`web/tests/unit/tabular-column-view.test.tsx` |
| 4 | 影像研究清單沒有分頁 | `GET /imaging/studies` 新增選填 `limit`（1–500）、`offset`：**有帶 `limit` 才分頁**，回 `{items, total, offset, limit}`；不帶時照舊回完整陣列（既有呼叫端不變）。研究清單頁每頁 50 筆，上一頁／下一頁 | `tests/test_imaging_studies_paging.py`、`web/tests/unit/imaging-studies.test.tsx`（分頁案例） |
| 5 | 專案管理頁的 GPU 群組是自由輸入 | 改成下拉選單（「不綁定」＋ `/api/admin/gpu-groups` 的群組）；排程服務未設定（503）時選單只有「不綁定」與目前值並提示 | `web/tests/unit/admin-projects.test.tsx`（下拉選單案例） |
| 6 | MinIO 映像沒有釘版本 | `cgr.dev/chainguard/minio:latest@sha256:71674988…`（本機已拉的映像）；合規檢查的「未釘版本」警告因此歸零 | `platform/compliance/tests/test_repo_images.py::test_deploy_images_are_all_pinned` |

## 設計裁定

### 第 1 項：FHIR 租戶清理

- 租戶＝專案（WP6 計畫），HAPI 分割區編號＝專案編號。
- 清理步驟（`HttpFhir.delete_tenant`）：
  1. 從 `/{pid}/metadata` 取得資源型別，逐型別 `_summary=count` 找出有資料的型別（不用系統層 `_history`：
     實測 HAPI 8.12 的系統層歷史筆數有快取，會回 0）。
  2. 分頁取出資源編號，以 `Bundle(type=transaction)` 的 `DELETE` 刪除，每批 500 筆；被參照的型別（Patient、
     Encounter 等）排在後面。HAPI 在 Transaction 結束時才檢查參照，同一批內互相參照沒問題；跨批被擋（409）的留到下一輪。
  3. `POST /{pid}/$expunge`（`expungeDeletedResources`、`expungePreviousVersions`）：實體刪除，只影響該分割區（實測）。
  4. `$partition-management-delete-partition` 刪除分割區。
  - 分割區不存在（專案從未用過 FHIR）視為已清空。
- 只有 FHIR 有設定（`app.state.fhir` 或 `FHIR_URL`）時才寫這筆工作：沒有 FHIR 伺服器就沒有資料可清；
  有設定但連不上時工作留著重試。
- 專案編號被重用（只有 SQLite 會）時放棄清理，與物件儲存相同。
- 稽核：沿用 `project.data_cleanup`（dataset 類），detail 在有 FHIR 工作時多 `fhir_deleted`（刪除的資源數）。
  沒有 FHIR 工作的專案 detail 與原本相同。

### 第 2 項：取消叢集工作

- 訓練（TrainingRun）都經由排程工作（Job）送進叢集，所以只看 `jobs` 表：status 為 queued／running 的工作各寫 1 筆。
  Job 資料列本身照舊由外鍵 CASCADE 刪除。
- `JobBackend.cancel` 對不存在的工作視為成功（Kubernetes 404、記憶體版原本就是）。排程服務未設定時工作留著重試。
- 稽核：detail 多 `jobs_cancelled`（有這種工作時才出現）。不另寫 `job.cancel`：工作列已隨專案刪除，
  取消是專案刪除的一部分，由 `project.delete` 與 `project.data_cleanup` 追蹤。
- 部署中的推論服務（Deployment）不是 Kubernetes Job，不在本項範圍。

### 第 3 項：欄位顯示設定——每位使用者、每個資料集各一份

- **選擇「每位使用者」**：隱藏欄位是個人的檢視偏好（TC-B04-02：同一個人換電腦後狀態一致）。
  若是整個資料集共用，一位成員隱藏欄位會改掉其他成員（包括正在分析的人）看到的畫面，還需要另外定義誰能改。
  原本 localStorage 的鍵也是「帳號＋專案＋資料集」，行為一致。
- 權限：有資料集讀取權（Project）就能讀寫自己的設定；只能存該資料集存在的欄位名稱（否則 422）。
- 以帳號名稱為鍵（與 `created_by` 等欄位相同），不設帳號外鍵。刪資料集、刪專案時一併刪除。
- 不寫稽核：個人檢視偏好，不改變任何資料（8 類稽核都不適用）。**需確認。**
- 網頁：第一次開啟時若伺服器沒有設定、瀏覽器有舊的 localStorage 值，把它搬到伺服器後清掉本機值。

### 第 4 項：研究清單分頁

- 回應形狀只在帶 `limit` 時改變，既有呼叫端（網頁其他處、驗收、S0 smoke、標註支援程式）不需要改。
- 排序維持 `study_date, id`；`total` 是套用篩選與 Accession 清單後的總數。
- `limit` 範圍 1–500，`offset` ≥ 0，超出範圍 422。

## 需使用者確認

- 第 3 項：每位使用者一份，不寫稽核。
- 第 4 項：以「帶 limit 才回分頁物件」保持相容，而不是改掉所有呼叫端。
- 第 2 項：不另寫逐筆 `job.cancel` 稽核。

## 結果（2026-09-30）

| 項目 | 指令 | 結果 |
|---|---|---|
| 平台 API 單元（全套） | `cd platform/api && uv run pytest` | 1000 passed, 5 skipped（原 972；新增 28） |
| 網頁單元（合併 integration/wp5-8 後） | `cd platform/web && npx vitest run` | 367 passed（27 檔） |
| Playwright（模擬 API，Chromium＋Edge，合併後） | `PW_PORT=5787 npx playwright test --workers=2` | 154 passed。合併前第一次跑 2 failed：`imaging.spec.ts` TC-B01-09 等「共 6 個研究」整句，狀態列多了「，第 1–6 個」屬預期變更，已改測試 |
| 合規 | `cd platform/compliance && uv run pytest` | 48 passed（含新增 2） |
| kind 叢集（第 2 項） | `cd platform/api && uv run pytest ../acceptance/test_backend_gaps_kind.py -m kind` | 1 passed；修正前（stash 掉第 2 項）1 failed |
| 經 Gateway（compose `ai-gaps`＋compose.fhir.yaml，真 HAPI） | `COMPOSE_PROJECT=ai-gaps uv run pytest test_backend_gaps.py test_tc_b04.py test_tc_b01.py::test_tc_b01_09_* test_tech_debt.py` | 第一次 11 passed, 1 failed；修正後重跑 `test_tech_debt.py` 2 passed（失敗原因：`test_tech_debt` 的清理稽核 detail 在有 FHIR 的堆疊多了 `fhir_deleted: 0`，測試改為兩種都接受） |

- 第 1 項在真 HAPI 上：刪專案後 `hfj_resource` 該分割區 0 列（含歷史版本）、`hfj_partition` 沒有該編號，另一個租戶的資料還在；
  稽核 `project.data_cleanup` = success，`fhir_deleted: 3`。種子重設（有 FHIR）後待清理清單 0。
- 實測（HAPI 8.12，本機 H2 容器）：`/{pid}/metadata` 不檢查分割區是否存在；系統層 `_history` 的總數不可靠；
  `/{pid}/$expunge` 只影響該分割區；刪除後同編號可重建分割區。跨批參照（每批 2 筆）在真 HAPI 上也能刪完。
- 第 6 項：compose 以 digest 啟動 MinIO 正常（使用本機已有的映像，未重新下載）。
  **`docs/delivery/第三方授權清單.md` 與 `licence-list/` 是產生的檔案，仍寫「未釘版本」，需以合規工具重新產生。**
