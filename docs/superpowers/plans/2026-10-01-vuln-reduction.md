# 映像漏洞減量（WP8 後續）Implementation Plan

> **For agentic workers:** 每個 Task 一個 commit；升級若讓測試失敗且修正不小，就退回該升級並列入建議。

**Goal:** WP8 的 Trivy 掃描（`python -m compliance vulns`）在 26 個映像回報 CRITICAL 99、HIGH 1354（2026-10-01 的漏洞資料庫；09-29 的報告為 99／1279）。甲方尚未議定門檻，先把我們能控制的部分降下來：自建映像換基底與多階段建置、上游映像升到同產品最新的修補或次版本，並證明功能不受影響；剩下的逐項說明原因，作為與甲方討論門檻的依據。

**Architecture:**

- **自建映像（api、platform-trainer、fakes）**：基底由 `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`（Debian 12）與 `python:3.12-slim` 改為 `python:3.12-slim-trixie`（Debian 13，Python 3.12 不變）。兩階段建置：建置階段複製 `ghcr.io/astral-sh/uv:0.11` 的 uv 安裝鎖定套件；最終映像只有 Python、`.venv` 與程式，不含 uv、pip、套件快取，建置時 `apt-get upgrade` 套用 Debian 已發布的安全更新，維持非 root（uid 10001）。路徑（`/app/.venv`、`/app/app`、`/work`）與指令不變，compose、kind 與驗收測試的 `exec` 都不用改。
- **上游映像**：只升同一產品的修補或次版本，主版本跳躍若改變設定或行為，只列建議不做。映像名稱不變，只改 compose 與 kind 檔內既有的版本標籤；已用 digest 釘住的維持 digest。
- **Python 與 Node 套件**：Trivy 檔案系統掃描（`uv.lock`、`package-lock.json`）、`pip-audit`（`uv export` 的鎖定版本）與 `npm audit` 都沒有已知漏洞，本次不需更新鎖定套件。
- **交付文件**：重新產生授權清單、映像內 Python 套件、來源檢核與漏洞報告；`out/` 的掃描輸出不進版本庫。

## Global Constraints

- 只在 `vuln-reduction` 分支；不動 `master`、`integration/wp5-8` 與其他 worktree；不 push。
- 映像名稱不變（kind 部署檔由另一位同仁撰寫，依本文件「版本變更」一節跟進）。
- 不停止或刪除不是本次建立的容器、網路、volume、映像；compose 專案 `ai-full` 與 kind 叢集 `ai-platform` 不動（只可另以新標籤載入 trainer 映像測試）。
- 驗證順序：各子專案單元測試 → S0 smoke → 全部疊加檔的 compose 環境（專案 `ai-vuln`、連接埠 187xx／19780）跑經 Gateway 驗收 → 拆除。
- 不改 `docs/TODO.md`、路線圖、根目錄 README。

## Tasks

1. 基準掃描：每個映像的 CRITICAL、HIGH 與其中已有修補版本的數量。
2. 自建映像：新基底、兩階段、`apt-get upgrade`、移除 pip、非 root；trainer 確認 TensorFlow 可載入。
3. 上游映像：逐一以 Trivy 比較候選版本（APISIX、Keycloak、Orthanc、HAPI FHIR、MLflow、Wiki.js、OHIF、pgvector、PostgreSQL、Mailpit），查發行說明後升級。
4. Python 與 Node 套件稽核。
5. 驗證（單元、smoke、經 Gateway 驗收）。
6. 重新掃描並重新產生交付文件。
7. 本文件補上結果：前後對照、版本變更、剩餘項目與原因、門檻建議。

## 基準（2026-10-01，Trivy 0.74.0，資料庫 2026-10-01）

| 映像 | CRITICAL | HIGH | 已有修補 C／H |
|---|---|---|---|
| `cgr.dev/chainguard/minio:latest@sha256:7167…` | 0 | 0 | 0／0 |
| `apache/apisix:3.11.0-debian` | 7 | 92 | 2／32 |
| `axllent/mailpit:v1.22` | 3 | 67 | 3／67 |
| `axllent/mailpit:v1.31.3` | 0 | 0 | 0／0 |
| `clamav/clamav:1.5.4` | 0 | 0 | 0／0 |
| `grafana/grafana:13.2.2` | 0 | 72 | 0／72 |
| `hapiproject/hapi:v8.12.0-1` | 7 | 24 | 7／16 |
| `jodogne/orthanc-plugins:1.13.0` | 6 | 90 | 5／29 |
| `kindest/node:v1.37.0@sha256:a1ed…` | 4 | 123 | 4／60 |
| `busybox:1.36` | 0 | 0 | 0／0 |
| `platform-trainer:dev`（本機既有映像） | 9 | 83 | 4／25 |
| `postgres:16-alpine` | 1 | 21 | 1／21 |
| `python:3.12-slim`（fakes 基底） | 0 | 51 | 0／7 |
| `ohif/app:v3.13.10` | 2 | 40 | 2／40 |
| `pgvector/pgvector:pg16` | 16 | 105 | 1／24 |
| `ghcr.io/astral-sh/uv:python3.12-bookworm-slim`（api、trainer 基底） | 9 | 83 | 4／25 |
| `ghcr.io/mlflow/mlflow:v3.16.1` | 3 | 93 | 3／49 |
| `ghcr.io/requarks/wiki:2.5` | 9 | 100 | 8／97 |
| `quay.io/keycloak/keycloak:26.0` | 5 | 78 | 5／72 |
| `quay.io/prometheus/alertmanager:v0.34.1` | 0 | 1 | 0／1 |
| `quay.io/prometheus/prometheus:v3.15.0` | 0 | 0 | 0／0 |
| `kube-state-metrics:v2.20.0` | 0 | 4 | 0／4 |
| `kueue:v0.19.6` | 0 | 10 | 0／10 |
| 自建映像 api | 9 | 83 | 4／25 |
| 自建映像 fakes | 0 | 51 | 0／7 |
| 自建映像 training | 9 | 83 | 4／25 |
| **合計** | **99** | **1354** | |


## 結果（2026-10-02）

漏洞資料庫在兩次掃描之間更新過（10-01 → 10-02），所以「前」以同一份 10-02 資料庫重新掃描舊版映像，數字可直接相減。未變更的映像也因資料庫更新而變（HAPI HIGH 24→28、Wiki.js 100→102、ClamAV 0→1、Keycloak 26.0 78→80）。

**合計：CRITICAL 99 → 48、HIGH 1363 → 961**（映像 26 → 25：Mailpit 合併為同一版本）。官方報告：`docs/delivery/映像漏洞掃描報告.md`。

| 映像 | 前 C／H | 後 C／H | 後：已有修補 C／H | 說明 |
|---|---|---|---|---|
| 自建映像 api | 9／83 | **0／44** | 0／0 | Debian 13、兩階段、`apt-get upgrade`、移除 pip |
| 自建映像 training（platform-trainer） | 9／83 | **0／44** | 0／0 | 同上；映像 5.9 GB → 3.2 GB |
| 自建映像 fakes | 0／51 | **0／0** | 0／0 | Alpine；僅開發與測試 |
| 基底 `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` → `python:3.12-slim-trixie` | 9／83 | 0／51 | 0／7 | 基底本身；最終映像已套用那 7 項修補 |
| 基底 `python:3.12-slim` → `python:3.12-alpine` | 0／51 | 0／0 | 0／0 | fakes 基底 |
| `quay.io/keycloak/keycloak` 26.0 → 26.8.0 | 5／80 | **0／6** | 0／0 | |
| `apache/apisix` 3.11.0-debian → 3.19.0-debian | 7／92 | **5／65** | 0／0 | 上游映像仍是 Debian 12 |
| `axllent/mailpit` v1.22 → v1.31.3 | 3／67 | **0／0** | 0／0 | 與叢集同版 |
| `pgvector/pgvector` pg16 → 0.8.7-pg16-trixie | 16／105 | **2／83** | 1／22 | 同版 pgvector／PostgreSQL，Debian 13 |
| `jodogne/orthanc-plugins:1.13.0` | 6／90 | 6／90 | 5／29 | 已是最新版 |
| `hapiproject/hapi:v8.12.0-1` | 7／28 | 7／28 | 7／20 | 已是最新版（Tomcat、Jackson 等 Java 函式庫） |
| `ghcr.io/mlflow/mlflow:v3.16.1` | 3／93 | 3／93 | 3／49 | 已是最新版 |
| `ghcr.io/requarks/wiki:2.5`（= 2.5.315） | 9／102 | 9／102 | 8／98 | 已是最新版（Node 套件） |
| `ohif/app:v3.13.10` | 2／40 | 2／40 | 2／40 | v3.13.12 掃描結果相同，未升 |
| `postgres:16-alpine`（= 16.15） | 1／21 | 1／21 | 1／21 | 已是最新版；全部在 gosu（Go 標準函式庫） |
| `platform-trainer:dev`（本機既有映像） | 9／83 | 9／83 | 4／25 | 掃的是主機上舊 Dockerfile 建的標籤，見下 |
| `kindest/node:v1.37.0@…` | 4／123 | 4／123 | 4／60 | 僅開發機（kind） |
| `grafana/grafana:13.2.2` | 0／72 | 0／72 | 0／72 | 僅 kind 叢集，見建議 |
| `kueue:v0.19.6`、`kube-state-metrics:v2.20.0`、`alertmanager:v0.34.1` | 0／15 | 0／15 | 0／15 | 僅 kind 叢集，見建議 |
| `clamav/clamav:1.5.4` | 0／1 | 0／1 | 0／1 | 已是最新版 |
| MinIO（digest）、Prometheus、busybox | 0／0 | 0／0 | | |

`platform-trainer:dev` 這一列：探索工具掃描主機上的本機標籤，本次沒有覆寫它（kind 叢集與其他 worktree 共用這個標籤），數字仍是舊版。依本分支重新建置後即與「自建映像 training」相同（0／44），合計會再降為 CRITICAL 39、HIGH 922。

## 版本變更（kind 部署檔請跟進）

| 位置 | 映像 | 由 | 改為 | 其他設定變更 |
|---|---|---|---|---|
| `platform/deploy/local/compose.yaml` | `quay.io/keycloak/keycloak` | `26.0` | `26.8.0` | 新增 `KC_HTTP_HOST: 0.0.0.0`（26.6 起 `start-dev` 預設只聽 localhost） |
| `platform/deploy/local/compose.yaml` | `apache/apisix` | `3.11.0-debian` | `3.19.0-debian` | 無 |
| `platform/deploy/local/compose.fhir.yaml` | `axllent/mailpit` | `v1.22` | `v1.31.3` | 無 |
| `platform/deploy/local/compose.llm.yaml` | `pgvector/pgvector` | `pg16` | `0.8.7-pg16-trixie` | 無；既有 bookworm 資料卷見下 |
| `platform/api/Dockerfile` | 基底 | `ghcr.io/astral-sh/uv:python3.12-bookworm-slim` | `python:3.12-slim-trixie`（建置階段另複製 `ghcr.io/astral-sh/uv:0.11`） | 路徑、使用者、指令不變 |
| `platform/training/Dockerfile` | 基底 | 同上 | 同上 | 路徑（`/app/.venv`、`/work`）、uid 10001、`CMD` 不變 |
| `platform/fakes/Dockerfile` | 基底 | `python:3.12-slim` | `python:3.12-alpine` | uid 10001 不變 |

映像名稱都沒變；`deploy/kind/**` 本次沒有修改。

## 驗證

| 項目 | 結果 |
|---|---|
| `platform/api` 單元 | 1027 passed、6 skipped |
| `platform/libs/tabular` | 333 passed |
| `platform/tools/synth` | 46 passed |
| `platform/tools/importer` | 13 passed |
| `platform/fakes` | 46 passed |
| `platform/training`（`--extra keras`，主機） | 56 passed |
| `platform/training` 測試在**新映像內**以 uid 10001 執行（TensorFlow 2.21 影像範本、推論服務） | 56 passed |
| `platform/web` Vitest | 27 個檔案、370 passed |
| `platform/compliance` 單元 | 48 passed |
| S0 smoke（`cd platform/api && uv run pytest ../smoke/s0`） | 17 passed、1 skipped |
| 經 Gateway 驗收（compose 專案 `ai-vuln`，疊加 fhir、labeling、llm、training、compliance；Keycloak 18780、Gateway 19780、PACS 18743、OHIF 18781、Mailpit 18725；先 seed 與 `app.llm.wiki_setup`） | 85 passed、1 failed、29 skipped，13 分 13 秒 |
| 授權清單、映像內 Python 套件 | 重新產生後 `check` 差異 0；來源檢核：非受限來源 0 |
| Python 與 Node 套件 | Trivy 檔案系統掃描 9 個 `uv.lock`＋`package-lock.json`：0；`pip-audit`（`uv export` 的鎖定版本，含所有 extras 與 dev）：0；`npm audit`：0。不需更新鎖定套件 |

- 失敗的 1 項是 `test_ohif.py::test_ohif_client_exists_in_keycloak`：測試用 `http://localhost:18781/callback` 當 redirect_uri，但 realm 的 `ai-platform-ohif` 只登記了 9081 與 19081，Keycloak 回 400。以已登記的 `http://localhost:9081/callback` 對同一個 Keycloak 26.8.0 送同樣的請求回 200 並顯示登入表單，所以是第二套環境的連接埠，與升級無關。
- 29 個 skipped 全部是 kind 叢集相關（`test_tc_b05_b06` 13 項需要 `compose.kind.yaml`；`test_tc_a02_gpu`、`test_tc_c01`、`test_tc_c02`、`kind_harness` 16 項）。kind 叢集為共用環境，本次不接上，也沒有把新的 trainer 映像載入叢集；trainer 映像改以「在映像內跑訓練測試」與 compose 的推論服務驗證。
- FHIR 經 APISIX 3.19 的路徑（含回應內網址的對外連接埠 19780，`test_tc_c03`）全部通過。3.18 起 APISIX 會自行設定 `X-Forwarded-Port`，`apisix.yaml` 內以 Lua 設定該標頭的做法仍然有效。
- 第一次驗收（10-01）在主機記憶體不足時執行（可用記憶體約 1 GB、系統負載破百，最後主機重開），大量逾時與名稱解析失敗；拆掉重建後的第二次即為上表結果。
- 記憶體：APISIX 3.19 閒置約比 3.11 多 280 MB（同設定實測 1.12 GiB 對 844 MiB，12 核主機上預設每核一個 worker）。Keycloak 26.8.0 執行時約 760 MB。

## 剩下的漏洞與原因

| 類別 | 映像 | C／H | 原因 |
|---|---|---|---|
| 作業系統尚無修補 | api、platform-trainer（各 0／44）、`python:3.12-slim-trixie`（0／51，其中 7 項已在最終映像修補） | 0／139 | Debian 13 尚未發布修補：util-linux 系列（bsdutils、libblkid1、libmount1、libsmartcols1、libuuid1、login、mount 等，每個套件同 4 個 CVE）、ncurses、libacl1、systemd 函式庫。多數是必要（Essential）套件，dpkg 與 Python 都依賴，移除不安全 |
| 上游已最新、作業系統尚無修補 | APISIX 3.19.0（5／65）、pgvector 的作業系統套件（C 1、H 61）、Keycloak 26.8.0（0／6，pcre2） | 6／132 | APISIX 官方映像仍是 Debian 12；libxml2、perl-base、util-linux、pcre2 尚無修補 |
| 上游已最新、等上游重建 | Orthanc 1.13.0（6／90）、MLflow v3.16.1（3／93）、Wiki.js 2.5.315（9／102）、HAPI v8.12.0-1（7／28）、OHIF v3.13.10（2／40）、PostgreSQL 16.15（1／21）、pgvector 內的 gosu（Go 標準函式庫，C 1、H 22）、ClamAV 1.5.4（0／1） | 29／397 | 已是各產品最新版；有修補版本的是映像內的作業系統套件或內建函式庫（Java、Node、Go），要上游重新發布映像 |
| 僅開發機或 kind 叢集 | kindest/node（4／123）、Grafana（0／72）、Kueue（0／10）、kube-state-metrics（0／4）、Alertmanager（0／1） | 4／210 | 不在甲方部署範圍或本次無法在共用叢集驗證 |
| 本機舊標籤 | `platform-trainer:dev`（9／83） | 9／83 | 見上；重新建置即消失 |
| **合計** | | **48／961** | |

## 建議（與甲方討論門檻用）

1. **門檻以「已有修補版本」為準**：建議 `CRITICAL` 與 `HIGH` 中「已有修補版本」者限期修補（例如 CRITICAL 7 天、HIGH 30 天），「尚無修補」者列管追蹤、上游發布後的下一次版本更新一併處理。直接以 `--fail-on HIGH` 擋下，目前任何以 Debian 為基底的映像都過不了。
2. **範圍分開計算**：平台自建映像（我們可完全控制）、上游元件映像、僅開發機的映像（kindest/node、fakes、Mailpit）分開列，門檻只套在交付到甲方環境的映像。可在 `vulns` 加上依來源分組與「只計已有修補版本」的選項。
3. **Grafana 13.2.3**：HIGH 72 → 5（全部 Go 外掛的函式庫），同一次版本的修補版。需在 kind 叢集部署驗證，本次因共用叢集未做，建議由 k8s 部署工作一併升級。
4. **上游自建衍生映像（選擇性）**：Orthanc（5／29 已有修補）、MLflow（3／49）、OHIF（2／40，Alpine 套件）可以在官方映像上加一層 `apt-get upgrade`／`apk upgrade` 自行建置，代價是映像名稱改變與每次上游更新都要重建、重新驗證。建議等甲方定門檻後再決定。
5. **HAPI FHIR**：剩下的 7 個 CRITICAL 都在 Tomcat 與 Jackson 等內建 Java 函式庫，只能等 HAPI 下一版；HAPI 約每 1～2 個月發布一次。
6. **APISIX**：官方 `-debian` 映像仍是 Debian 12；若 APISIX 發布 Debian 13 版或改用其 Ubuntu／Red Hat 版本，可再降。主版本與次版本升級前需看發行說明（3.18 起 `X-Forwarded-*` 的處理改變）。
7. **pgvector 的資料卷**：由 bookworm 版建立的資料卷改用 trixie 版時，PostgreSQL 會提示定序版本不同（glibc 2.36 → 2.41）；依提示 `REINDEX` 並 `ALTER DATABASE … REFRESH COLLATION VERSION`。甲方環境若已有資料，升級步驟要寫進部署說明。
8. **既有的 Keycloak 資料庫**：26.0 → 26.8.0 第一次啟動會自動升級資料表結構，無法退回 26.0；正式環境升級前先備份。
9. **持續做法**：自建映像每次建置都 `apt-get upgrade`，所以定期重新建置（例如每月或 Debian 發布安全更新時）就會帶入修補；`python -m compliance vulns` 可排入每日檢查（TC-DAILY）。
