# 一鍵 clone＋部署的 Prompt

在甲方部署機（連得到 Kubernetes 叢集、有 docker、kubectl、Helm v4.3.0）開 Claude Code，把下面整段貼上。
先照下方「HTTPS clone 的權限」讓部署機能讀 repo。
`<>` 裡的值先換掉；不知道的留著，Claude 會在開始前問你。

```text
請幫我把 AI 模型開發管理平台部署到這台機器連著的正式 Kubernetes 叢集（命名空間 ai-platform）。

程式：https://github.com/henry3556108/fujen-hospital.git，分支 ui/redesign（私有 repo，已用 gh auth login 登入唯讀 token）。
- 若 ~/fujen-hospital 不存在就 clone 到那裡；已存在就在那裡 git fetch 後切到 ui/redesign 最新版。
- 原本工作目錄若有本地修改（甲方的網域、registry、SMTP、PACS 設定），先 git stash，切版本後 git stash pop，
  衝突一律保留甲方的值，並把衝突的檔案列給我看。

照 repo 內的文件做，順序以 SOP 為準：
- docs/delivery/部署SOP.md（流程、檢查點、停損）
- docs/delivery/升級說明-2026-11-10.md（升級步驟、驗證、退回）
- docs/delivery/部署說明.md（新安裝）

參數：
- 甲方 registry：<registry 位址，例如 harbor.hospital.local/ai-platform>
- 映像 tag：<例如 20261110>
- 平台網址：<https://平台網域>
- 驗證用帳號：PI <帳號>、MD <帳號>（密碼我會在需要時自己在瀏覽器輸入，不要問我密碼）

規則：
1. 開始前先做 SOP 第 0、1 節的檢查，告訴我是「新安裝」還是「升級」、目前的 Helm REVISION 與映像，
   並列出你接下來會執行的指令，等我回覆「開始」才動叢集。
2. 升級前一定要先完成資料庫備份（SOP 2B 步驟 1），沒有備份不准部署。
3. 映像不准用 dev tag；kustomize 輸出不准還有 CHANGE-ME 或 example.invalid。
4. 不要把任何密碼、Secret、token 印到畫面或寫進檔案；需要時用 kubectl 取值直接帶進指令。
5. 遇到 SOP 第 4 節的停損條件就停下來告訴我，建議是否 helm rollback，等我決定；不要在正式環境改程式碼。
6. 部署完照驗證 V1～V6 逐項檢查；需要瀏覽器登入的步驟（V1、V4、V5 的裝置登入）告訴我要點哪裡，我來操作。
7. 最後填好 SOP 第 5 節的完成紀錄表，存成 ~/部署紀錄-<日期>.md，並在聊天裡給我摘要。
```

## HTTPS clone 的權限

repo 是私有的，HTTPS clone 要帶 GitHub 憑證。用**只限這個 repo 的唯讀 token**，不要用個人帳號密碼、不要把 repo 改公開。

1. 有 repo 權限的人到 GitHub → 右上頭像 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token：
   - Repository access：Only select repositories → `henry3556108/fujen-hospital`
   - Permissions → Repository permissions → **Contents：Read-only**（其他不給）
   - Expiration：設到部署完成後（例如 30 天）
2. 在部署機登入（token 不會出現在指令紀錄）：
   ```bash
   gh auth login --hostname github.com --git-protocol https   # 選 Paste an authentication token，貼上 token
   gh auth setup-git                                          # 讓 git clone/pull 使用這個登入
   git ls-remote https://github.com/henry3556108/fujen-hospital.git ui/redesign   # 印出一行 commit 就成功
   ```
   部署機沒有 gh 時，直接 `git clone https://github.com/henry3556108/fujen-hospital.git`，Username 填 GitHub 帳號、Password 貼 token；
   不要把 token 寫進網址（會存在 `.git/config`）。
3. 部署完成、確定不再需要時，到同一頁 Revoke 這個 token。

## 為什麼這樣寫

- **先列指令再等「開始」**：正式環境的操作不可逆，讓負責人先看過。
- **備份是硬條件**：db-init 只新增表與欄位，但仍要能回到升級前。
- **不碰密碼**：Secret 與初始密碼只留在叢集裡，不進對話紀錄。
- **停損交給人決定**：rollback 會讓使用者看到的版本改變，由負責人判斷。
