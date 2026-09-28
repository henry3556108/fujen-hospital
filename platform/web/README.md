# 平台網頁（WP1b Web Shell）

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
- 模擬資料只存在記憶體，**重新整理頁面就回到種子資料**。
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

Keycloak client 需允許 redirect URI `http://localhost:5173/*`（登入回呼為 `/auth/callback`，登出後回 `/login`），
Gateway 需允許來自 `http://localhost:5173` 的 CORS。API 回 401 時，前端會清除登入狀態並回到登入頁。

## 測試

```bash
npm test              # Vitest 單元／元件測試（含 token 對比度、正式打包不可用測試登入）
npm run test:e2e      # Playwright：自動啟動 dev server（port 5199，模擬 API + 測試登入）
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
src/pages/              登入、回呼、首頁、M2 骨架頁、無權限頁、Admin（專案／帳號／專案成員／共享排程設定骨架）
src/mocks/              MSW 模擬 API 與種子資料
tests/unit/             Vitest
e2e/                    Playwright
```

## 待確認事項

1. 入口可見規則（`src/access/entries.ts`）需與甲方確認。
2. M2 模組在 M1 顯示骨架頁（「此功能將於 M2 提供」＋模組代碼）是否算 TC-A02-01 點擊成功。
3. 後端尚無「列出專案成員」API，專案成員頁只能列出本次操作過的成員。
4. 共享排程設定頁（TC-A02-07）等 WP4 API，目前只有骨架。
