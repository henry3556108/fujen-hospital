# kind 多節點叢集（WP4 排程與監控，Mac 開發機）

在 Mac 上模擬甲方的 GPU／CPU 叢集：多節點、假 GPU、Kueue 佇列、Prometheus／Grafana／Alertmanager、Mailpit 收告警信。
正式環境（甲方）同樣是 Kubernetes + Kueue，差別只在 GPU 是真的（NVIDIA device plugin、DCGM）。

## 需要

- Docker Desktop（VM 記憶體 8 GB 即可；整個叢集含監控約 2.5–3 GB）
- `brew install kind`（v0.33）、`kubectl`
- Docker 憑證輔助程式有問題時，先設定：
  ```bash
  export DOCKER_CONFIG=<暫存目錄>/docker-anon DOCKER_HOST=unix://$HOME/.docker/run/docker.sock
  ```

## 使用

```bash
./up.sh      # 建立叢集、假 GPU、Kueue、佇列、web-echo、監控（可重複執行）
./down.sh    # 刪除叢集（kind delete cluster --name ai-platform）
```

`kind create cluster` 會把 kubectl 目前的 context 切到 `kind-ai-platform`；刪除叢集時會一併移除。

| 服務 | 位址 |
|---|---|
| Prometheus | http://127.0.0.1:39090 |
| Alertmanager | http://127.0.0.1:39093 |
| Grafana | http://127.0.0.1:33000（帳號 admin，開發用密碼見 `monitoring/grafana.yaml`） |
| Mailpit | http://127.0.0.1:38025 |

## 拓撲

| 節點 | `platform/pool` | 假 GPU | 用途 |
|---|---|---|---|
| ai-platform-control-plane | — | — | API server；監控 NodePort 對外 |
| ai-platform-worker | `cpu-web` | — | 網頁服務（web-echo）、監控堆疊 |
| ai-platform-worker2 | `cpu-data` | — | 資料清洗工作、結構式模型的批次推論 |
| ai-platform-worker3 | `gpu-exclusive` | 2 | 獨占：一件工作一張卡，照順序排隊（影像訓練、LLM serving） |
| ai-platform-worker4 | `gpu-shared` | 4 份 = 1 張 × 時間片 4 | 共享：推論、自動標註、結構式訓練、小模型 |

- **假 GPU**：`fake-gpus.sh` 以 node status patch 宣告 `nvidia.com/gpu`，並替 GPU 節點加上 `nvidia.com/gpu=present:NoSchedule` taint（只有 GPU 工作會排上去）。
  共享池的份數等同 NVIDIA time-slicing 的 `replicas`；平台的「共享排程設定」改份數時會同步改節點宣告與 Kueue 配額。
- **Kueue v0.19.6**（`kueue/queues.yaml`）：每個池一個 ResourceFlavor、ClusterQueue（`StrictFIFO`）、`platform-jobs` 內同名 LocalQueue。
- **工作**：只有平台 API 會送工作。每個 Job 帶 `kueue.x-k8s.io/queue-name`、`platform/project-id`、`platform/job-id`、`platform/training-id`（訓練類）、`platform/user`；
  GPU Dashboard 與 Grafana 只讀這些標籤（Mac 上沒有 DCGM）。假工作用 `busybox:1.36`：配置一點記憶體、睡指定秒數、依需要以 1 結束。

## 擴充節點（TC-C01-07）

```bash
./add-node.sh ai-platform-extra-1 cpu-data     # 啟動節點容器、kubeadm join、加標籤、等 Ready
./remove-node.sh ai-platform-extra-1
```

kind 不支援擴充既有叢集，所以 `add-node.sh` 用與 kind worker 相同的容器參數啟動節點映像再 `kubeadm join`。平台節點清單直接讀 Kubernetes，不需要另外設定。

## 監控與告警

- Prometheus 抓：自身、Alertmanager、Grafana、kube-state-metrics、Kueue controller、每個節點的 kubelet 與 cAdvisor，
  以及平台（`ai-platform`）有 `/metrics` 的服務：api、apisix、keycloak、minio（工作 `ai-platform-pods`，依 Pod 註記探索，見 `platform/deploy/k8s/README.md`「監控」）。
  抓取工作名稱與 Deployment／StatefulSet 同名，方便比對覆蓋率。沒有 `/metrics` 的服務（Mailpit、web-echo、平台的 postgres、orthanc 等）
  以 cAdvisor 的容器指標覆蓋，清單與原因在 `platform/compliance/policy/monitoring.yaml`。覆蓋檢查：`cd platform/compliance && uv run python -m compliance monitoring`。
- 告警規則（`monitoring/prometheus.yaml`）：

  | 規則 | 條件 |
  |---|---|
  | `PlatformJobFailed` | `platform-jobs` 內有 Job 失敗 |
  | `NodeNotReady` | 節點 Ready≠true 持續 10 秒（controller-manager 的 node-monitor-grace-period 設為 20 秒） |
  | `HighPodCpu` | 單一 Pod CPU 使用超過 0.8 核持續 20 秒 |

- 重複抑制（`monitoring/alertmanager.yaml`）：同一告警群組只寄一次，`repeat_interval` 4 小時內不重寄、不寄「已解除」；
  節點未就緒時抑制同節點上的 warning。`HighPodCpu` 另設 `keep_firing_for: 5m`、`NodeNotReady` 設 1 分鐘：條件短暫低於門檻再回來
  （例如 CPU 在 0.8 核上下抖動）不會被 Alertmanager 當成新事件重寄。反過來說，同一節點在這段時間內再次失聯也算同一件事，不會再寄。
- Grafana 預設儀表板「平台叢集總覽」：各池 CPU、假 GPU 已配置／可用份數、執行中 GPU 工作（依 Job 標籤）。

## 叢集測試

在 `platform/api` 下用平台 API 的虛擬環境執行（叢集不存在時自動略過）：

```bash
cd platform/api
uv run pytest -m kind ../acceptance/test_tc_a02_gpu.py ../acceptance/test_tc_c01.py ../acceptance/test_tc_c02.py
```

測試在同一個程序裡啟動平台 API（SQLite、測試用簽章金鑰），後端接 `KubernetesJobBackend`，經 API 送工作、查狀態、看 Dashboard。

## 與 compose 堆疊的串接

compose 的 `api` 容器預設沒有連到叢集，工作 API 會回 503「排程服務尚未設定」。叢集與 compose 堆疊都起來後：

```bash
./connect-compose.sh   # 產生 ../local/kubeconfig.kind，以 compose.kind.yaml 重啟 api，並列出 api 看到的節點
```

做的事：`kind get kubeconfig --internal`（位址 `ai-platform-control-plane:6443`）寫到 `deploy/local/kubeconfig.kind`（已在 .gitignore）；
`deploy/local/compose.kind.yaml` 讓 `api` 加入 `kind` Docker 網路、唯讀掛載 kubeconfig，並設定
`JOB_BACKEND=kubernetes`、`KUBECONFIG=/etc/platform/kubeconfig.kind`、`JOB_NAMESPACE=platform-jobs`、`JOB_IMAGE=busybox:1.36`。
之後經 Gateway `POST /api/projects/{id}/jobs` 送出的工作會成為 `platform-jobs` 內的 Kubernetes Job。
解除：`cd ../local && docker compose up -d api`（不帶疊加檔即回到 503 狀態）。重建叢集後 kubeconfig 的憑證會變，要重跑一次。

正式環境（甲方）API 跑在叢集內，使用 in-cluster ServiceAccount（需要 `platform-jobs` 的 Job 建立／刪除、Pod 與 Node 讀取、
Kueue ClusterQueue 修改權限），不需要 kubeconfig。

## 只能在甲方 GPU 上驗證

真實 GPU 偵測與驅動（TC-C01-09）、DCGM 使用率／顯存／溫度（TC-C02-02 的 GPU 類）、Dashboard 的實際 GPU 編號（Mac 上依開始時間推算）、
獨占卡上沒有其他行程（`nvidia-smi`）、時間片的實際效能。所有 Mac* 案例的數字要在甲方重跑。
