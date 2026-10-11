# 開發追蹤

最後更新：2026-09-29。路線圖細節見 `docs/superpowers/plans/2026-09-28-roadmap.md`，驗收案例見 `docs/test-cases/acceptance-test-cases.md`。
勾選方式：完成就把 `[ ]` 改成 `[x]`，並在行尾註明 commit 或日期。

## 目前狀態

| 工作包 | 範圍 | 狀態 | 計畫與結果 |
|---|---|---|---|
| WP1a | 平台 API 核心：身分、專案、帳號、權限、稽核、授權檢查 | 完成 | `2026-09-28-wp1a-platform-api-core.md` |
| WP1b | 網頁殼：登入、8 個入口、帳號管理 | 完成 | `2026-09-28-wp1b-web-shell.md` |
| WP2 | 影像匯入：Orthanc ×2、MinIO、匯入 CLI、DICOMweb 經 Gateway | 完成 | `2026-09-28-wp2-imaging.md` |
| WP3 | 結構式資料：CSV 驗證、統計、66 種前處理 | 完成 | `2026-09-28-wp3-tabular-api.md` |
| WP4 | 排程與監控：kind、假 GPU、Kueue、GPU Dashboard、告警；compose 的 API 可接 kind | 完成 | `2026-09-28-wp4-scheduling.md` |
| WP5a | 影像標註與自動標註：標註 API、OHIF、自動標註介面（MONAI Label 相容） | 完成 | `2026-09-29-wp5a-labeling.md` |
| WP5b | 自動訓練、模型匯出、部署與推論：資料版本凍結、5 種範本、MLflow、推論服務 | 完成 | `2026-09-29-wp5b-training.md` |
| WP6 | HL7 FHIR 資料交換：HAPI FHIR、4 種來源 ETL、對應規則、排程、多租戶 | 完成 | `2026-09-29-wp6-fhir.md` |
| WP7 | LLM、RAG、LangGraph、Wiki、模型白名單 | 完成 | `2026-09-29-wp7-llm.md` |
| WP8 | 合規與交付：SBOM、授權清單、Trivy、ClamAV、稽核覆蓋、備份還原、部署演練 | 完成 | `2026-09-29-wp8-compliance.md` |
| 網頁補齊 | 排程、GPU Dashboard、監控、影像與結構式資料頁面 | 完成 | `2026-09-29-web-pages.md` |
| 技術債 | 第三節前 10 項 | 完成 | `2026-09-29-tech-debt.md` |

計畫檔都在 `docs/superpowers/plans/`，各檔最後的「結果」段落記錄測試數字與裁定。

一鍵測試：`platform/scripts/test-all.sh`（`--e2e` 加 Playwright，`--docker` 加經 Gateway 驗收，`--kind` 加 kind 叢集測試，`--compliance` 加合規檢查）。

完整整合環境（所有疊加檔）：
```bash
cd platform/deploy/local
export COMPOSE_FILE=compose.yaml:compose.kind.yaml:compose.labeling.yaml:compose.training.yaml:compose.fhir.yaml:compose.llm.yaml:compose.compliance.yaml
docker compose up -d --build --wait
docker compose exec -T api /app/.venv/bin/python -m app.seed
docker compose exec -T api /app/.venv/bin/python -m app.llm.wiki_setup   # Wiki.js 首次設定
unset COMPOSE_FILE   # 驗收測試會自己呼叫 docker compose -p，留著相對路徑會失敗
```
kind 叢集先以 `platform/deploy/kind/up.sh` 建立，並產生 `kubeconfig.kind`（見 `platform/deploy/kind/README.md`）。

### 整合結果（2026-09-30，分支 `integration/wp5-8`，Linux 開發機）

所有工作包合併後，在完整整合環境（所有疊加檔）與 kind 叢集上執行：

| 測試 | 結果 |
|---|---|
| 平台 API 單元 | 1027 通過，6 略過 |
| 結構式函式庫 | 333 通過 |
| 訓練範本與推論服務（含 TensorFlow） | 56 通過 |
| 合成資料、假模型服務、匯入 CLI | 46、46、13 通過 |
| 網頁單元 | 370 通過 |
| S0 smoke（10 個情境） | 17 通過，1 略過（監控告警，由 kind 測試驗證） |
| 經 Gateway 驗收 | 99 通過，0 失敗（另 16 個是 kind 測試） |
| kind 叢集 | 16 通過 |
| Playwright 全套，Chromium 與 Edge | 156 通過，0 失敗 |
| 教學流程 TC-D02-03，Chromium 與 Edge | 12 通過 |
| 監控儀表板瀏覽器版 TC-C02-03 | 通過 |
| OHIF 經 Keycloak 登入顯示影像 | 通過（手動腳本） |
| 合規：授權清單、映像內套件、來源、8 類稽核、監控覆蓋、機密、掃毒 | 全部通過 |
| 備份還原演練 TC-D02-02（完整整合環境） | 通過：238 項筆數差異 0，含物件 556 個與 Orthanc 影像；還原後身分與權限驗收 12 通過 |
| 合規：映像漏洞（只報告） | 26 個映像，CRITICAL 99、HIGH 1279，多為上游基底映像的作業系統套件 |

第二輪（網頁佔位頁、後端缺口、批次推論背景化）合併後，除備份還原演練與漏洞掃描沿用 2026-09-30 第一輪的結果外，以上全部重跑。開發機只有 12 GB 記憶體：完整整合環境加 kind 叢集時剩不到 2 GB，要先停掉整合環境（`docker compose -p ai-full stop`）再跑單元與瀏覽器測試。

## 1. 下一步

- [ ] 甲方確認第二節的事項；答案與預設不同的項目要回頭改
- [x] 網頁補上訓練設定頁、模型匯出與部署頁（2026-09-30，`2026-09-30-m2-web-pages.md`；教學流程第 4 段已能完整示範）
- [x] 網頁：隱藏欄位改存後端、研究清單分頁、專案管理的 GPU 群組改成選單（2026-09-30，`2026-09-30-backend-gaps.md`）
- [x] 刪除專案時一併清除 HAPI FHIR 內該專案的資料，並取消叢集中排隊與執行中的工作（2026-09-30）
- [x] 刪除專案與種子重設在有 LLM 資料時於 PostgreSQL 失敗（2026-09-30 整合時發現並修正；模型下載核准紀錄保留）
- [x] OHIF 在真的瀏覽器經 Keycloak 登入後顯示影像（2026-09-29，完整整合環境，md01 開 ACC0001）。OHIF 依病歷號查「同病人其他研究」會被 Gateway 以 403 擋下，這是刻意的（避免跨專案列出研究），所以歷史研究清單只會有當前研究
- [x] 批次推論改成 Kubernetes Job 背景執行（2026-09-30，`2026-09-30-async-inference.md`；上傳推論與線上呼叫仍同步）
- [ ] 映像漏洞：與甲方議定門檻與修補期限後，把 Trivy 從「只報告」改成「超過門檻即失敗」
- [x] `cgr.dev/chainguard/minio:latest` 改成以 digest 釘版本（2026-09-30）
- [ ] 刪除專案時停止該專案已部署的線上推論服務（目前不停）
- [ ] 網頁：非 Admin 沒有列帳號的 API，授權使用者要手動輸入帳號；部署 API 不回傳模型名稱；網頁上不能試呼叫部署；訓練紀錄清單沒有分頁
- [ ] 批次推論：結果以一個 JSON 回傳，上限 256 MB，數萬張影像的批次要改分段上傳；批次完成後 jobs 表要等有人列出工作才更新狀態；工作頁顯示原始代碼 inference、inference-cpu
- [ ] 甲方環境部署（見第四節）
- [ ] AutoML：暫不導入，之後再評估；評估結果與建議做法（Optuna 搜尋現有 scikit-learn 範本）見 `docs/superpowers/plans/2026-10-03-automl-evaluation.md`
- [ ] GPU 實際運算：依等級分群與張數上限、GPU 訓練映像、vLLM，見 `docs/superpowers/plans/2026-10-05-gpu-enablement.md`
  - [x] 軌 B 的 B1–B6：GPU 訓練映像 `platform-trainer-gpu`（`platform/training/Dockerfile.gpu`）、Keras 後端可切換、GPU 上的重現性、平台的影像工作改用 GPU 映像、部署腳本與合規清單、A-01 驗收劇本（2026-10-11）
  - [ ] B7：在 K8s 上以真 GPU 跑訓練 Job 並計時（甲方主機，或本機 kind 接真 GPU）
  - [ ] 結構式訓練改走 CPU 池（計畫 B4 的一部分）：會改變 M1 已驗證的排程行為與 TC-B05-01 的排隊測試，驗收後再做；目前結構式訓練仍排在 GPU 群組，但用 CPU 映像
  - [ ] GPU 映像的記憶體上限：影像訓練 Job 的記憶體上限是 2 GB（`MEMORY_MB`）。2026-10-11 在開發機真 GPU 上實測，合成資料的影像分類（100 張、32×32）訓練程序峰值 1749 MB，已達上限的 85%，真實資料會更多。甲方安裝時要調高影像 Job 的記憶體（建議 8 GB 以上），並同時調高 GPU 池 Kueue 的記憶體配額（目前 2Gi）；kind 的排隊測試依賴目前的數字，所以先不改
- [ ] Windows 開發機（WSL2）的 NVIDIA 驅動從 572.83 升級到 R580 以上：目前只支援到 CUDA 12.8，PyTorch 2.14 與 vLLM 0.31 的預設版本需要 CUDA 13。升級前開發與正式映像一律用 CUDA 12.8（2026-10-05 決定暫不升級）。升級後重測 TensorFlow 2.22 正式版（2.22.0rc0 已認得 sm_120，但在 572.83 + CUDA 12.9 下配置記憶體失敗）；可用的話 GPU 訓練映像從 NGC TF 25.02（TF 2.17，已停止更新）改回官方 TF

## 2. 需要甲方確認

- [ ] 角色預設權限表（`platform/api/app/permissions.py`）
- [ ] 8 個功能入口依權限顯示的規則（`platform/web/src/access/entries.ts`）
- [ ] M1 驗收時，M2 模組的佔位頁面是否算「入口點擊成功」（TC-A02-01）
- [ ] C-03 的「租戶」對應 A-03 的「專案」（目前採用）還是「單位」
- [ ] 影像訓練一律用 Keras 輸出 H5
- [ ] GPU 訓練映像以 NVIDIA NGC TensorFlow 25.02（TF 2.17，NVIDIA 已停止更新）為基底：受 NVIDIA Deep Learning Container License 規範；官方 TensorFlow 不支援 Blackwell，所以版本比 CPU 映像（TF 2.21）舊；GPU 上的逐位元重現只保證同一張卡、同一映像
- [ ] MONAI Label 是否算「Clara 等級或同等」（B-03）
- [ ] M1、M2 測試資料基線由甲方提供，還是可用乙方準備的公開或合成資料
- [ ] 影像：匯入需 Labeling 權限；只有 Admin 能設定 Accession 清單，空清單代表不限制；清單外的影像可匯入但看不到；重複影像以 SOP Instance UID 在專案內判斷；DICOMweb 唯讀
- [ ] 排程：GPU 群組變更記在「專案」類稽核；只有共享池有時間上限；同佇列兩次送出間隔至少約 1 秒
- [ ] Keycloak 帳號 email 目前用 `帳號@users.invalid` 佔位，是否需要真實 email
- [ ] 甘特圖仍寫「MIG 靜態切分」，請甲方修正
- [ ] 書面需求清單（環境、PACS 測試介面、網域與憑證、對外網路與模型 Token 等）逐項註明期限；逾 15 日未提供須書面催告

2026-09-29 開發時採用的預設與裁定（細節見各計畫檔的「裁定」段落）：

- [ ] 標註：自動標註工具採 MONAI Label 介面，換工具只改 `AUTOLABEL_URL`；格式規格 1.0 只涵蓋 2D 單張影像（`docs/specs/autolabel-io-format.md`，需甲方書面簽認）；標註只存平台，不寫回 Orthanc
- [ ] 標註：CSV 自動分類時同一鍵出現兩種診斷就不寫入；重新上傳 CSV 會更新先前的 CSV 標註
- [ ] 訓練：匯出與修改原始碼需 Coding 權限，執行修改後的原始碼另需 Training；排隊中的訓練在來源被刪時仍用凍結資料完成
- [ ] 部署：線上服務只依部署的使用者清單授權，不看專案角色；查無部署與無權限都回 403
- [ ] FHIR：讀取需專案的 Project 權限；來源、對應、排程、寫入、Gateway 路由管理只限 Admin
- [ ] FHIR：平台寫入都帶租戶標記；外部系統經 Gateway 做條件式寫入也必須帶同一標記（HAPI 條件式寫入的 URL 表跨租戶共用）
- [ ] FHIR：所有寫入都經 HAPI 驗證，Transaction 的每筆 entry 都要有 `fullUrl`
- [ ] FHIR：Gateway 以設定檔運作、沒有管理後台；「修改路由」以平台的路由政策實作（啟用、方法、告警門檻）
- [ ] FHIR：流量告警為每人每專案每分鐘超過 120 次，最多每分鐘寄 1 封，不阻擋；排程在 worker 停機期間錯過的執行不補跑
- [ ] LLM：發布的 API 以平台帳號清單授權，外部系統各需一個 Keycloak 帳號（另一選項是 API 金鑰）
- [ ] LLM：只有 Admin 能核准模型下載（可考慮另設審核角色）；正式環境的模型來源與離線預載目錄的交付方式未定
- [ ] LLM：Wiki.js 以一個服務帳號寫入，作者欄都是它；真正的使用者記在平台稽核
- [ ] 稽核類別：LLM 操作記「推論」、知識庫與 Wiki 記「資料集」、白名單與 Prompt 記「專案」、種子重設記「專案」、掃毒攔截記「資料集」
- [ ] 掃毒：掃毒服務中斷時一律拒絕上傳（503）；寫入物件儲存與 DICOM 匯入時都掃，另有排程掃描
- [ ] 合規：授權清單只涵蓋映像與套件；監控覆蓋只涵蓋 kind 叢集；備份不含模擬 PACS，Keycloak 以資料庫為準
- [ ] 核准的映像來源（`platform/compliance/policy/image-sources.yaml`）：新增 HAPI FHIR、OHIF、pgvector、MLflow、Wiki.js 官方映像
- [ ] 上傳大小：單檔 512 MB、解壓後 2048 MB（DICOM 也適用，可用環境變數調整）
- [ ] 重複上傳的影像補記來源路徑，讓標註配得到切片；資料庫裡不認得的權限字串改為忽略並記 log
- [ ] 「AI 模型部署」入口目前有 Prediction 就顯示，但部署與下載要 Training；是否改成需要 Training 才顯示
- [ ] 隱藏欄位設定是每位使用者、每個資料集各一份，不寫稽核
- [ ] 刪除專案時被取消的叢集工作不逐筆寫稽核（專案刪除與資料清理稽核已涵蓋）
- [ ] 批次推論一律走 Kubernetes Job（小批次也多幾秒啟動）；結構式批次跑在 cpu-data，所以訓練映像也要放在 CPU 節點；專案內有 Prediction 的人可以取消任何人的批次

## 3. 技術債與已知限制

- [ ] 被拒絕的操作（403、409）目前不寫稽核（合約未明確要求；選項與成本見 `2026-09-29-tech-debt.md`，建議只稽核被拒絕的寫入）
- [x] 種子資料重設沒有寫稽核（2026-09-29，tech-debt）
- [x] 刪除帳號或專案時，連帶移除的成員資格沒有逐筆寫稽核（2026-09-29，tech-debt）
- [x] 建立帳號失敗後的補償步驟如果也失敗，會蓋掉原本的錯誤（2026-09-29，tech-debt）
- [x] 資料庫存了不認得的權限字串會回 500（2026-09-29，改為忽略並記 log）
- [x] 補一個「經 API 刪除帳號後，用舊 token 呼叫得 401」的回歸測試（2026-09-29，單元與經 Gateway 各 1）
- [x] 刪除專案時，Orthanc 影像與物件儲存的檔案不會跟著刪（2026-09-29；清理失敗的部分記在 `storage_cleanup_tasks` 之後重試）
- [x] NIfTI 上傳沒有大小上限，也未防壓縮炸彈（2026-09-29）
- [x] MinIO 開發環境用 root 帳號（2026-09-29，API 改用最小權限帳號）
- [x] 同一研究先經 PACS 取回、再批次上傳時，重複影像不記檔案路徑（2026-09-29，改為補記路徑；見第二節）
- [x] OHIF 需要的 bulk data 路徑（2026-09-29，WP5a 在 Gateway 改寫 BulkDataURI）
- [ ] Orthanc 映像只有 amd64，在 M1 上是模擬執行
- [x] Starlette 的 httpx 棄用警告（2026-09-29，改用 httpx2，警告視為錯誤）
- [ ] 正式環境：關閉 Keycloak `directAccessGrantsEnabled`；CORS 改成甲方網域（含 DICOMweb 路由目前允許任何 localhost 埠）；所有開發密碼替換
- [ ] 已存在的舊堆疊要重新匯入 Keycloak realm（新增了 OHIF client），切換到 pgvector 映像前要 `down -v`
- [ ] 叢集的 Grafana 設 `GOMEMLIMIT`，否則瀏覽器登入就會被 OOMKilled（開發機已設 450MiB）

## 4. 只能在甲方環境驗證

- [ ] A-01：OS、驅動、CUDA、cuDNN、PyTorch、TensorFlow、GPU 偵測 3 次
- [ ] 真實 GPU 分配、DCGM 指標、獨占卡上無其他工作、時間片效能
- [ ] LLM 4-bit 與 8-bit 量化（bitsandbytes＋vLLM）
- [ ] 時間與效能指標：權限 10 秒生效、DICOM 查詢 30 秒、自動標註 30 秒、Playground 10 秒、首屏時間、FHIR 壓測延遲
- [ ] GPU 上的訓練速度與重現性、真實模型品質；LLM 真模型的回應時間
- [ ] 真實 PACS、HIS、生理監視器、Email 或通訊軟體
- [x] Edge 瀏覽器相容（TC-A02-08）：Linux 開發機裝 Edge 154 後 Playwright 40 項全過（2026-09-28）；甲方 Windows 環境可再抽測

## 5. 換機器開發

需要：git、uv、Node.js、Docker、kind（叢集測試）。完整整合環境加 kind 叢集實測約需 10 GB 記憶體、磁碟 80 GB 以上（訓練映像含 TensorFlow 約 6 GB）。

```bash
git clone https://github.com/henry3556108/fujen-hospital.git
cd fujen-hospital/platform/api && uv sync && uv run pytest -q
cd ../web && npm ci && npm test
cd ../deploy/local && docker compose up -d --build
docker compose exec -T api /app/.venv/bin/python -m app.seed
cd ../../acceptance && COMPOSE_PROJECT=ai-platform uv run pytest -q
```

- Linux 開發機（Ubuntu 24.04）：uv 用官方安裝腳本、Node.js 22 用 NodeSource、Docker 用官方 apt 套件庫、kind v0.33 與 kubectl 直接下載執行檔；Playwright 用 `npx playwright install --with-deps chromium` 與 `npx playwright install msedge`。
- 若開發機是 Proxmox LXC 容器，必須在主機開啟 nesting（`pct set <id> -features nesting=1,keyctl=1` 後重開容器），否則 Docker 無法掛載 overlay 與 /proc。開啟後 Docker、compose 與 kind 5 節點叢集都能正常運作（2026-09-29 實測，12 CPU、12 GB 記憶體）。
- 架構與資料流說明在 Claude Doc「MacBook 開發機實作計畫」，不在 repo 內。
- `docker pull` 卡住時，多半是 Docker Desktop 的憑證工具在等鑰匙圈授權，處理方式見 `platform/deploy/local/README.md`。
- 改了 Keycloak realm 設定要重新匯入，步驟同上 README。
- 所有密碼都是本機測試值，寫在種子腳本與 realm 設定裡，不可用於甲方環境。
