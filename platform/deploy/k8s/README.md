# 平台部署到 Kubernetes

整個平台（網頁前端、Gateway、Keycloak、平台 API、FHIR worker、Orthanc、MinIO、ClamAV、HAPI FHIR、Wiki.js、MLflow、推論服務、OHIF、PostgreSQL）
跑在命名空間 `ai-platform`；訓練與推論 Job 仍在 `platform-jobs`，由平台 API 以叢集內 ServiceAccount 送出（沒有 kubeconfig）。
manifest 全部以 Kustomize（kubectl 內建）管理；部署時包成一個 Helm release（`ai-platform`），只為了版本紀錄與 rollback。
部署步驟與演練見 `docs/delivery/部署說明.md`。

## 目錄

| 路徑 | 內容 |
|---|---|
| `base/` | 共同的 manifest；`base/config/` 由 `render-config.py` 從 compose 的設定原始檔產生 |
| `overlays/kind/` | 本機 kind：開發密碼、fake-llm、fake-autolabel、Mailpit、模擬 PACS、NodePort、種子工作 |
| `overlays/production/` | 甲方範本：沒有假服務與模擬 PACS，多了 LLM 模型服務 Ollama（GPU）；網域、TLS、外部服務是佔位（`CHANGE-ME`、`*.example.invalid`） |
| `components/images/` | **唯一的映像清單**。manifest 只寫 `ai-platform/<服務>`，版本與 digest 只改這裡 |
| `render-config.py` | 產生設定檔；`--check` 檢查是否與 compose 原始檔同步（manifest 測試會跑） |
| `create-secrets.sh` | 建立 Secret `platform-secrets`（`--dev` 開發值；預設隨機產生） |
| `build-and-load.sh` | 建置平台映像、拉上游映像、匯入 kind 節點 |
| `deploy.sh` | 以 Helm release 部署 overlay、依序等服務就緒、跑一次性工作 |
| `helm/chart` | 沒有樣板的 chart（只有 `Chart.yaml` 與 NOTES） |
| `helm/kustomize-postrenderer` | Helm 4 post-renderer 外掛：輸出 `kubectl kustomize <overlay>` |
| `scale.sh` | 全部縮到 0／恢復 1 份 |
| `kind/expose.sh` | 主機 127.0.0.1 連接埠轉送到 NodePort（kind 建立後不能再加 extraPortMappings） |
| `offline/` | **選用**：離線安裝包（`bundle.sh`）、離線安裝（`install.sh`）、演練用的節點對外連線阻擋（`block-egress.sh`）。甲方環境可上網，正式部署不需要 |

## 本機 kind

```bash
cd platform/deploy/k8s
./build-and-load.sh          # 第一次約 10 分鐘（匯入映像）；之後只匯入有變的
./deploy.sh kind             # 套用、db-init、minio-init、seed、wiki-setup、啟動 expose.sh
```

| 服務 | 主機位址 | NodePort |
|---|---|---|
| 網頁前端（Gateway 9082，與 /api 同源） | http://localhost:38982 | 30982 |
| Gateway（平台 API、DICOMweb、FHIR） | http://localhost:38980 | 30980 |
| OHIF（Gateway 9081） | http://localhost:38981 | 30981 |
| Keycloak | http://localhost:38180 | 30880 |
| 模擬 PACS REST（驗收放入研究） | http://127.0.0.1:38943 | 30943 |
| Mailpit（告警信） | http://127.0.0.1:38925 | 30925 |

主機連接埠由 `kind/expose.sh` 的轉送容器 `ai-platform-k8s-expose` 提供（只綁 127.0.0.1），流量照樣經 kube-proxy 與 NetworkPolicy。
不想多一個容器時改用 `kubectl port-forward`（會繞過 NetworkPolicy），指令寫在 `kind/expose.sh` 開頭。

token 的 issuer 固定為 `KC_HOSTNAME/realms/ai-platform`（kind 是 `http://localhost:38180`），平台 API 的 `OIDC_ISSUER` 由同一個值組成，
所以經哪個位址取 token 都一樣（與 compose 的做法相同）；JWKS 與管理 API 走叢集內的 `http://keycloak:8080`。

### 驗收

```bash
cd platform/acceptance
export K8S_NAMESPACE=ai-platform GATEWAY_URL=http://localhost:38980 KEYCLOAK_URL=http://localhost:38180 \
       PACS_URL=http://127.0.0.1:38943 MAILPIT_URL=http://127.0.0.1:38925 OHIF_URL=http://localhost:38981
uv run pytest -q test_k8s_deploy.py          # TC-SS-05（叢集版本）、RBAC、ServiceAccount、對外連接埠
uv run pytest -q                              # 經 Gateway 全套（kind 標記的測試另外跑）
```

設了 `K8S_NAMESPACE` 時，原本以 `docker compose exec` 查資料庫、看環境變數、停服務的測試改用 `kubectl`（`platform_exec.py`）。

### 記憶體

整套平台在 kind 上的工作集約 3.8 GB（ClamAV 約 1 GB、HAPI 約 0.85 GB、Keycloak 約 0.4 GB）。開發機只有 12 GB，與 compose 堆疊同時跑會進入 swap：

```bash
./scale.sh down    # 全部縮到 0（保留 PVC、Secret、manifest）
./scale.sh up      # 恢復
```

### 改了 realm 檔

Keycloak 只在第一次啟動時匯入 realm。重新匯入：

```bash
kubectl -n ai-platform scale deployment/keycloak --replicas=0
kubectl -n ai-platform exec statefulset/postgres -- psql -U platform -c "DROP DATABASE keycloak" -c "CREATE DATABASE keycloak"
kubectl -n ai-platform scale deployment/keycloak --replicas=1
kubectl -n ai-platform create job seed-$(date +%s) --from=cronjob/seed      # kind；甲方改 bootstrap-admin
```

## 設計重點

- **設定與密碼分開**：realm、APISIX 路由、Orthanc 設定裡的密碼都是環境變數佔位（Keycloak `${VAR}`、Orthanc `${VAR}`、APISIX `${{VAR}}`），
  值只在 Secret `platform-secrets`。ConfigMap 不含任何密碼（`platform/compliance/tests/test_k8s_manifests.py` 檢查）。
- **一次性工作**寫成暫停的 CronJob（工作範本），由 `deploy.sh` 以 `kubectl create job --from=cronjob/<名稱>` 建立：
  `db-init`、`minio-init`、`bootstrap-admin`、`wiki-setup`，kind 另有 `seed`。全部可重複執行；Job 建立後 Pod 範本不能改，直接 apply Job 會失敗，所以不這樣做。
- **放置**：所有平台 Pod `nodeSelector: platform/pool=cpu-web`。推論服務也在 cpu-web（映像約 6 GB，`build-and-load.sh` 會匯入）。
  唯一例外是 production 的 Ollama：GPU 共享池（`platform/pool=gpu-shared`，容忍 `nvidia.com/gpu` taint，要 1 份 `nvidia.com/gpu`）。
- **NetworkPolicy**：命名空間預設拒絕所有進入流量；命名空間外只能連 Gateway 與 Keycloak。平台 API 另接受 `platform-jobs`（Job 以一次性 token 回連工作 I/O）。
  標籤 `platform/backend=true`（平台程式的 Pod）可連內部服務，`platform/db-client=true` 可連 PostgreSQL。只管進入流量。
- **RBAC**（`base/rbac.yaml`）：`platform-jobs` 的 Job 建立／讀取／刪除、Pod 讀取；Node 讀取；Kueue ClusterQueue `gpu-shared` 讀取與修改。
  kind 另給 `nodes/status` patch（假 GPU 份數），甲方不給。
- **探針**：逾時 5 秒、存活探針連續 6 次失敗才重啟（主機忙碌時 1 秒逾時會讓健康的服務被重啟，開發機實際發生過）。
- **記憶體上限**：Keycloak `-XX:MaxRAMPercentage=40`、HAPI `-Xmx640m`、MinIO 與 Mailpit `GOMEMLIMIT`、APISIX 2 個 worker、
  ClamAV `ConcurrentDatabaseReload no`（重載病毒碼時不同時保留兩份）。CPU 上限不超過 0.75 核（監控的 HighPodCpu 門檻是 0.8 核）。

## 監控

- **抓取宣告跟著 manifest**：有 `/metrics` 的服務在 Pod 範本加註記 `prometheus.io/scrape: "true"`、`prometheus.io/port`、`prometheus.io/path`：

  | 服務 | 端點 |
  |---|---|
  | api | `:8000/metrics`（請求數與延遲依路由樣板、行程指標；Gateway 只轉 `/api/*`，不對外） |
  | apisix | `:9091/apisix/prometheus/metrics`（prometheus 外掛匯出埠，聽 0.0.0.0） |
  | keycloak | `:9000/metrics`（管理埠，`KC_METRICS_ENABLED=true`） |
  | minio | `:9000/minio/v2/metrics/cluster`（`MINIO_PROMETHEUS_AUTH_TYPE=public`） |

  其餘服務沒有可用的 `/metrics`，以 cAdvisor 的容器指標覆蓋，清單與原因在 `platform/compliance/policy/monitoring.yaml`
  的 `container_metrics_only`。新增服務時兩者擇一，`platform/compliance/tests/test_monitoring_config.py` 會檢查。
- **Prometheus 只需一個通用工作**：kind 的監控堆疊用 `platform/deploy/kind/monitoring/prometheus.yaml` 的 `ai-platform-pods`
  （Pod 服務探索，限 `ai-platform`，`job` 取 Pod 的 `app` 標籤，與 Deployment／StatefulSet 同名）。甲方以自己的 Prometheus 監控時
  複製這個工作；服務增減不必改 Prometheus 設定。
- **網路政策**：`base/networkpolicy.yaml` 的 `metrics-*` 讓 `monitoring` 命名空間只連到各服務的指標埠。甲方 Prometheus 在別的命名空間時改那裡的名稱。
- **驗證**：`cd platform/compliance && uv run python -m compliance monitoring`（TC-C02-01），最後一行 `PASS … 未覆蓋 0`。

## 正式環境（甲方）

1. 映像推到甲方內部 registry，把 `components/images/kustomization.yaml` 的 `newName` 改成 registry 位址
   （或在 `overlays/production/kustomization.yaml` 另加 `images:` 覆寫）。甲方環境可上網，節點直接向來源 registry 拉取亦可（照 `components/images` 的版本與 digest）；離線安裝包只在不能上網的環境使用。
2. 替換 `overlays/production` 的佔位：`platform-urls`（三個網域與 CORS）、`api-env`（SMTP）、`pacs`、
   `ingress.yaml`（ingressClassName、TLS Secret）、`networkpolicy-production.yaml`（PACS 位址）、`config/app-config.js`（Keycloak 網域）。
   `deploy.sh production` 發現還有 `CHANGE-ME` 或 `example.invalid` 就停止。
3. `./create-secrets.sh`（隨機產生，不進版控；`--print-keys` 列出所有鍵）；`kubectl -n ai-platform create secret tls ai-platform-tls --cert=… --key=…`。
4. `./deploy.sh production`：不跑種子，改跑 `bootstrap-admin` 把 realm 匯入的 `admin01` 登記為平台 Admin；admin01 第一次登入必須改密碼。
5. 正式 realm 關閉所有 public client 的密碼授權（`directAccessGrantsEnabled`），匯入 CLI 用 device-code。
6. LLM 模型：部署後執行一次（可重複執行；依 `config/llm-models.json` 登記白名單、從 Hugging Face 下載並核對 commit 與 hash、推進 Ollama 常駐）
   `kubectl -n ai-platform exec deploy/api -- /app/.venv/bin/python -m app.llm.model_setup /opt/llm-models.json`。
   白名單改 `platform/deploy/local/llm/models.json` 後執行 `render-config.py`。

LLM（`overlays/production/ollama.yaml`，與 `platform/deploy/local/compose.ollama.yaml` 相同）：
- Ollama 一個副本，排在 GPU 共享池、佔 1 份 GPU（time-slicing），不經 Kueue：共享池的 Kueue 配額（平台「共享排程設定」）要少算一份。
  要獨占一張卡時把 `nodeSelector` 改成 `gpu-exclusive`，獨占池配額少一張。節點要有 NVIDIA device plugin。
- 模型庫在 PVC `ollama-data`（50Gi）；下載的 GGUF 在 api 的 `api-objects`（正式環境 50Gi，`LLM_MODEL_DIR`）。
- 只有平台 API 連得到 Ollama（`networkpolicy-production.yaml` 的 `ollama`）。
- **出口**：api 要能以 HTTPS 連 `huggingface.co` 與 `cas-bridge.xethub.hf.co`（Hugging Face 把大檔轉址到這裡）；Ollama 不需要對外。
  經甲方核准的鏡像站時在 `api-env` 加 `HF_ENDPOINT`。不能上網時改用離線預載目錄（`/opt/llm-preload`，每個模型一個資料夾＋`manifest.json`，
  另掛 PVC 並設 `LLM_PRELOAD_DIR`；格式見 `platform/deploy/local/llm/README.md`）。

自動標註（B-03，`overlays/production/autolabel-monai.yaml`，說明見 `platform/autolabel/README.md`）：
- `monai-label`：MONAI Label 0.8.5（radiology app，預訓練 `segmentation_spleen`、`segmentation`，權重在映像內，不需連網），
  GPU 共享池 1 份、不經 Kueue：與 Ollama 合計，共享池的 Kueue 配額要少算兩份。
- `monai-autolabel`：轉接服務（cpu-web），平台 `AUTOLABEL_URL=http://monai-autolabel:8102`；以 Orthanc 唯讀帳號 `autolabel`
  （Secret 鍵 `ORTHANC_AUTOLABEL_PASSWORD`，Orthanc 端以 `autolabel-readonly.lua` 限制只能 GET `/dicom-web/`）取像。
- 映像 `platform-autolabel`、`platform-monailabel` 以 `platform/autolabel/build.sh` 建置（`images.py autolabel`）；kind 不部署，仍用 fake-autolabel。

資料庫帳號：平台程式（api、fhir-worker、bootstrap-admin、seed）以 `platform_app` 連線，稽核表只有 INSERT 與 SELECT（TC-SS-07）；
`platform` 只給 db-init 建表與授權（`app/db_init.py`）。既有環境升級與細節見 `docs/delivery/部署說明.md`「資料庫帳號與升級」。
`POSTGRES_APP_PASSWORD` 由 db-init 每次部署時設定，改 Secret 後重新部署即可。

更換密碼：PostgreSQL 與 Keycloak 只在第一次初始化時採用 Secret 的值。先在服務內改（`ALTER USER`、Keycloak 管理台），
再 `kubectl -n ai-platform edit secret platform-secrets`，最後 `kubectl -n ai-platform rollout restart deployment,statefulset`。

## Helm（版本紀錄與 rollback）

所有 YAML 仍在 Kustomize；Helm 只負責「每次部署是一個版本、可以退回」。做法是 **post-renderer**：
`helm upgrade --install ai-platform helm/chart --post-renderer kustomize-overlay --post-renderer-args <overlay 目錄>`，
chart 沒有樣板，外掛把 chart 的（空）輸出換成 `kubectl kustomize <overlay>`。Helm 把最後的 manifest 存在 release 紀錄
（命名空間內的 Secret `sh.helm.release.v1.ai-platform.v<N>`），`helm rollback` 直接套用舊版本的 manifest。

為什麼不把 Kustomize 的輸出當成 chart 的樣板：設定檔裡有 APISIX 的 `${{VAR}}`、OHIF 與 Lua 的大括號，放進 Helm 樣板會被 Go template 解析，
得逐一跳脫；產生的樣板檔也會變成第二份要審查的 YAML。post-renderer 不經過樣板引擎，審查的永遠是 `base/`、`overlays/` 本身。

- **版本**：固定 Helm **v4.3.0**（`deploy.sh` 檢查；`ALLOW_HELM_VERSION=1` 可略過）。Helm 4 的 `--post-renderer` 只接受外掛，
  `deploy.sh` 第一次執行會 `helm plugin install helm/kustomize-postrenderer`。
- **安裝 Helm**（Linux amd64；甲方主機）：
  ```bash
  V=v4.3.0
  curl -fsSLO https://get.helm.sh/helm-$V-linux-amd64.tar.gz
  curl -fsSL https://get.helm.sh/helm-$V-linux-amd64.tar.gz.sha256sum | sha256sum -c   # 86584a54…94f54fb
  tar xzf helm-$V-linux-amd64.tar.gz && sudo install -m 755 linux-amd64/helm /usr/local/bin/helm
  helm version     # v4.3.0
  ```
- **命名空間不在 release 內**：release 紀錄存在 `ai-platform` 命名空間，所以命名空間由 `deploy.sh` 先 `kubectl apply -f base/namespace.yaml`。
  `helm uninstall` 不會刪命名空間、PVC 與 Secret（Secret 本來就不在 release 內）。
- **第一次改用 Helm**：之前以 `kubectl apply -k` 部署的資源，`deploy.sh` 以 `--take-ownership` 接手，不必重建。
- **常用指令**：
  ```bash
  helm history ai-platform -n ai-platform              # 版本清單
  helm rollback ai-platform <版本> -n ai-platform       # 退回（產生一個新版本）
  helm get manifest ai-platform -n ai-platform          # 某版本實際套用的 YAML
  ```
- 退回只回復 manifest（Deployment、ConfigMap、RBAC 等）；資料庫內容、PVC、Secret 不會退回。Keycloak 26.8 這類會遷移資料庫結構的升級，
  退回映像前要先還原資料庫備份（`platform/compliance/scripts/restore.sh` 的做法）。
- 一次性工作（db-init、seed…）是 CronJob 範本，屬於 release；實際執行的 Job 由 `deploy.sh` 建立，不屬於 release。

## 網頁前端

`platform/web/Dockerfile`：Node 建置打包檔，`nginxinc/nginx-unprivileged`（非 root，8080）提供靜態檔。

- **經 Gateway 的 9082 埠**（與 OHIF 用 9081 同樣的做法）：`/api/*`、`/dicomweb/*`、`/fhir/*` 的路由優先序較高，所以網頁與平台 API 同源，
  `WEB_API_BASE` 為空字串，不需要 CORS；9080 不提供網頁，未知路徑照舊 404（TC-SS-05 的檢查不變）。甲方的 Ingress 把平台網域送到 9082。
- **一個映像用在每個環境**：網址不在打包時寫死。容器啟動時 `/docker-entrypoint.d/40-platform-config.sh` 把 `WEB_*` 環境變數寫成 `/config.js`
  （`window.__PLATFORM_CONFIG__`），`index.html` 在主程式之前載入，蓋過打包期的 `VITE_*`（`src/runtimeConfig.ts`）。只接受網址字元。
  Kubernetes 的值來自 `platform-urls`（`KC_HOSTNAME`、`OHIF_PUBLIC_URL`）；Keycloak 的 `ai-platform-web` 只允許 `WEB_PUBLIC_URL`。
- 打包檔與 `/config.js` 只有公開設定：`compliance secrets --web-dist <目錄>` 檢查（TC-SS-04）。
- 真瀏覽器端對端：`cd platform/web && WEB_URL=http://localhost:38982 npm run test:e2e:real`（經 Keycloak 登入）。
