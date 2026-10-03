# 本機整合環境（Docker Compose）

PostgreSQL、Keycloak、APISIX Gateway、平台 API、Orthanc（平台節點＋模擬 PACS）、MinIO。平台 API、平台 Orthanc、MinIO 不對主機開放連接埠，只能經 Gateway（`http://localhost:9080`）存取。

## 啟動

```bash
cd platform/deploy/local
docker compose up -d --build
docker compose exec -T api /app/.venv/bin/python -m app.seed   # 重建測試基線：3 個專案、8 個帳號
```

Keycloak 管理台：`http://localhost:8080`（本機管理帳號見 `compose.yaml`）。

## 驗收與端對端測試

```bash
cd platform/acceptance && uv run pytest -q                      # TC-SS、TC-A03，經 Gateway
cd platform/web && VITE_API_BASE=http://localhost:9080 VITE_AUTH_MODE=oidc npm run dev   # 另一個終端
cd platform/web && npm run test:e2e:real                          # 真的 Keycloak 登入
```

## 接上 kind 叢集（WP4 排程）

工作 API 預設回 503。先用 `platform/deploy/kind/up.sh` 建叢集，再執行 `platform/deploy/kind/connect-compose.sh`，
它會產生 `kubeconfig.kind` 並以 `compose.kind.yaml` 疊加檔重啟 `api`。之後 `docker compose` 指令若要保留這個設定，
要帶 `-f compose.yaml -f compose.kind.yaml`；只帶預設檔重啟 `api` 就會斷開。

## 影像服務（WP2）

| 服務 | 用途 | 主機連接埠 |
|---|---|---|
| `orthanc` | 平台自己的 DICOM 節點（AET `PLATFORM`，只載入 DICOMweb 外掛）。REST 需要 Basic 認證 | 無；DICOMweb 只能經 Gateway |
| `orthanc-pacs` | 模擬醫院 PACS（AET `PACS`）。平台節點以 C-FIND／C-MOVE 查詢取像 | `127.0.0.1:${PACS_HTTP_PORT:-8043}`（只給驗收測試放入研究） |
| `minio` | S3 相容物件儲存（NIfTI、ITK、標註檔）；API 以 `STORAGE_BACKEND=s3` 使用 | 無 |
| `minio-init` | 一次性：建立 bucket 與平台 API 專用帳號 `platform-api`（只能讀寫該 bucket）；API 不使用 MinIO root | 無 |

- Orthanc 映像 `jodogne/orthanc-plugins` 只有 amd64，在 Apple Silicon 以模擬執行（啟動約 5 秒，足夠測試用）。設定在 `orthanc/platform/`、`orthanc/pacs/`。
- DICOMweb 路由：`/dicomweb/projects/{pid}/studies/{StudyInstanceUID}/...` → APISIX `forward-auth` 呼叫 `api:8000/authz/check`（專案權限、研究在專案內、Accession 清單、series／instance 屬於該研究、非正規路徑一律拒絕、只允許 GET/HEAD）→ 改寫成 Orthanc `/dicom-web/...`，由 Gateway 換上 Orthanc 認證。研究列表搜尋只接受 `/studies?StudyInstanceUID=<單一 UID>`。
- 批次匯入 CLI（`platform/tools/importer`）使用 Keycloak client `ai-platform-importer`（device-code；本機驗收可用帳密）：

```bash
cd platform/tools/importer
uv run python -m importer login                                   # device-code；或 --username ra01 --password-stdin
uv run python -m importer upload --project P1-lung-ct --exclude manifest.json ../synth/out/dicom
```

- 驗收：`cd platform/acceptance && PACS_URL=http://127.0.0.1:8043 uv run pytest -q test_tc_b01.py`（未設定 `SYNTH_DIR` 時會自動產生合成資料；設定 `COMPOSE_PROJECT=ai-platform` 會另外查稽核表）。

## 影像標註與 OHIF（WP5a）

```bash
docker compose -f compose.yaml -f compose.labeling.yaml up -d --build
cd platform/acceptance && COMPOSE_PROJECT=ai-platform uv run pytest -q test_tc_b02.py test_tc_b03.py test_ohif.py
```

- `autolabel`：`platform/fakes` 的 fake-autolabel（MONAI Label 介面子集），只有平台 API 連得到；甲方環境改 `AUTOLABEL_URL` 指向真正的工具。格式規格見 `docs/specs/autolabel-io-format.md`。
- OHIF 檢視器在 Gateway 的 `http://localhost:9081`（`OHIF_HOST_PORT` 可改），網址 `/viewer?StudyInstanceUIDs=<uid>&project=<pid>`。
  DICOMweb 與 OHIF 同源，一律走 `/dicomweb/projects/{pid}`，Accession 清單照樣生效；登入用 Keycloak client `ai-platform-ohif`。
- Gateway 會把 Orthanc 回傳的 `BulkDataURI` 改寫成 Gateway 的專案範圍位址（取代 Orthanc `PublicRoot` 設定），bulk data 同樣經過 forward-auth。
- DICOMweb 的 CORS 在開發環境放行 `localhost` 任意埠，甲方環境改成正式網域。
- 改了 `keycloak/realm-ai-platform.json`（新增 `ai-platform-ohif`）的既有環境，要照下方「已知狀況」重新匯入 realm。

## 網頁前端（正式映像）

```bash
docker compose -f compose.yaml -f compose.web.yaml up -d --build      # 網頁在 http://localhost:9082
cd ../../web && WEB_URL=http://localhost:9082 npm run test:e2e:real   # 真瀏覽器經 Keycloak 登入
```

`platform/web/Dockerfile`：Node 建置、nginx（非 root）提供靜態檔。網頁經 Gateway 的 9082 埠，`/api` 在同一個 Gateway 上，所以與 API 同源、不需要 CORS。
網址在容器啟動時寫成 `/config.js`（`WEB_OIDC_AUTHORITY`、`WEB_OHIF_BASE` 等），同一個映像用在每個環境。
既有環境要重新匯入 realm（`ai-platform-web` 新增了 `http://localhost:9082`），見下方「已知狀況」。

## 與共用環境並行啟動第二套

主機連接埠可用環境變數改掉，搭配不同的 compose 專案名稱：

```bash
KEYCLOAK_HOST_PORT=18080 GATEWAY_HOST_PORT=19080 PACS_HTTP_PORT=18043 docker compose -p ai-platform-wp2 up -d --build
cd platform/acceptance && GATEWAY_URL=http://localhost:19080 KEYCLOAK_URL=http://localhost:18080 PACS_URL=http://127.0.0.1:18043 uv run pytest -q
docker compose -p ai-platform-wp2 down -v
```

Keycloak 的 `KC_HOSTNAME` 固定為 `http://localhost:8080`，所以 token 的 issuer 不隨主機連接埠改變，API 驗證不受影響；只有 device-code 畫面顯示的網址仍是 8080。

## 資料庫帳號

`api` 與 `fhir-worker` 以 `platform_app` 連線（稽核表只有 INSERT 與 SELECT，TC-SS-07）；表由一次性服務 `db-init`
以擁有者 `platform` 建立並授權，每次 `up` 都會重跑。既有環境 `docker compose up -d --build` 即完成升級，不必 `down -v`；
細節見 `docs/delivery/部署說明.md`「資料庫帳號與升級」。

## 已知狀況

- Keycloak 只在**第一次**啟動時匯入 `realm-ai-platform.json`，之後設定存在 PostgreSQL。改了 realm 檔（例如新增 client）要重新匯入：
  ```bash
  docker compose stop keycloak
  docker compose exec -T postgres psql -U platform -d platform -c "DROP DATABASE keycloak;" -c "CREATE DATABASE keycloak;"
  docker compose start keycloak
  docker compose exec -T api /app/.venv/bin/python -m app.seed   # 重建種子，會自動同步 admin01 的新 subject
  ```

- 若 `docker pull` 卡住不動，通常是 Docker Desktop 的憑證工具在等 macOS 鑰匙圈授權。可以按下鑰匙圈視窗的「允許」，或暫時用不含 `credsStore` 的設定檔下載公開映像：
  `DOCKER_CONFIG=<含 {"auths":{}} 的資料夾> DOCKER_HOST=unix://$HOME/.docker/run/docker.sock docker compose pull`
- `realm-ai-platform.json` 的 `directAccessGrantsEnabled` 只為本機驗收腳本取 token，正式環境必須關閉。
- 所有密碼都是本機測試值，不可用於甲方環境（含 Orthanc 帳號、MinIO root 金鑰與平台 API 的物件儲存帳號、`apisix.yaml` 內的 Orthanc Basic 認證）。

## 停止

```bash
docker compose down        # 保留資料
docker compose down -v     # 連同資料庫一起清掉
```

## 訓練與推論（WP5b）

疊加 `compose.training.yaml`：MLflow（訓練紀錄）與推論服務，兩者都不對主機開連接埠。訓練工作跑在 kind 叢集，所以同時要疊加 `compose.kind.yaml`：

```bash
../kind/load-trainer-image.sh                  # 建 platform-trainer 映像（約 6 GB）並載入 kind 的 GPU 節點與 cpu-data 節點
JOB_IO_BASE_URL=http://ai-platform-api-1:8000 \
  docker compose -f compose.yaml -f compose.kind.yaml -f compose.training.yaml up -d --build
```

`JOB_IO_BASE_URL` 是 kind 內的 Job 回連平台 API 的位址，用 api 容器在 `kind` 網路上的名稱（`<compose 專案>-api-1`）。
所有端點都在既有的 Gateway 路由 `/api/*` 之下，APISIX 不需要新增路由。說明見 `platform/training/README.md`。
