# M1 驗收劇本發現的監控缺陷與介面問題 Implementation Plan

> **For agentic workers:** 依 superpowers:test-driven-development 逐 Task 執行；每個 Task 一個 commit。
> 分支 `m1-monitoring`（從 `integration/wp5-8` 5b2cf95）。來源：`docs/acceptance-kit/m1/C-02-系統監控.md`（m1-kit-infra）、
> `B-01-數據管理與影像匯入.md`、`B-04-結構式資料與醫學統計.md`（m1-kit-data）的「已知問題」與「本次演練發現的問題」。

**Goal:** TC-C02-01 的覆蓋檢查對平台本身（命名空間 `ai-platform`）也通過；失敗工作的告警每次失敗只寄一次；
「3 類事件、3 條發送規則」在設定上一對一；B-01／B-04 劇本列出的 6 個介面問題修正。

**不做：** 成員頁、Admin 儀表板與稽核畫面、標註群組、API 資料庫角色、工作起訖時間、取消工作對話框、叢集頁版面（m1-gaps 負責）；
`docs/TODO.md`、路線圖、根目錄 README。

## Task 1：平台本身的監控覆蓋（TC-C02-01，嚴重）

**現況：** `uv run python -m compliance monitoring` → `FAIL … 未覆蓋 18`，全是 `ai-platform/*`。Prometheus 沒有平台的抓取工作，
政策檔沒有列入，`default-deny-ingress` 也擋住 `monitoring` 命名空間；`test_tc_c02_01` 只看 3 個命名空間所以沒抓到。

**設計：抓取宣告跟著平台 manifest 走，Prometheus 只有一個通用的服務探索工作。**

- 平台 manifest（`platform/deploy/k8s/base`）在「有 /metrics 的服務」的 Pod 範本上加標準註記
  `prometheus.io/scrape: "true"`、`prometheus.io/port`、`prometheus.io/path`。宣告只寫在這裡一次；kind 的 Prometheus 與甲方自己的
  Prometheus 都用同一個以註記探索的工作（`kubernetes_sd_configs: role: pod`，限命名空間 `ai-platform`，`job` 取 Pod 的 `app` 標籤，
  與 Deployment／StatefulSet 同名，覆蓋檢查照舊以名稱比對）。
- 有 /metrics 的服務：
  | 服務 | 端點 | 需要的改動 |
  |---|---|---|
  | api | `:8000/metrics` | 平台 API 新增 /metrics（prometheus-client：請求數、延遲、行程指標；路徑以路由樣板標示，不含 ID）。Gateway 只轉 `/api/*`，/metrics 不對外 |
  | apisix | `:9091/apisix/prometheus/metrics` | 已有（prometheus 外掛的匯出埠），只加註記與網路政策 |
  | keycloak | `:9000/metrics` | `KC_METRICS_ENABLED=true`（管理埠，已有健康檢查） |
  | minio | `:9000/minio/v2/metrics/cluster` | `MINIO_PROMETHEUS_AUTH_TYPE=public`（只有 monitoring 命名空間連得到） |
- 其餘服務列入政策 `container_metrics_only`，每個寫明原因（postgres、orthanc、hapi、mlflow、clamav、wiki、ohif、web、fhir-worker、inference、
  kind 才有的 fake-llm、autolabel、mailpit、orthanc-pacs）。
- 網路政策：`base/networkpolicy.yaml` 每個被抓取的服務各加一條「monitoring 命名空間 → 該服務的指標埠」。
- 一致性的靜態檢查（`platform/compliance/tests/test_monitoring_config.py`）：兩個 overlay 產生的每個 Deployment／StatefulSet 都恰好是
  「有註記」或「在 container_metrics_only」其中之一；有註記的埠有對應的網路政策；kind 的 Prometheus 設定有註記探索工作；
  政策檔沒有不存在的服務。
- `test_tc_c02_01` 加入 `ai-platform`，期望的抓取工作由政策檔與叢集推得（不再寫死清單）。
- 叢集：只套用監控 manifest（`platform/deploy/kind/monitoring`）。`ai-platform` 的工作負載依指示不改，平台改動要由
  `deploy.sh kind` 部署後才會在叢集生效（最終報告寫清楚哪些已在叢集證明、哪些等部署）。

## Task 2：失敗工作只告警一次

**現況：** `PlatformJobFailed` 的條件是 `kube_job_status_failed > 0`；失敗的 Job 保留 24 小時（`ttlSecondsAfterFinished`），
告警一直觸發，Alertmanager 每 4 小時重寄（job-30、job-31 各收 3 封以上）。

**做法：** 規則改為「最近 15 分鐘內才失敗」：
`kube_job_status_failed{namespace="platform-jobs"} > 0 unless kube_job_status_failed{namespace="platform-jobs"} offset 15m > 0`。
kube-state-metrics 的失敗序列帶 `reason` 標籤、失敗時才出現，所以 offset 15m 沒有值＝剛失敗；15 分鐘後告警自動解除（不寄已解除）。
保留 24 小時 TTL（平台與使用者查紀錄用）。以 promtool 規則單元測試證明：失敗後觸發一次、15 分鐘後解除、舊的失敗不觸發。
叢集上 job-30、job-31 不再觸發，照指示刪除。

## Task 3：3 類事件、3 條發送路由

Alertmanager `route.routes` 依 `category` 標籤分 3 條（`job-failure`、`resource`、`node`），各自 `group_by`、`group_wait`、
`group_interval`、`repeat_interval`，都寄到維運信箱；規則加 `category` 標籤。以 amtool 路由測試證明每類告警走到自己的路由；
`platform/deploy/kind/README.md` 記錄；TC-C02-04 在叢集重跑。

## Task 4：B-01／B-04 介面問題（每項一個 commit）

1. CSV 重複值原因「與第 0 列相同」→ 與表格一致從 1 起算（`tabular.validate` 與網頁模擬）。`rejected[].row` 仍是 0 起算（`bad_rows.json` 對照不變）。
2. 「檔案與配對」makesense 配對對象顯示研究：API `paired_studies`（Accession、Study Description、張數），網頁顯示「ACC0001 CT CHEST…（5 張）」。
3. 「PACS 查詢取像」顯示「回應時間 x.x 秒」：瀏覽器從送出到收到回應計時。
4. 散佈圖顯示「共 n 點」，與表格檢視的筆數一致。
5. 統計表單：排除的欄位只看目前模型（迴歸排除結果欄位，存活分析排除時間與事件欄位）；送出時也不帶被排除的欄位。Vitest 重現劇本的 Linear→Cox。
6. 「目前專案」下拉：視窗取得焦點、下拉取得焦點時重新讀取 /api/me（內容沒變不更新，不影響頁面狀態）。

## 驗證

`platform/api` 單元測試、`platform/libs/tabular`、`platform/compliance`、網頁 typecheck、Vitest（`--maxWorkers=4`）、
Playwright 測試模式（`PW_PORT=6587 --workers=2`）、`platform/api` 下 `uv run pytest -m kind ../acceptance/test_tc_c02.py`。

## 結果（2026-10-03）

- Task 1：平台 manifest 宣告 api、apisix、keycloak、minio 的抓取；其餘 14 個平台服務列入 container_metrics_only；
  靜態檢查 `test_monitoring_config.py`。叢集只套用了監控 manifest（Prometheus 有 `ai-platform-pods` 工作）；
  `ai-platform` 依指示未重新部署，所以叢集上 `compliance monitoring` 為 `FAIL … 抓取目標 5、容器指標 16、未覆蓋 4`
  （api、apisix、keycloak、minio，等 `deploy.sh kind` 部署這個分支後才有抓取目標），`test_tc_c02_01` 同樣失敗。
  keycloak（`KC_METRICS_ENABLED`）、minio（`MINIO_PROMETHEUS_AUTH_TYPE=public`）以同版本映像在 docker 確認 /metrics 回 200。
- Task 2：promtool 規則測試；叢集已套用，job-30、job-31 已刪除。
- Task 3：amtool 路由測試；叢集已套用並 reload Alertmanager；`test_tc_c02_04` 在叢集通過（3 類各 1 封）。
- Task 4：6 項都完成（Vitest／API 測試各一）。
- 追加（協調者指示）：稽核來源 IP。kind 的 Gateway／Keycloak NodePort 改 `externalTrafficPolicy: Local`、`expose.sh` 以主機網路轉送；
  APISIX `real_ip_*` 只信任 `GATEWAY_TRUSTED_PROXY`。叢集上 Service 已改、expose 已重啟，稽核列 `source_ip` 由 172.19.0.4 變為 172.19.0.1；
  `test_k8s_deploy.py` 21 項通過。這項的 commit 被權限檢查擋下，變更留在工作目錄未提交。
- 測試：api 1086 passed／6 skipped；tabular 373；compliance 87；typecheck；Vitest 454；Playwright 180；`test_tc_c02.py` 3 passed／1 failed（TC-C02-01，原因同上）。
