# WP8 合規與交付 Implementation Plan

> **For agentic workers:** 有邏輯的部分依 superpowers:test-driven-development 逐 Task 執行；每個 Task 一個 commit。

**Goal:** 平台每個元件的來源、版本、授權都查得到且與實際一致；上傳的檔案掃過毒；8 類稽核與監控沒有漏洞；備份能還原、部署說明照做能完成。全部做成可重跑的檢查，其他工作包合併後不改程式就能涵蓋新服務。

**Architecture:** `platform/compliance/` 是獨立的 uv 專案，提供 `python -m compliance <檢查>` 指令。核心是 **探索（discover）**：從所有 compose 檔（含 `compose.*.yaml` 疊加檔）、kind 部署檔、Dockerfile、`uv.lock`、`package-lock.json` 找出映像與套件集合，不寫死清單。外部工具（Syft、Trivy、ClamAV）以釘住 digest 的容器執行，經 `ToolRunner` 介面呼叫；單元測試用假的 runner，不需 Docker。平台 API 只加一個掃毒介面 `app/scanning.py`（記憶體版假實作＋clamd 實作）與最少的呼叫點。

**Tech Stack:** Python 3.12、PyYAML、httpx、pytest；Syft、Trivy、ClamAV（版本與 digest 記在 `platform/compliance/tools.lock.json`）；bash＋`docker compose`（備份、還原、部署演練）；Playwright（示範流程）。

## Global Constraints

- 文件繁體中文。腳本失敗時結束碼非 0，每項檢查印一行總結：`PASS|FAIL|WARN  <TC ID>  <說明>`。
- 檢查要誠實：沒有資料、服務沒起來、工具沒裝，一律是 FAIL 或明確的 SKIP 原因，不可當成通過。
- 不 commit 掃描輸出、漏洞資料庫、工具執行檔；快取放 `~/.cache/fujen-compliance/`（可用 `COMPLIANCE_CACHE` 改）。授權清單與已確認套件清單是交付物，要 commit。
- EICAR 測試字串在測試執行時組出來，不進 git。
- 不改 `docs/TODO.md`、路線圖、根目錄 README。compose 新增服務放 `platform/deploy/local/compose.compliance.yaml`。
- 自己的 compose 專案 `ai-wp8`，連接埠 Keycloak 18380、Gateway 19380、PACS 18343。

## File Structure

```
platform/compliance/
  pyproject.toml  uv.lock  README.md
  tools.lock.json            Syft／Trivy／ClamAV 映像與 digest、版本、來源
  policy/
    image-sources.yaml       核准的映像來源（registry／命名空間）與例外
    secrets.yaml             要比對的機密所在位置（compose 環境變數名稱、realm 欄位）
    severity.yaml            測試報告的缺陷分級規則
  compliance/
    __main__.py  cli.py      指令入口
    discover.py              映像、建置映像、套件集合的探索
    tools.py                 ToolRunner 介面、DockerToolRunner、FakeToolRunner
    sbom.py                  Syft 輸出 → 元件列（名稱、版本、類型、授權）
    licences.py              產生與比對授權清單（TC-D01-01）
    packages.py              映像內 Python 套件版本清單（TC-A01-04）
    vulns.py                 Trivy 掃描彙整（TC-D01-07）
    sources.py               映像來源與非專案軟體檢查（TC-D01-07）
    malware.py               ClamAV 掃描上傳區（TC-D01-06）
    audit_coverage.py        8 類稽核抽查與每日筆數（TC-D01-05、TC-DAILY-01）
    monitoring_coverage.py   已部署服務 vs Prometheus 目標（TC-DAILY-02）
    report.py                junit 彙整與缺陷分級（TC-DAILY-03）
    secrets_scan.py          前端打包檔與 API 回應的機密比對（TC-SS-04）
  tests/                     各模組單元測試（假 runner、樣本輸出）
  scripts/
    backup.sh  restore.sh    PostgreSQL、物件儲存、Orthanc、Keycloak realm
    restore-drill.sh         備份 → 刪除 → 還原 → 比對筆數（TC-D02-02）
    deploy-drill.sh          從空環境照部署說明執行（TC-D02-01）
platform/api/app/scanning.py          Scanner 介面、NoScanner、FakeScanner、ClamdScanner、scanner_from_env
platform/api/tests/test_scanning*.py
platform/deploy/local/compose.compliance.yaml   clamav（clamd）服務與 api 的 CLAMAV_HOST
platform/acceptance/test_tc_d01.py  test_tc_ss_04.py   經 Gateway 的驗收
platform/web/e2e-real/demo-flow.spec.ts           示範流程（TC-D02-03）
docs/delivery/
  第三方授權清單.md            摘要（每個映像：來源、版本、digest、元件數、授權分布）
  licence-list/<映像>.csv       完整元件列
  python-packages/<映像>.txt    已確認的 Python 套件版本清單
  部署說明.md  備份與還原說明.md  掃毒與來源檢核說明.md
```

## 指令

| 指令 | 作用 | TC |
|---|---|---|
| `python -m compliance discover` | 列出探索到的映像與套件集合 | — |
| `python -m compliance licences generate｜check` | 產生授權清單／重新掃描並比對，差異即失敗 | TC-D01-01 |
| `python -m compliance packages generate｜check` | 映像內 Python 套件版本清單 | TC-A01-04 |
| `python -m compliance vulns` | Trivy 掃描所有映像，依嚴重度彙整 | TC-D01-07 |
| `python -m compliance sources [--running]` | 映像來源白名單；`--running` 另比對執行中的容器與叢集 Pod | TC-D01-07 |
| `python -m compliance malware --compose-project <p>` | ClamAV 掃上傳區，放入 EICAR 驗證攔截 | TC-D01-06 |
| `python -m compliance audit --compose-project <p>` | 8 類各抽 3 筆欄位檢查＋各類筆數 | TC-D01-05、TC-DAILY-01 |
| `python -m compliance monitoring` | 已部署服務 vs Prometheus 目標 | TC-DAILY-02 |
| `python -m compliance report` | 彙整 junit → `acceptance/reports/<日期>/` | TC-DAILY-03 |
| `python -m compliance secrets --gateway <url>` | 機密外洩掃描 | TC-SS-04 |

## 掃毒設計

- **上傳當下掃**：`Scanner.scan(name, data) -> ScanResult(clean, signature)`。設定 `CLAMAV_HOST` 時用 clamd 的 INSTREAM 協定；未設定時用 `NoScanner`（不掃，啟動時記一行警告）。
- 呼叫點：物件儲存以 `ScanningObjectStore` 包一層，所有 `store.put` 都會掃（其他工作包新增的上傳自動涵蓋）；DICOM 走 Orthanc 不經物件儲存，在影像匯入的讀檔處另加一個呼叫點，被攔下的檔案記成該檔失敗，不影響同批其他檔。
- 掃毒服務連不上時**拒絕上傳**（fail closed），回 503 與明確訊息。
- **定期掃**：`python -m compliance malware` 以 `clamscan` 容器掃物件儲存匯出的內容與 Orthanc 儲存區，作為驗收腳本與每日檢查；病毒碼更新後可抓到當初沒攔到的檔案。

## Tasks

1. 探索：compose（含疊加檔、`build:`）、kind 部署檔、Dockerfile `FROM`、`uv.lock`、`package-lock.json`。
2. 工具執行：`tools.lock.json`、`ToolRunner`、Syft 輸出解析。
3. 授權清單產生與比對（TC-D01-01）、映像內 Python 套件清單（TC-A01-04）。
4. 映像來源檢查與 Trivy 彙整（TC-D01-07）。
5. 掃毒介面與上傳掛點（平台 API）＋ clamd 疊加檔。
6. ClamAV 上傳區掃描腳本（TC-D01-06）。
7. 稽核覆蓋（TC-D01-05、TC-DAILY-01）。
8. 監控覆蓋腳本（TC-DAILY-02）。
9. 測試報告彙整與缺陷分級（TC-DAILY-03）。
10. 機密外洩掃描（TC-SS-04）。
11. 備份、還原與還原演練（TC-D02-02）。
12. 部署說明與部署演練（TC-D02-01）。
13. 示範流程 Playwright（TC-D02-03）。
14. `test-all.sh --compliance`、實際執行、記錄結果。

## Test List

| TC | 單元測試 | 在本機實跑 |
|---|---|---|
| TC-D01-01 授權清單 | 解析、產生、比對（多一個、少一個、版本不同、授權不同都要失敗） | 對所有探索到的映像 `licences generate` 後 `check` |
| TC-D01-05 8 類稽核 | 抽樣與欄位缺漏判斷、某類 0 筆要失敗 | 對 compose 堆疊的資料庫執行 |
| TC-D01-06 掃毒 | FakeScanner、clamd 協定（假 socket）、上傳攔截、fail closed | clamd＋上傳 EICAR 經 Gateway；`clamscan` 掃上傳區 |
| TC-D01-07 漏洞與來源 | 來源白名單比對、Trivy 輸出彙整 | Trivy 掃所有映像；來源檢查 |
| TC-DAILY-01 稽核覆蓋 | 同 TC-D01-05 | 同上 |
| TC-DAILY-02 監控覆蓋 | 目標比對邏輯 | 對 kind 叢集的 Prometheus |
| TC-DAILY-03 測試報告 | junit 解析、分級規則 | 彙整本機所有 junit |
| TC-SS-04 金鑰不外洩 | 機密來源探索、比對（含 base64、URL 編碼） | 前端打包檔＋經 Gateway 的 API 回應 |
| TC-A01-04 Python 套件 | 清單比對 | 自建映像（api） |
| TC-D02-01 部署演練 | — | `deploy-drill.sh` 從空環境 |
| TC-D02-02 還原演練 | — | `restore-drill.sh` |
| TC-D02-03 示範可重現 | — | Playwright 對 compose 堆疊 |

## 只能在甲方環境驗證

- OS、GPU 驅動、CUDA 等主機層軟體的授權清單（本機只涵蓋容器映像、Python、Node 套件）。AI 模型與 LLM 權重的來源由 WP7 的白名單紀錄提供，合併後併入清單。
- 正式環境映像（vLLM、MONAI Label、NVIDIA device plugin、DCGM）的掃描。
- 真實備份媒體與異地還原；甲方環境的部署演練（TC-D02-01 的甲方部分）。
- 教育訓練本身與出席紀錄。
