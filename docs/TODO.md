# 開發追蹤

最後更新：2026-09-29。路線圖細節見 `docs/superpowers/plans/2026-09-28-roadmap.md`，驗收案例見 `docs/test-cases/acceptance-test-cases.md`。
勾選方式：完成就把 `[ ]` 改成 `[x]`，並在行尾註明 commit 或日期。

## 目前狀態

| 工作包 | 範圍 | 狀態 | 測試 |
|---|---|---|---|
| WP1a | 平台 API 核心：身分、專案、帳號、權限、稽核、授權檢查 | 完成 | 單元＋經 Gateway 驗收 |
| WP1b | 網頁殼：登入、8 個入口、帳號管理 | 完成 | 單元 152、Playwright 20、真環境 E2E 3 |
| WP2 | 影像匯入：Orthanc ×2、MinIO、匯入 CLI、DICOMweb 經 Gateway | 完成 | 經 Gateway 驗收 16 |
| WP3 | 結構式資料：CSV 驗證、統計、66 種前處理 | 完成 | 函式庫 199、經 Gateway 驗收 7 |
| WP4 | 排程與監控：kind、假 GPU、Kueue、GPU Dashboard、告警 | 完成（compose 的 API 可接 kind 叢集） | kind 叢集 15 |
| WP5 | 影像建模主線：OHIF、訓練範本、MLflow、推論 | 未開始 | — |
| WP6 | HL7 FHIR 資料交換 | 未開始 | — |
| WP7 | LLM、RAG、LangGraph、Wiki、模型白名單 | 未開始 | — |
| WP8 | 合規與交付：SBOM、掃毒、稽核覆蓋、備份還原 | 未開始 | — |

一鍵測試：`platform/scripts/test-all.sh`（`--e2e` 加 Playwright，`--docker` 加經 Gateway 驗收，`--kind` 加 kind 叢集測試）。S0 smoke 走 10 個情境主幹：9 項通過、8 項標為待開發工作包。

全部測試（2026-09-28）：平台 API 單元 360、經 Gateway 驗收 34（另 15 個需 kind 叢集）、網頁 152、結構式函式庫 199、合成資料 43、假服務 45、匯入 CLI 13、smoke 1。
Linux 開發機（Proxmox LXC，nesting 開啟後）2026-09-29：經 Gateway 驗收 34 通過、kind 叢集 15 通過；compose 的 API 接上 kind 後，經 Gateway 送出的訓練工作在 gpu-exclusive 節點以 Kubernetes Job 跑完。

## 1. 下一批開發

WP5、WP6、WP7 彼此獨立，可以平行；WP8 放最後。

- [x] 把 compose 的 API 接上 kind 叢集：`platform/deploy/kind/connect-compose.sh`（產生 kubeconfig、套用 `compose.kind.yaml`），做法見 `platform/deploy/kind/README.md`（2026-09-29）
- [ ] WP5 影像建模主線（依賴 WP2、WP4）
  - [ ] OHIF 檢視器與標註存回平台（分類、分割、偵測、評分、快捷鍵、器官窗）— TC-B02
  - [ ] 自動標註串接（先接 `platform/fakes` 的 fake-autolabel，再換 MONAI Label）— TC-B03
  - [ ] 資料版本凍結，確保「重現差異 0」— TC-B05-04、07
  - [ ] 5 種訓練範本：影像用 Keras 輸出 H5，結構式用 scikit-learn 輸出 pkl；「匯出原始碼」＝匯出範本與設定 — TC-B05
  - [ ] fake-trainer（本機建立極小模型，不下載）
  - [ ] 結構式前處理拆成「在訓練資料上擬合、套用到測試資料」，避免資料洩漏
  - [ ] MLflow、推論服務映像、批次推論、部署與授權呼叫 — TC-B06
  - [ ] 使用者修改後的原始碼只在 Job 容器內執行，不掛任何憑證
- [ ] WP6 FHIR：HAPI FHIR、4 種來源 ETL、對應規則、排程、Transaction 原子性、監視器轉 Observation、關聯圖、壓測 — TC-C03（合成資料已備好：`platform/tools/synth clinical`、`vitals`）
- [ ] WP7 LLM：白名單下載與審核紀錄、OpenAI 相容介面（Mac 接 Ollama／fake-llm，正式接 vLLM）、Prompt Template、Playground、生成參數、6 種格式 RAG、發布 API、LangGraph、Wiki.js — TC-B07、B08、D01-02～04
- [ ] WP8 合規與交付：Syft 與 Trivy、ClamAV、授權清單、稽核 8 類每日覆蓋檢查、監控覆蓋檢查、備份與還原腳本、部署與還原演練 — TC-D01、D02、DAILY
- [ ] 網頁補上：共享排程設定頁（TC-A02-07）、GPU Dashboard、監控儀表板的 Playwright 版（TC-C02-03）、影像與結構式資料頁面

## 2. 需要甲方確認

- [ ] 角色預設權限表（`platform/api/app/permissions.py`）
- [ ] 8 個功能入口依權限顯示的規則（`platform/web/src/access/entries.ts`）
- [ ] M1 驗收時，M2 模組的佔位頁面是否算「入口點擊成功」（TC-A02-01）
- [ ] C-03 的「租戶」對應 A-03 的「專案」（目前採用）還是「單位」
- [ ] 影像訓練一律用 Keras 輸出 H5
- [ ] MONAI Label 是否算「Clara 等級或同等」（B-03）
- [ ] M1、M2 測試資料基線由甲方提供，還是可用乙方準備的公開或合成資料
- [ ] 影像：匯入需 Labeling 權限；只有 Admin 能設定 Accession 清單，空清單代表不限制；清單外的影像可匯入但看不到；重複影像以 SOP Instance UID 在專案內判斷；DICOMweb 唯讀
- [ ] 排程：GPU 群組變更記在「專案」類稽核；只有共享池有時間上限；同佇列兩次送出間隔至少約 1 秒
- [ ] Keycloak 帳號 email 目前用 `帳號@users.invalid` 佔位，是否需要真實 email
- [ ] 甘特圖仍寫「MIG 靜態切分」，請甲方修正
- [ ] 書面需求清單（環境、PACS 測試介面、網域與憑證、對外網路與模型 Token 等）逐項註明期限；逾 15 日未提供須書面催告

## 3. 技術債與已知限制

- [ ] 被拒絕的操作（403、409）目前不寫稽核（合約未明確要求）
- [ ] 種子資料重設沒有寫稽核
- [ ] 刪除帳號或專案時，連帶移除的成員資格沒有逐筆寫稽核
- [ ] 建立帳號失敗後的補償步驟如果也失敗，會蓋掉原本的錯誤
- [ ] 資料庫存了不認得的權限字串會回 500
- [ ] 補一個「經 API 刪除帳號後，用舊 token 呼叫得 401」的回歸測試
- [ ] 刪除專案時，Orthanc 影像與物件儲存的檔案不會跟著刪（影像與結構式資料都是）
- [ ] NIfTI 上傳沒有大小上限，也未防壓縮炸彈
- [ ] MinIO 開發環境用 root 帳號
- [ ] 同一研究先經 PACS 取回、再批次上傳時，第二次被判為重複而不記檔案路徑，makesense 標註因此配不到這些切片（S0 smoke 發現；需決定重複上傳時是否補記路徑）
- [ ] OHIF 需要的 bulk data 路徑（Orthanc `PublicRoot`）留到 WP5
- [ ] Orthanc 映像只有 amd64，在 M1 上是模擬執行
- [ ] Starlette 的 httpx 棄用警告
- [ ] 正式環境：關閉 Keycloak `directAccessGrantsEnabled`；CORS 改成甲方網域；所有開發密碼替換

## 4. 只能在甲方環境驗證

- [ ] A-01：OS、驅動、CUDA、cuDNN、PyTorch、TensorFlow、GPU 偵測 3 次
- [ ] 真實 GPU 分配、DCGM 指標、獨占卡上無其他工作、時間片效能
- [ ] LLM 4-bit 與 8-bit 量化（bitsandbytes＋vLLM）
- [ ] 時間與效能指標：權限 10 秒生效、DICOM 查詢 30 秒、自動標註 30 秒、Playground 10 秒、首屏時間
- [ ] 真實 PACS、HIS、生理監視器、Email 或通訊軟體
- [x] Edge 瀏覽器相容（TC-A02-08）：Linux 開發機裝 Edge 154 後 Playwright 40 項全過（2026-09-28）；甲方 Windows 環境可再抽測

## 5. 換機器開發

需要：git、uv、Node.js、Docker（建議 8 GB 以上記憶體給 Docker）、kind（WP4 叢集測試）、磁碟 30 GB 以上。

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
