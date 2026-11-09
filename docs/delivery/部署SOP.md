# 正式環境部署 SOP

給在甲方正式環境部署或升級平台的人照著做。每一步做完打勾，並把「紀錄」欄填好；最後的紀錄表交回給專案負責人。
指令細節：新安裝看 `部署說明.md`「甲方正式環境」，既有環境升級看 `升級說明-2026-11-10.md`。本 SOP 只管順序、檢查點與停損。

## 0. 事前準備（部署前一天）

| ✔ | 項目 | 檢查方式 | 紀錄 |
|---|---|---|---|
| ☐ | 和院方約好離峰時段，通知使用者平台會暫停約 10 分鐘 | — | 時段： |
| ☐ | 部署機有 `git`、`docker`、`kubectl`（1.27+）、Helm **v4.3.0**、`python3`（含 PyYAML） | `helm version`、`kubectl version --client` | |
| ☐ | 部署機連得到叢集，context 正確 | `kubectl config current-context`、`kubectl get nodes` | context： |
| ☐ | 部署機拿得到程式（GitHub 讀取權限，或 bundle 檔） | `git ls-remote git@github.com:henry3556108/fujen-hospital.git ui/redesign` | commit： |
| ☐ | 有甲方 registry 的推送權限 | `docker login <registry>` | registry： |
| ☐ | 知道甲方的網域、TLS 憑證、SMTP、PACS 設定放在哪（升級時就是部署機上既有的 `overlays/production`） | — | |

## 1. 判斷是新安裝還是升級

```bash
kubectl get namespace ai-platform && helm history ai-platform -n ai-platform | tail -3
```

- 命名空間不存在 → **新安裝**，做第 2A 節。
- 存在且有 Helm 版本 → **升級**，做第 2B 節。記下最後一個 REVISION：＿＿＿＿

## 2A. 新安裝

照 `部署說明.md`「甲方正式環境」步驟 1～8 做，另外：

| ✔ | 項目 | 成功的樣子 |
|---|---|---|
| ☐ | 映像用日期當 tag（例如 `20261110`），不要用 `dev` | `kubectl kustomize overlays/production \| grep 'image:.*platform-'` 都是新 tag |
| ☐ | `./create-secrets.sh` 的輸出**不要**貼到聊天、工單或文件；admin01 初始密碼當面交給管理者 | — |
| ☐ | 部署後執行 LLM 模型下載（`部署說明.md` 與 `platform/deploy/k8s/README.md`「正式環境」第 6 點） | 模型管理裡 gemma-3-4b-it、embeddinggemma-300m 都是「已載入」 |

## 2B. 升級

照 `升級說明-2026-11-10.md`「步驟」0～10 做。檢查點：

| ✔ | 步驟 | 檢查點（不符合就停，不要往下做） | 紀錄 |
|---|---|---|---|
| ☐ | 0 記下目前版本 | 有 REVISION 與目前的 api、web 映像 | |
| ☐ | 1 備份資料庫 | 備份檔存在、大小不是 0 | 檔名： |
| ☐ | 2 取得程式 | `git log -1` 是預定的 commit | |
| ☐ | 3 保留甲方設定 | `kubectl kustomize overlays/production \| grep -c 'CHANGE-ME\|example.invalid'` 是 0，且網域仍是甲方的 | |
| ☐ | 4–5 建置並推送 4 個映像 | registry 看得到 api、web、trainer、trainer-gpu 的新 tag | tag： |
| ☐ | 6 改 tag | kustomize 輸出的 api、web 映像與 `TRAINING_IMAGE`、`TRAINING_GPU_IMAGE` 都是新 tag | |
| ☐ | 7 `./deploy.sh production` | 最後印「完成」 | 時間： |
| ☐ | 8 db-init | log 最後一行「db-init 完成…稽核表只有 SELECT、INSERT」 | |
| ☐ | 9 Pod | api、web、fhir-worker 都 Running 且是新映像 | |
| ☐ | 10 LLM 模型 | gemma-3-4b-it、embeddinggemma-300m 都「已載入」 | |

## 3. 部署後驗證

照 `升級說明-2026-11-10.md`「部署後驗證」V1～V6。新安裝時 V3～V5 需要先建一個測試專案並加入 PI、MD 帳號。

| ✔ | 驗證 | 結果 |
|---|---|---|
| ☐ | V1 網頁登入、新版版面 | |
| ☐ | V2 未登入 401 | |
| ☐ | V3 八、6 RAG 對話有出處 | |
| ☐ | V4 PI、Admin 都不能卸載 gemma，之後對話仍正常 | |
| ☐ | V5 八、8 照頁面步驟取得 Token，呼叫回 200；未授權 403 | |
| ☐ | V6 小型訓練成功 | |
| ☐ | 刪除驗證用的測試專案 | |

## 4. 停損與退回

遇到下列任一情況就停下來退回，不要在正式環境現場改程式：

- `deploy.sh` 失敗且重跑一次仍失敗；
- db-init 沒有印出「db-init 完成」；
- 部署後 15 分鐘內 api 一直 CrashLoopBackOff；
- V1～V5 任一項不通過且無法在 15 分鐘內判斷原因。

```bash
helm rollback ai-platform <第 1 節記下的 REVISION> -n ai-platform
kubectl -n ai-platform get pods          # 等 api、web Running
```

退回後做 V1、V2 確認舊版恢復；需要連資料一起回復時，依 `備份與還原說明.md` 用第 2B 節步驟 1 的備份還原。
把錯誤訊息（`kubectl -n ai-platform logs deploy/api --tail=200`、`kubectl -n ai-platform get events --sort-by=.lastTimestamp | tail -30`）存檔交給開發團隊。

## 5. 完成紀錄（交回）

| 項目 | 內容 |
|---|---|
| 部署日期時間 | |
| 部署人 | |
| 類型 | 新安裝／升級 |
| 程式 commit | |
| 映像 tag | |
| Helm REVISION（部署前 → 部署後） | → |
| 備份檔 | |
| V1～V6 結果 | |
| 是否退回、原因 | |
| 備註 | |
