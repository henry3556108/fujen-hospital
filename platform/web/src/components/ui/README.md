# components/ui 共用元件

照設計稿（`scratchpad/ui/png`＝A01～A08、`scratchpad/ui2/png`＝B 系列）做的版面元件。一律 `import { … } from '../../components/ui'`。
樣式在 `ui.css`，只用 `src/theme/tokens.css` 的變數（色彩、`--font-size-*`、`--radius-*`、`--space-*`、`--layout-*`），**不要寫色碼**（tokens.test 會擋）。淺色／深色兩套都由 token 切換。
測試：`tests/unit/ui/`。

## 外框（AppLayout，已套用，頁面不用處理）
- 左側深藍側欄：logo「醫學研究平台」、項目（圖示＋文字，選中亮藍底白字）、底部「功能目錄」；管理區最上方「返回研究區」。標註工作台 `/labeling/studies/*` 自動收窄成圖示＋小字（A03）。
- 頂列：左「目前專案」下拉（`select#project-switcher`）；右「帳號・身分 ⌄」選單（個人設定）＋「登出」。
- 內容區 padding 已有，頁面最外層直接放 `PageHeader`。

## 元件

| 元件 | 用途 | 主要 props | 設計稿 |
|---|---|---|---|
| `PageHeader` | 頁標題 28px＋灰色副標，右上主要動作；可放麵包屑、下方分頁 | `title, subtitle?, actions?, breadcrumbs?: {label,to?}[], children?` | A01～A08 標題列；A07「使用模型 › 模型結果」 |
| `Card` | 白底卡片，左上標題、右上「查看全部 ›」 | `title?, extra?, children, footer?, flush?`（放表格用 flush）`, headingLevel?` | A01 最近處理／可使用的模型、B17 待處理事項／系統狀態 |
| `StatTile` | 統計方塊：圖示方塊＋標籤＋大數字，可點時右側 › | `label, value, unit?, icon?, tone?, hint?, onClick? \| to?` | B17 頂端四格 |
| `Stepper` | 圓圈數字＋連線＋文字；完成＝青綠勾、目前＝藍底數字 | `steps: {label, description?}[], current`（0 起算；=length 全完成）`, label?` | A01 資料→標註→結果、A06 頂端三步 |
| `OptionCard` / `OptionCardGroup` | 卡片式單選（原生 radio） | `name, value, title, description?, icon?, selected, disabled?, onSelect`；Group：`legend, hideLegend?` | A06「1. 選擇研究目的」 |
| `SplitLayout` + `SidePanel` + `InfoList` | 主內容＋右側資訊／編輯欄（窄螢幕移到下方）；欄位清單 | Split：`side, sideWidth?`；Panel：`title, actions?, onClose?, footer?, sticky?`；InfoList：`items: {label,value}[]` | A04 資料集資訊、A06 送出前確認、B02 設定詳情（複製／修改／刪除放 actions） |
| `SlideOver` | 從右滑出的面板，遮罩、Esc／點遮罩關閉、焦點管理 | `open, title, onClose, children, footer?, width?, closeOnBackdrop?` | A02「加入資料」、逐筆詳情 |
| `ProgressBar` | 單條進度（預設青綠） | `value, max, label, showValue?, showPercent?, tone?: secondary\|primary\|pending, hideLabel?` | A01「已確認 92 / 120」、A03 頂端 |
| `ConfirmProgress` | 已確認／待確認雙段＋百分比 | `confirmed, pending, total?, totalLabel?`（例「筆影像」）`, unit?` | A04 表格上方「120 筆影像｜已確認｜待確認」 |
| `SegmentBar` | 分段條（70/15/15） | `label, segments: {label,value,tone?}[]` | B02 資料切分、A06 資料分割 |
| `BarList` | 類別統計：● 名稱　數量（%）＋細橫條 | `items: {label,value}[], total?, label, emptyText?` | A04 類別統計／來源統計 |
| `Pagination` | 「顯示第 1–10 筆，共 N 筆」＋頁碼＋每頁筆數 | `page`（1 起算）`, pageSize, total, onPageChange, onPageSizeChange?, pageSizeOptions?` | A02、A04 表格下方 |
| `Toggle` | 開關（role=switch） | `checked, onChange, label, disabled?, hideLabel?` | A03「顯示標註範圍」 |
| `SegmentedTabs` | 頁內分頁（不換網址），底線式 | `items: {key,label}[], value, onChange, label, idPrefix?`；內容區用 `tabPanelId()` | A02 影像／表格、A03 分類／圈位置／塗範圍 |
| `Tabs`（既有） | 每頁一個網址的分頁，外觀已改成底線式 | `label, items: {to,label,end?}[]` | A04 待處理影像／標註資料集／自動標註、A07 |
| `Badge` | 淡底文字徽章（無圖示） | `tone: success\|warning\|error\|info\|neutral, children` | A02／A04「已確認」「待確認」「正常／異常」 |
| `StatusDot` | 圓點＋文字 | `tone, children` | B17「● 運作正常」「● 進行中」 |
| `StatusBadge`（既有） | 圖示＋文字徽章，需要強調時 | `tone, children` | — |
| `EmptyState` | 沒資料時的提示 | `title, description?, icon?, action?` | — |
| `DicomThumb` | 影像縮圖；進畫面才載入、失敗灰色佔位、卸載釋放 URL | `projectId, studyUid, seriesUid?, alt?, size?`（預設 56px） | A01 最近處理、A02 清單「影像」欄、A06 確認資料、A07 預測結果示例 |
| `CodeBlock` | 等寬、行號、右上「複製」 | `code, title?, language?, lineNumbers?, maxHeight?` | B08 流程程式碼、B11 Python 使用範例 |
| `Alert` / `ApiErrorAlert` / `ConfirmDialog` / `Icon`（既有） | 一併從 index 匯出 | — | — |

## 注意
- 按鈕沿用 `.btn--primary`（每區一個）／`.btn--secondary`（已改成白底藍框藍字，設計稿的次要按鈕）／`.btn--danger`。
- `Stepper` 的 label 不要自己加「1.」，編號由元件產生。區塊標題「1. 選擇研究目的」這類是內文標題，跟 Stepper 無關。
- `DicomThumb` 走 `${VITE_API_BASE}/dicomweb/projects/{pid}/studies/{study}/series/{series}/thumbnail`，帶目前登入的 Bearer token；沒給 series 會先查 `/studies/{study}/series` 取第一個（同研究只查一次）。測試裡用 `DicomThumbView`（自己給 `base`、`getToken`）。
- 新圖示：`lungs upload download database image check copy refresh external logout clock chevron-down/left/right`。
- 深色主題：`<html data-theme="dark">`；`data-theme="light"` 強制淺色；不設定時跟隨系統。
