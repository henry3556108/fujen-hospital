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

結果與剩餘項目在全部完成後補上。
