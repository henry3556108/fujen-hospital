# 平台網頁（WP1b 外殼＋WP2／WP3／WP4 頁面）

Vite + React + TypeScript。登入走 Keycloak OIDC（Authorization Code + PKCE，public client `ai-platform-web`），
所有 API 經 Gateway 的 `/api/*`。本目錄可以在**沒有 Docker 堆疊**的情況下，用模擬 API 與測試登入開發與測試。

## 安裝

```bash
cd platform/web
npm ci
npx playwright install chromium   # 只裝 Chromium（瀏覽器測試用）
```

## 以模擬 API 執行（不需 Docker、不需 Keycloak）

```bash
npm run dev:mock
# 等同 VITE_AUTH_MODE=test VITE_API_MOCK=1 vite
```

開啟 <http://localhost:5173>，登入頁可選擇驗收基線的種子帳號（`admin01`、`pi01`、`md01`、`ra01`、`ca01`、`vw01`、`user01`、`user02`）。

- API 由 MSW 在瀏覽器內模擬（`src/mocks/`），路徑、狀態碼與錯誤形狀跟 `platform/api` 相同（401／403／404／409／422）。
- 帳號與專案的模擬資料只存在記憶體，重新整理就回到種子資料。排程、影像、結構式資料的模擬狀態存在 sessionStorage，
  同一個分頁重新載入後仍在（「儲存後重新載入一致」的流程才測得到），關掉分頁就清掉。
- 模擬 API 會實際解析上傳的 DICOM 標頭、依結構定義驗證 CSV、計算描述統計、分布、相關係數與部分前處理；
  4 種統計模型回傳從真實 API 擷取的固定結果（`src/mocks/tabularData.ts`），數字不隨選的欄位改變。
- 測試登入模式與 API 模擬**只在 dev server 有效**；任何 `vite build` 產物都不含這兩段程式（由 `tests/unit/prod-build.test.ts` 檢查）。

## 連接真實堆疊

Docker 堆疊（Gateway `:9080`、Keycloak `:8080`）啟動後：

```bash
VITE_API_BASE=http://localhost:9080 VITE_AUTH_MODE=oidc npm run dev
```

| 環境變數 | 預設值 | 說明 |
|---|---|---|
| `VITE_API_BASE` | 空字串（同源） | Gateway 位址 |
| `VITE_AUTH_MODE` | `oidc` | `test` 只在 dev server 有效，正式打包一律使用 `oidc` |
| `VITE_OIDC_AUTHORITY` | `http://localhost:8080/realms/ai-platform` | Keycloak issuer |
| `VITE_OIDC_CLIENT_ID` | `ai-platform-web` | public client，無 client secret |
| `VITE_API_MOCK` | 未設定 | `1` 時在 dev server 啟用 MSW |
| `VITE_GRAFANA_URL` 等 | kind 對外連接埠 | 監控儀表板頁的連結：`VITE_GRAFANA_URL`、`VITE_PROMETHEUS_URL`、`VITE_ALERTMANAGER_URL`、`VITE_MAILPIT_URL` |

Keycloak client 需允許 redirect URI `http://localhost:5173/*`（登入回呼為 `/auth/callback`，登出後回 `/login`），
Gateway 需允許來自 `http://localhost:5173` 的 CORS。API 回 401 時，前端會清除登入狀態並回到登入頁。

## 測試

```bash
npm test              # Vitest 單元／元件測試（含 token 對比度、正式打包不可用測試登入）
npm run test:e2e      # Playwright：自動啟動 dev server（port 5199，模擬 API + 測試登入）
npm run test:e2e:grafana   # TC-C02-03：操作 kind 叢集裡的真 Grafana；叢集不在時 skip
npm run typecheck
npm run build         # 正式打包到 dist/
```

- 測試名稱帶驗收 ID（例：`TC-A02-02 …`），可直接對回 `docs/test-cases/acceptance-test-cases.md`。
- 截圖存在 `test-results/screenshots/<瀏覽器>/<尺寸或模式>/<頁面>.png`（1280×800、375×812、dark、色覺模擬）。
- Playwright 有 `chromium` 與 `msedge` 兩個 project。未安裝 Microsoft Edge 的機器，`msedge` 的測試會標為 skipped，並印出原因；
  在有 Edge 的機器可單獨執行：`npx playwright test --project=msedge`。

## 目錄

```
src/access/entries.ts   8 個功能入口與可見規則（需與甲方確認；選單與直接網址阻擋共用）
src/auth/               登入抽象層：oidcAdapter（正式）、testAdapter（僅 dev server）
src/api/                API client（錯誤解析、401 回登入）與型別
src/theme/tokens.css    色彩 Token：Primitive → Semantic → Component，淺色／深色
src/styles/app.css      元件樣式（只引用 Token，不寫色碼；有測試檢查）
src/pages/              登入、回呼、首頁、M2 骨架頁、無權限頁、Admin（專案／帳號／專案成員）
src/pages/scheduling/   共享排程設定、GPU 群組、叢集節點、GPU Dashboard、監控儀表板入口（/admin/scheduling/*）、專案工作（/training/jobs）
src/pages/data/         「數據管理」入口（/data/*）與頁面權限判斷
src/pages/imaging/      研究列表（5 欄位篩選）、研究明細、匯入、匯入工作、檔案配對、Accession 清單、PACS 查詢取像
src/pages/tabular/      資料集、CSV 上傳驗證、預覽與欄位隱藏、描述統計、Target／Feature、前處理、相關與散佈圖、4 種統計
src/components/charts/  自製 SVG 圖表（直條、散佈、折線、森林圖、相關矩陣），每張圖都有表格檢視
src/mocks/              MSW 模擬 API 與種子資料（各模組一個檔案）
tests/unit/             Vitest
tests/fixtures/         合成 DICOM、NIfTI、ITK、makesense、CSV（由 platform/api 測試工具與 platform/tools/synth 產生）
e2e/                    Playwright（模擬 API）
e2e-grafana/            Playwright（kind 叢集的真 Grafana）
```

## 待確認事項

1. 入口可見規則（`src/access/entries.ts`）需與甲方確認。
2. M2 模組在 M1 顯示骨架頁（「此功能將於 M2 提供」＋模組代碼）是否算 TC-A02-01 點擊成功。
3. 後端尚無「列出專案成員」API，專案成員頁只能列出本次操作過的成員。
4. 結構式資料的欄位顯示／隱藏（TC-B04-02）存在瀏覽器 localStorage，換瀏覽器或電腦不會帶過去；若需跨裝置保存，要請後端提供 API。
5. kind 裡的 Grafana 記憶體上限 384 MiB，瀏覽器登入就會被 OOMKilled，`test:e2e:grafana` 在調高上限前跑不過。
