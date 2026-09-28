# 驗收測試案例（可自動化）

依《契約附件冊 R2》驗收指標逐條轉成可執行的測試案例。每個案例的次數與判準照抄契約，不放寬。

- **ID**：`TC-<模組>-<序號>`，測試程式的函式名稱帶同一個 ID（例：`test_tc_a03_05_privilege_escalation`），測試報告可以直接對回本表。
- **地點**：`Mac` = 開發機上就能跑並當作自測證據；`Mac*` = Mac 上跑邏輯，數字要到甲方環境重跑才算數；`甲方` = 只能在甲方環境跑。
- **工具**：`pytest-api` = 經 Gateway 打 API；`pytest-unit` = 平台 API 單元測試；`playwright` = Chrome 與 Edge 瀏覽器測試；`script` = 專用腳本。
- 每個案例執行後都要輸出：時間戳、請求與回應摘要、必要時截圖，存到 `acceptance/reports/<日期>/<ID>/`。

## 共用測試基線（種子資料）

所有案例都從同一個乾淨基線開始，由 `seed` 指令一次建立，重跑前先清空。

| 項目 | 內容 |
|---|---|
| 專案 3 個 | `P1-lung-ct`（影像）、`P2-tabular`（結構式）、`P3-llm`（LLM） |
| 帳號 8 個 | `admin01`（Admin）；`pi01`（Principal Investigator）、`md01`（Medical Doctor）、`ra01`（Research Assistant）、`ca01`（Coder Assistant）、`vw01`（Viewer），以上 5 人都是 P1 成員；`user01`、`user02`（User，不屬於任何專案，用來測越權） |
| 角色預設權限 | Viewer：Project、Prediction；Medical Doctor：Project、Labeling、Prediction；Research Assistant：Project、Labeling、Training、Prediction；Coder Assistant：Project、Training、Coding、Prediction；Principal Investigator：全部 5 項（**需與甲方確認**） |
| GPU 群組 2 個 | `gpu-exclusive`（2 張）、`gpu-shared`（1 張，時間片） |
| 影像 | TCIA 20 個研究（至少 CT、MR）；MSD NIfTI 影像與標註 3 筆；ITK 標註 3 筆；makesense JSON 3 筆 |
| 結構式 | Synthea 匯出 3 份 CSV，各 100 筆、10 欄以上；另備一份含錯誤列的 `bad.csv` |
| Accession 清單 | 10 筆，取自上述 DICOM 標頭 |
| 文件 | PDF、DOCX、TXT、CSV、JSON、HTML 各 1 份 |

---

## 共用服務（統一身分、Gateway、稽核）

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-SS-01 | 平台登入走統一身分 | 8 個帳號各用 OIDC 登入 1 次 | 成功率 100% | pytest-api | Mac |
| TC-SS-02 | 未登入不可存取 | 不帶 token 呼叫 10 個受保護 API（含管理頁 API） | 成功 0 次，全部回 401 | pytest-api | Mac |
| TC-SS-03 | 偽造與過期 token | 用錯誤簽章、過期、別的 issuer 的 token 各呼叫 3 次 | 成功 0 次 | pytest-api | Mac |
| TC-SS-04 | 金鑰不外洩 | 掃描前端打包檔與所有 API 回應內容，比對 client secret、資料庫密碼、MinIO 金鑰 | 明文出現 0 次 | script | Mac |
| TC-SS-05 | 繞過 Gateway | 直接連平台 API、推論服務、HAPI FHIR、Orthanc 的內部位址各 10 次 | 成功 0 次（網路不可達或 401） | pytest-api | Mac |
| TC-SS-06 | 稽核紀錄格式 | 任意觸發 1 個寫入動作 | 紀錄含：誰、何時、類別、動作、對象、結果、來源 IP | pytest-unit | Mac |
| TC-SS-07 | 稽核不可被使用者修改 | 用 Admin 呼叫刪除或修改稽核紀錄 | 無此 API；資料庫帳號對稽核表只有 INSERT 與 SELECT | pytest-api | Mac |

## A-02 核心入口與網頁操作介面

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-A02-01 | 8 個功能入口 | admin01 登入，逐一點擊 8 個入口 | 點擊成功率 100%（M2 模組在 M1 時顯示頁面骨架，需與甲方書面確認） | playwright | Mac |
| TC-A02-02 | 入口依權限顯示 | vw01、md01、ca01 各登入 1 次 | 看到的入口與角色權限一致，差異 0 | playwright | Mac |
| TC-A02-03 | 3 帳號同時操作 | pi01、md01、ra01 同時在 P1 操作各 5 個動作 | 失敗 0 次 | playwright | Mac |
| TC-A02-04 | 跨專案隔離 | user01 以直接輸入網址與呼叫 API 存取 P1 資料 10 次 | 成功 0 次 | pytest-api | Mac |
| TC-A02-05 | GPU 獨占模式 | 以獨占模式送 1 件假訓練工作 | 狀態 排隊→執行→完成 正確；執行期間該卡無其他工作 | pytest-api | Mac* |
| TC-A02-06 | GPU 共享模式 | 以共享模式送 3 件假工作 | 3 件同時或輪流在共享卡上執行，狀態流轉正確 100% | pytest-api | Mac* |
| TC-A02-07 | 共享排程設定頁 | 在設定頁修改設定 3 次，每次重新載入 | 重新載入一致 100% | playwright | Mac |
| TC-A02-08 | 瀏覽器相容 | Chrome、Edge 各抽 10 頁 | 破版 0 頁；截圖存檔 | playwright | Mac |
| TC-A02-09 | 首屏時間 | 主要頁面各量 3 次第二次載入 | 依契約門檻；Mac 上只驗腳本可跑 | playwright | 甲方 |

## A-03 帳號、角色與權限管理

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-A03-01 | 專案 CRUD | admin01 新增、修改、刪除專案各 3 次 | 成功率 100%；每次都有「專案」類稽核 | pytest-api | Mac |
| TC-A03-02 | 帳號 CRUD | admin01 新增、修改、刪除帳號各 3 次 | 成功率 100%；Keycloak 同步；有「帳號」類稽核 | pytest-api | Mac |
| TC-A03-03 | 非 Admin 不可管理帳號 | pi01、user01 各嘗試新增帳號 5 次 | 成功 0 次；介面顯示無權限提示 | pytest-api + playwright | Mac |
| TC-A03-04 | 角色與權限一致 | 5 個角色各查詢自己的有效權限 | 與角色預設權限表差異 0 | pytest-api | Mac |
| TC-A03-05 | 越權操作 | vw01 嘗試 Training、Labeling、Coding 動作共 10 次 | 成功 0 次；提示顯示 100% | pytest-api + playwright | Mac |
| TC-A03-06 | 權限即時生效 | admin01 移除 ra01 的 Training 權限，立即（10 秒內）讓 ra01 送訓練 | 被拒；再加回後 10 秒內可送；重新登入 3 次差異 0 | pytest-api | Mac |
| TC-A03-07 | 移出專案即時生效 | 把 md01 移出 P1 後立刻存取 P1 | 被拒，不需重新登入 | pytest-api | Mac |
| TC-A03-08 | 重設密碼 | admin01 重設 ra01 密碼 3 次 | 新密碼登入成功；舊密碼登入成功 0 次 | pytest-api | Mac |
| TC-A03-09 | 稽核抽查 | 執行 TC-A03-01 到 08 後抽 20 筆稽核 | 缺漏 0；帳號、角色、權限、專案 4 類都有 | pytest-api | Mac |
| TC-A03-10 | Admin 標註群組與 Dashboard | admin01 建立標註群組，檢視 Account 與 Dashboard 頁 | 建立成功；頁面數字與資料庫一致 | playwright | Mac |

## B-01 數據管理與醫療影像匯入

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-B01-01 | 批次匯入需登入 | 未登入執行匯入程式 | 拒絕並提示登入；不上傳任何檔案 | script | Mac |
| TC-B01-02 | DICOM 批次匯入 | 匯入 TCIA 20 個研究到 P1 | 研究、序列、影像筆數差異 0；有「資料集」類稽核 | script + pytest-api | Mac |
| TC-B01-03 | 其他格式匯入 | 匯入 NIfTI、ITK、makesense 各 3 筆 | 解析失敗 0 | script | Mac |
| TC-B01-04 | 影像與標註配對 | 個別匯入與同時匯入各 3 次 | 配對錯誤 0；配到指定專案 | script + pytest-api | Mac |
| TC-B01-05 | 壞檔處理 | 匯入截斷的 DICOM、副檔名錯誤的檔案、空資料夾 | 單檔失敗不影響其他檔；錯誤清單列出檔名與原因 | script | Mac |
| TC-B01-06 | 重複匯入 | 同一批 DICOM 匯入 2 次 | 不產生重複影像（以 SOP Instance UID 判斷） | script | Mac |
| TC-B01-07 | DICOM 節點查詢取像 | 平台節點向模擬 PACS 送 C-FIND 與 C-MOVE | 30 秒內收到回應；中繼資料差異 0 | pytest-api | Mac*（真 PACS 在甲方） |
| TC-B01-08 | Accession 限制 | 用 10 筆清單建 P1；以網頁、API、DICOMweb 存取清單外影像各 5 次 | 清單外存取成功 0 次（含 OHIF 經 DICOMweb） | pytest-api | Mac |
| TC-B01-09 | 5 欄位篩選 | 以 Modality、Patient's Sex、Study Description、Study Date、Series Description 各篩 1 次 | 篩選不符 0 筆 | pytest-api | Mac |
| TC-B01-10 | CSV 上傳驗證 | 上傳 3 份正常 CSV 與 `bad.csv` | 3 份 300 筆成功；錯誤列攔截 100%，誤放行 0 | pytest-api | Mac |

## B-04 結構式資料與醫學統計

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-B04-01 | 描述統計與預覽 | 對 P2 的 CSV 取描述統計、分布、預覽 | 顯示值與 pandas 直接計算差異 0 | pytest-api | Mac |
| TC-B04-02 | 欄位顯示與隱藏 | 隱藏 3 欄、重新載入 | 狀態一致 | playwright | Mac |
| TC-B04-03 | Target 與 Feature | 設定 3 次，每次重新載入 | 一致 100% | pytest-api | Mac |
| TC-B04-04 | 補值與 One Hot | 對含缺值欄位補值、對類別欄位 One Hot | 結果與 scikit-learn 參考輸出一致 | pytest-unit | Mac |
| TC-B04-05 | 相關矩陣與散佈圖 | 產出各 1 次 | 失敗 0 | pytest-api | Mac |
| TC-B04-06 | 前處理方法清單 | 讀取前處理方法清單 | 不少於 50 種；與文件清單差異 0 | pytest-unit | Mac |
| TC-B04-07 | 4 種統計 | Logistic、Linear、Survival、Cox 各 1 次 | 各產出圖表與統計量；失敗 0；係數與 statsmodels、lifelines 參考值一致 | pytest-api | Mac |
| TC-B04-08 | 非數值與全空欄位 | 對文字欄、全空欄做統計 | 回清楚錯誤訊息，不回 500 | pytest-api | Mac |

## B-02 影像標註平台

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-B02-01 | 檢視工具列 | 10 個研究各操作排列、旋轉、WW/WC 3 次 | 失敗 0；預設器官窗不少於 3 組 | playwright | Mac |
| TC-B02-02 | 快捷鍵 | 5 組快捷鍵各觸發 1 次 | 動作正確 | playwright | Mac |
| TC-B02-03 | 標註評分 | 評分 10 筆後重新載入 | 差異 0 | playwright | Mac |
| TC-B02-04 | 三種標註 | 分類、分割、偵測各 10 筆 | 儲存 100%；重新載入差異 0 | playwright | Mac |
| TC-B02-05 | CSV 自動分類標註 | 以 CSV 診斷結果依病歷號或影像編號標註 10 筆 | 對齊錯誤 0 | pytest-api | Mac |
| TC-B02-06 | 標註後直接訓練 | 從標註頁建立訓練任務 3 次 | 建立成功 100% | playwright | Mac |
| TC-B02-07 | 無 Labeling 權限 | vw01 嘗試儲存標註 5 次 | 成功 0 次 | pytest-api | Mac |

## B-03 自動標註整合

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-B03-01 | 送出自動標註 | 送出 5 次 | 成功 100% | pytest-api | Mac |
| TC-B03-02 | 回存與顯示時間 | 量測回傳到平台顯示的時間 | 30 秒內儲存並顯示 | pytest-api | 甲方（Mac 只驗流程） |
| TC-B03-03 | 開啟編輯 | 在標註平台開啟自動標註結果並修改後儲存 | 儲存 100% | playwright | Mac |
| TC-B03-04 | 格式規格 | 比對輸入輸出格式與開工前確認文件 | 差異 0 項；不驗正確率 | pytest-unit | Mac |
| TC-B03-05 | 工具離線 | 自動標註服務停止時送出 | 回明確錯誤，不留下半筆結果 | pytest-api | Mac |

## B-05 自動訓練與模型匯出

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-B05-01 | 5 種訓練 | 影像分類、分割、偵測；結構式分類、迴歸各建立 1 次 | 建立與狀態流轉 100% | pytest-api | Mac（CPU 小模型） |
| TC-B05-02 | 訓練參數保存 | 設定影像範圍、Label、Resize、切分、隨機種子後重新載入 | 一致 100% | pytest-api | Mac |
| TC-B05-03 | 資料增強 6 項 | 設定旋轉、長寬位移、Shear、Zoom、水平翻轉、垂直翻轉 | 產生的設定檔與輸入差異 0 | pytest-unit | Mac |
| TC-B05-04 | 重現 | 以同一份設定重跑 3 筆 | 資料版本、設定、種子相同；評估指標差異 0 | pytest-api | Mac |
| TC-B05-05 | 匯出原始碼再跑 | 匯出原始碼 3 次，修改 1 個參數後在平台執行 | 匯出失敗 0；修改後能執行；執行容器內無平台憑證 | pytest-api | Mac |
| TC-B05-06 | 模型匯出 | 匯出 2 個 pkl、2 個 Keras H5 | 4 檔都能在平台外用 Python 載入並預測 | script | Mac |
| TC-B05-07 | 訓練資料被刪除 | 訓練排隊中刪除來源影像 | 訓練仍用凍結的資料版本完成，或明確失敗；不讀到新資料 | pytest-api | Mac |

## B-06 模型部署與推論服務

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-B06-01 | 批次推論 | 對 20 筆以上測試集批次推論 1 次 | 成功 100% | pytest-api | Mac |
| TC-B06-02 | 上傳檔案推論 | 上傳檔案推論 10 次 | 成功 100% | pytest-api | Mac |
| TC-B06-03 | 推論歷史 | 抽查 10 筆歷史，下載結果 5 次 | 缺漏 0；下載成功 | pytest-api | Mac |
| TC-B06-04 | 結果呈現 | 結構式 20 筆自動新增預測欄；影像 9 筆顯示分類或偵測結果 | 缺漏 0 | pytest-api + playwright | Mac |
| TC-B06-05 | 模型下載 | 下載 3 次 | 失敗 0 | pytest-api | Mac |
| TC-B06-06 | 線上部署授權 | 部署後授權帳號經 Gateway 呼叫 10 次、未授權 10 次 | 授權成功 100%；未授權成功 0；有「推論服務」類稽核 | pytest-api | Mac |

## B-07 大型語言模型與 RAG

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-B07-01 | 模型下載與刪除 | 從預載清單以名稱與 Token 下載、刪除 | 成功 100%；無對外網路時改離線預載 | pytest-api | Mac |
| TC-B07-02 | Prompt Template | 建立個人與公開 Prompt 共 6 筆、加 tag、搜尋 5 次 | 差異 0；他人看不到個人 Prompt | pytest-api | Mac |
| TC-B07-03 | Playground 對話 | Free Chat 與 Chat with Knowledge Base 共 20 則 | 回應後 10 秒內顯示；逾時 30 秒內提示重試 | playwright | Mac*（時間在甲方驗） |
| TC-B07-04 | 量化載入 | 4-bit、8-bit 各載入 1 次，設定 CPU、記憶體、GPU 類型 | 配置一致 100% | pytest-api | 甲方（Mac 只驗設定保存） |
| TC-B07-05 | 生成參數 | 設定 7 項參數後重新載入 | 一致 100% | pytest-api | Mac |
| TC-B07-06 | RAG 建庫 | 上傳 6 種格式文件建立向量庫並掛載 | 寫入失敗 0 份 | pytest-api | Mac |
| TC-B07-07 | 發布 API | 發布為內部服務，外部工具經 Gateway 呼叫 3 次 | 3 次都成功；未授權呼叫成功 0 | pytest-api | Mac |
| TC-B07-08 | 模型服務中斷 | Ollama 或 vLLM 停止時從 Playground 發問 | 30 秒內提示重試；不卡住頁面 | playwright | Mac |

## B-08 LangGraph 工作流與 Wiki 知識庫

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-B08-01 | LangGraph 工作流 | 建立含狀態管理與至少 3 個節點的工作流，執行 3 次 | 每次每個節點都有執行紀錄，缺漏 0 | pytest-api | Mac |
| TC-B08-02 | Wiki 編輯、版本、檢索 | 各操作 3 次 | 成功 100%；可回看舊版本 | pytest-api | Mac |
| TC-B08-03 | 工作流與 LLM 串接 | 工作流呼叫 LLM 1 次 | 紀錄含 LLM 請求與回應 | pytest-api | Mac |
| TC-B08-04 | Wiki 與 LLM 串接 | 以 Wiki.js API 取文件後交給 LLM 1 次 | 紀錄顯示走 Wiki API，不是向量檢索 | pytest-api | Mac |

## C-01 多台 GPU／CPU 伺服器管理

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-C01-01 | 節點納管 | 比對平台節點清單與 kubectl 節點清單 | 差異 0 | pytest-api | Mac（kind） |
| TC-C01-02 | GPU 群組 | 建立 2 個群組後重新載入 | 一致 100% | pytest-api | Mac |
| TC-C01-03 | 專案綁定群組 | 建專案時選群組 3 次，送訓練 | 綁定差異 0；Job 進入該群組的佇列 | pytest-api | Mac |
| TC-C01-04 | GPU Dashboard | 抽查 3 組執行中工作 | Project ID、Training ID、使用者與實際差異 0 | pytest-api | Mac*（假 GPU） |
| TC-C01-05 | 佇列排程 | 獨占池同時送 3 件 | 順序不符 0；遺失 0 | pytest-api | Mac* |
| TC-C01-06 | 負載平衡 | 網頁請求與資料清洗工作各送 5 次 | 分別落在 CPU 網頁節點與資料清洗節點，路由錯誤 0 | pytest-api | Mac |
| TC-C01-07 | 擴充 | 新增 1 個 kind 節點並加標籤 | 平台清單自動出現；設定一致 | script | Mac |
| TC-C01-08 | 工作取消與失敗 | 取消排隊中的工作、讓 1 件工作失敗 | 佇列不卡住，下一件照順序執行 | pytest-api | Mac |
| TC-C01-09 | GPU 偵測 | 真實 GPU 偵測 3 次 | 全部偵測、驅動衝突 0 | script | 甲方 |

## C-02 系統監控工具

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-C02-01 | 監控目標 | 比對 Prometheus 目標與已部署服務清單 | 差異 0（監控覆蓋檢查） | script | Mac |
| TC-C02-02 | 5 類指標 | 節點、Pod、CPU、記憶體、GPU 抽查 3 次 | 與來源差異 0；GPU 類在甲方驗 | script | Mac* |
| TC-C02-03 | 客製儀表板 | 1 個儀表板、2 種視覺效果、改更新頻率後重新載入 | 一致 100% | playwright | Mac |
| TC-C02-04 | 告警 | 觸發 3 類事件、3 條規則 | Mailpit 收到率 100%；抑制後重複 0 | script | Mac |

## C-03 HL7 FHIR 醫療資料交換平台

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-C03-01 | FHIR 資源 | Patient、Encounter、Observation 各 20 筆 | Validator 不通過 0 | pytest-api | Mac |
| TC-C03-02 | 經 Gateway | 經 Gateway 呼叫 20 次；繞過 10 次 | 成功 100%；繞過成功 0 | pytest-api | Mac |
| TC-C03-03 | Gateway 管理介面 | 用網頁管理介面查看與修改 1 條路由 | 修改生效 | playwright | Mac |
| TC-C03-04 | 4 種來源接入 | SQL、CSV、HL7 V2、JSON 各 1 批 | 筆數差異 0 | pytest-api | Mac |
| TC-C03-05 | 對應規則 | 建立 3 組對應規則 | 轉出資源與預期差異 0 | pytest-api | Mac |
| TC-C03-06 | 排程 | 3 條排程 | 執行時間偏差 5 分鐘內 | script | Mac |
| TC-C03-07 | 原子性 | 寫入中途中斷 3 次 | 每次不是整批寫入就是整批不寫，差異 0 | script | Mac |
| TC-C03-08 | 身分與多租戶 | OAuth2 取 token；用他租戶身分存取 10 次 | 他租戶成功 0 | pytest-api | Mac |
| TC-C03-09 | 審計日誌 | 抽 20 筆資料交換稽核 | 缺漏 0 | pytest-api | Mac |
| TC-C03-10 | 流量告警與關聯圖 | 製造異常流量；開啟 Resource 關聯圖 | 告警送出；圖形與資料差異 0 | script + playwright | Mac |
| TC-C03-11 | 擴充與壓測 | 水平擴充到 2 份，跑自動化精確度與壓測腳本 | 可用性檢測失敗 0；產出報告 | script | Mac*（數字在甲方） |
| TC-C03-12 | 生理監視器 | 送 100 筆模擬資料 | 轉成 Observation 寫入 100%；欄位差異 0 | script | Mac |
| TC-C03-13 | 不合格資料 | 送缺必填欄位、錯誤代碼的 HL7 V2 訊息 | 被拒並記錄原因，不寫入半筆 | pytest-api | Mac |

## D-01 軟體來源與資安合規

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-D01-01 | 授權清單 | Syft 產出所有映像與 Python 套件清單，比對授權清單文件 | 差異 0 | script | Mac |
| TC-D01-02 | 白名單外下載 | 從白名單外來源下載模型 5 次 | 成功 0 | pytest-api | Mac |
| TC-D01-03 | 核准下載紀錄 | 核准下載 3 次 | commit、hash、時間、使用者、Token 使用紀錄、審核人欄位缺漏 0 | pytest-api | Mac |
| TC-D01-04 | 遠端程式碼 | 載入夾帶程式碼的模型 3 次；管理者核准後 1 次 | 未核准執行成功 0；核准後可執行 | pytest-api | Mac |
| TC-D01-05 | 8 類稽核 | 帳號、角色、權限、專案、資料集、訓練、推論、資料交換各抽 3 筆 | 共 24 筆缺漏 0 | pytest-api | Mac |
| TC-D01-06 | 掃毒 | ClamAV 掃描上傳區，並放入 EICAR 測試檔 | 正常檔惡意 0；EICAR 被攔截 | script | Mac |
| TC-D01-07 | 映像漏洞與來源 | Trivy 掃描所有映像；檢查映像來源 | 非受限來源 0；非專案軟體 0 | script | Mac |

## D-02 教育訓練與交付文件

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-D02-01 | 部署演練 | 照部署說明從空環境部署一次 | 無法完成的步驟 0 | 人工 + script | Mac（kind）／甲方 |
| TC-D02-02 | 還原演練 | 備份後刪除資料，照還原說明還原 | 無法完成的步驟 0；資料筆數差異 0 | script | Mac／甲方 |
| TC-D02-03 | 示範可重現 | 依教材操作無程式碼流程 | 無法重現 0 | playwright | Mac |

## A-01 平台環境與底層庫建置（甲方環境）

| ID | 案例 | 步驟與資料 | 通過判準 | 工具 | 地點 |
|---|---|---|---|---|---|
| TC-A01-01 | 節點狀態 | 安裝後檢查所有節點 | Ready 100%；異常 0 | script | 甲方 |
| TC-A01-02 | 納管差異 | 比對納管清單與實際主機 | 差異 0 | script | 甲方 |
| TC-A01-03 | GPU 驅動與底層庫 | 偵測 GPU 3 次；驗 CUDA、cuDNN、PyTorch、TensorFlow | 全部偵測；驅動衝突 0 | script | 甲方 |
| TC-A01-04 | Python 套件 | 比對確認清單與實際安裝 | 差異 0；產出版本清單 | script | Mac（映像內）／甲方 |

---

## 每日自動檢查（不是契約案例，但會擋住問題）

| ID | 檢查 | 判準 |
|---|---|---|
| TC-DAILY-01 | 稽核覆蓋：跑完所有案例後統計 8 類稽核筆數 | 每一類大於 0 |
| TC-DAILY-02 | 監控覆蓋：已部署服務清單 vs 監控目標 | 差異 0 |
| TC-DAILY-03 | 全部案例彙整成測試報告，缺陷依阻斷、嚴重、一般分級 | 報告產出 |
