# WP4 排程與監控 Implementation Plan

> **For agentic workers:** 依 superpowers:test-driven-development 逐 Task 執行；每個 Task 一個 commit。

**Goal:** 平台 API 成為唯一的工作提交者：依專案綁定的 GPU 群組把 Kubernetes Job 送進 Kueue 佇列（獨占池 FIFO 一卡一件、共享池時間片併行），提供節點清單、GPU Dashboard、共享排程設定；Mac 上以 kind 多節點＋假 GPU＋Prometheus／Grafana／Alertmanager／Mailpit 驗證 C-01、C-02、A-02 GPU 模式。

**Architecture:** `app/scheduling/` 自成一包：資料表（GPU 群組、工作、共享排程設定）、`JobBackend` 介面（記憶體假實作供單元測試、Kubernetes 實作供 kind／甲方）、狀態機（queued→running→succeeded|failed|cancelled，其餘轉換一律拒絕）、路由。後端由 `app.state.job_backend` 提供；未設定時依環境變數 `JOB_BACKEND=kubernetes` 延遲建立，`main.py` 只加一個 import 與一個 `include_router`。

**Tech Stack:** FastAPI、SQLAlchemy 2、`kubernetes` 官方 Python client；kind v0.33、Kueue v0.19.6（`kueue.x-k8s.io/v1beta2`）、Prometheus v3.15、Alertmanager v0.34、Grafana 13.2、kube-state-metrics v2.19、Mailpit v1.22。

## Global Constraints

- 沿用 WP1a：錯誤訊息繁體中文；401／403／404／409／422；測試名稱帶 TC ID。
- 專案範圍 API 一律 `require_project_permission(Permission.TRAINING)`；提交與取消寫 `AuditCategory.TRAINING` 稽核（與業務變更同交易）。
- GPU 群組與共享排程設定屬管理設定，稽核類別用 `project`（8 類固定，不新增類別）。
- 每個 Job 帶標籤 `platform/project-id`、`platform/job-id`、`platform/training-id`（訓練類工作）、`platform/user`；GPU Dashboard 只讀這些標籤（Mac 上無 DCGM）。
- 不改 `platform/deploy/local/`；叢集資源請求壓低（每個工作 10m CPU／32Mi 記憶體）。

## File Structure

```
platform/api/app/scheduling/
  __init__.py
  models.py        GpuGroup、Job、SharedSchedulingSettings（繼承 app.models.Base）
  states.py        JobStatus 與轉換規則（InvalidTransition）
  backend.py       JobBackend 介面、JobSpec／BackendJob／NodeInfo／Allocation、FakeJobBackend
  kube.py          KubernetesJobBackend、build_job_manifest、job_state（純函式可單測）
  service.py       預設群組初始化、提交、同步狀態、取消、Dashboard 組裝
  router.py        /api/projects/{id}/jobs、/api/admin/gpu-groups、/api/admin/cluster/*
platform/api/tests/scheduling/   conftest.py 與 test_sched_*.py
platform/deploy/kind/
  kind-config.yaml             1 control-plane + cpu-web、cpu-data、gpu-exclusive、gpu-shared
  up.sh / down.sh              建立（含假 GPU、Kueue、佇列、監控）／刪除
  fake-gpus.sh                 以 node status patch 宣告 nvidia.com/gpu
  add-node.sh                  TC-C01-07：新增並加標籤一個 worker
  kueue/queues.yaml            ResourceFlavor、ClusterQueue、LocalQueue
  workloads/web-echo.yaml      cpu-web 節點上的網頁服務（TC-C01-06）
  monitoring/*.yaml            Prometheus、Alertmanager、Grafana、kube-state-metrics、Mailpit、告警規則
  README.md                    繁體中文操作說明
platform/acceptance/
  kind_harness.py              叢集偵測、同程序平台 API（接 Kubernetes 後端）、輪詢工具
  test_tc_a02_gpu.py  test_tc_c01.py  test_tc_c02.py
```

## Cluster Topology（kind，名稱 `ai-platform`）

| 節點 | 標籤 `platform/pool` | 假 GPU（`nvidia.com/gpu`） | 用途 |
|---|---|---|---|
| control-plane | — | — | API server、NodePort 對外 |
| worker | `cpu-web` | — | 網頁服務、監控堆疊 |
| worker2 | `cpu-data` | — | 資料清洗工作 |
| worker3 | `gpu-exclusive` | 2（`platform/gpu-physical=2`） | 影像訓練、LLM serving，一件一卡 |
| worker4 | `gpu-shared` | 4 = 1 張 × 時間片 4 份（`platform/gpu-physical=1`） | 推論、自動標註、結構式訓練、小模型 |

Kueue：每個池一個 ResourceFlavor（nodeLabels 對應池）、一個 ClusterQueue（`StrictFIFO`）、namespace `platform-jobs` 內同名 LocalQueue：`gpu-exclusive`（gpu 2）、`gpu-shared`（gpu = 時間片份數）、`cpu-data`。

## API

| 方法與路徑 | 權限 | 說明 |
|---|---|---|
| POST `/api/projects/{pid}/jobs` | training | 送假工作 `{kind: training｜data-cleaning, duration_seconds, fail, memory_mb}`；訓練走專案綁定群組的佇列 |
| GET `/api/projects/{pid}/jobs` | training | 列出（先同步狀態） |
| GET `/api/projects/{pid}/jobs/{jid}` | training | 單筆（先同步狀態） |
| POST `/api/projects/{pid}/jobs/{jid}/cancel` | training | 排隊中或執行中才可取消，否則 409 |
| GET／POST `/api/admin/gpu-groups` | Admin | 列出／建立 `{name, pool, gpu_count, mode}` |
| GET／PATCH／DELETE `/api/admin/gpu-groups/{name}` | Admin | 仍有專案綁定時不可刪（409） |
| GET `/api/admin/cluster/nodes` | Admin | 節點、池、Ready、GPU 容量／可分配 |
| GET `/api/admin/cluster/gpu-dashboard` | Admin | 每列：node、gpu_index、slot、project_id、job_id、training_id、user |
| GET／PUT `/api/admin/cluster/shared-scheduling` | Admin | `{time_slice_replicas, job_timeout_minutes}` |

## Tasks

1. 狀態機與資料表：合法／非法轉換、跳躍同步（queued→succeeded 經 running）。
2. FakeJobBackend：獨占 FIFO 一卡一件、共享池併行上限 = 時間片份數、失敗與取消釋放資源、節點與配置列。
3. GPU 群組管理 API＋預設群組（首次使用時建立 `gpu-exclusive` 2 張、`gpu-shared` 1 張）。
4. 工作 API：權限、稽核、綁定群組→佇列、狀態同步、取消。
5. 叢集管理 API：節點、Dashboard、共享排程設定（變更同步給後端）。
6. KubernetesJobBackend：manifest（Kueue 標籤、nodeSelector、GPU 請求、記憶體配置、失敗）、狀態對應、節點與 GPU 配置（以標籤推得）、同佇列提交間隔 ≥1 秒（Kueue 以秒級建立時間排序，避免同秒平手亂序）。
7. kind 部署：叢集、假 GPU、Kueue、佇列、web-echo。
8. 監控：Prometheus（抓 kube-state-metrics、kubelet／cAdvisor、Kueue、Alertmanager、Grafana、自身）、3 條告警規則、Alertmanager 重複抑制、Grafana 儀表板、Mailpit。
9. 叢集整合測試並記錄結果；刪除叢集。

## Test List

| TC | 單元測試（FakeJobBackend） | 叢集測試（kind） |
|---|---|---|
| TC-A02-05 獨占 1 件 | `test_tc_a02_05_*` | `test_tc_a02_05_exclusive_single_job` |
| TC-A02-06 共享 3 件 | `test_tc_a02_06_*` | `test_tc_a02_06_shared_three_jobs` |
| TC-A02-07 設定重新載入 | `test_tc_a02_07_*`（API 層；頁面 playwright 待前端） | — |
| TC-C01-01 節點納管 | `test_tc_c01_01_*` | 比對 `kubectl get nodes` |
| TC-C01-02 GPU 群組 | `test_tc_c01_02_*` | 檔案型 SQLite，重建 app 後一致 |
| TC-C01-03 專案綁定 | `test_tc_c01_03_*` | Job 標籤與 Kueue Workload 的佇列 |
| TC-C01-04 Dashboard | `test_tc_c01_04_*` | 3 件執行中工作比對 |
| TC-C01-05 佇列順序 | `test_tc_c01_05_*` | 獨占池 3 件，依 Workload 進場時間 |
| TC-C01-06 負載平衡 | — | web-echo 5 次、資料清洗 5 件 |
| TC-C01-07 擴充 | — | `add-node.sh` 後平台清單出現 |
| TC-C01-08 取消與失敗 | `test_tc_c01_08_*` | 取消排隊中＋1 件失敗，下一件照順序 |
| TC-C02-01 監控目標 | — | Prometheus 目標 vs 已部署服務 |
| TC-C02-02 5 類指標 | — | 節點／Pod／CPU／記憶體／GPU（配置量）抽查 3 次 |
| TC-C02-03 儀表板 | — | Grafana API：2 種面板、改更新頻率後重讀（playwright 版待前端） |
| TC-C02-04 告警 | — | 3 類事件、Mailpit 各 1 封、抑制期間重複 0 |

## 只能在甲方 GPU 上驗證

- 真實 GPU 偵測與驅動（TC-C01-09、TC-A01-03）；NVIDIA device plugin 與 time-slicing ConfigMap。
- GPU 使用率、顯存、溫度（DCGM exporter）；TC-C02-02 的 GPU 類。
- Dashboard 的 GPU index：Mac 上依開始時間推算，甲方以 device plugin／DCGM 的 pod→GPU 對應為準。
- 獨占卡上「真的沒有其他行程」（`nvidia-smi`）；時間片實際效能。
- 所有時間與數量指標（Mac* 案例）需在甲方重跑。
