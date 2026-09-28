# WP1b 網頁外殼（Web Shell）實作計畫

> 分支 `wp1b-web-shell`；只動 `platform/web/` 與本檔。不依賴 Docker 堆疊（WP1a 後端與 Keycloak 另有人建置）。

## 目標

Vite + React + TypeScript 前端：OIDC 登入／登出、App 外殼（專案切換＋8 個功能入口，依權限顯示並擋直接網址）、M2 模組骨架頁、Admin 管理頁（專案、帳號、專案成員）。全部可在「模擬 API＋測試登入」下開發與測試。

## 檔案結構

```
platform/web/
  package.json  vite.config.ts  vitest.config.ts  playwright.config.ts  tsconfig.json  index.html  README.md
  src/
    main.tsx               進入點：選 auth adapter、（開發時）啟動 MSW
    App.tsx                路由
    auth/
      adapter.ts           AuthAdapter 介面 + selectAuthMode()（production build 強制 oidc）
      oidcAdapter.ts       oidc-client-ts，Authorization Code + PKCE
      testAdapter.ts       測試用：以 localStorage 指定使用者名稱，token = "test-token:<username>"
      AuthContext.tsx
    api/
      client.ts            fetch 包裝：帶 Bearer、解析錯誤形狀（401/403/404/409/422）、401 → 回登入
      types.ts
    access/
      entries.ts           8 個入口 + 可見規則（單一模組，標註「需與甲方確認」）
    theme/
      tokens.css           三層 Token：Primitive → Semantic → Component，light / dark
      ThemeToggle.tsx
    components/            Button、ErrorMessage（icon + 文字）、ConfirmDialog、ProjectSwitcher …
    pages/                 LoginPage、CallbackPage、Home、ModulePlaceholder、AccessDenied、NotFound、
                           SchedulingPlaceholder、admin/ProjectsPage、admin/UsersPage、admin/MembersPage
    mocks/
      data.ts  handlers.ts  browser.ts  server.ts   MSW 模擬 /api/me 與 /api/admin/*
  tests/unit/*.test.ts(x)  Vitest + Testing Library
  e2e/*.spec.ts            Playwright（chromium、msedge；Edge 不存在時 skip 並說明）
```

## 任務（每項皆 test-first：先寫測試→看它因預期原因失敗→最小實作→通過→跑全套）

1. 專案骨架：Vite/React/TS、Vitest、jsdom、Testing Library、MSW；冒煙測試。
2. 入口可見規則 `access/entries.ts`（vw01、md01、ca01、admin01 表格測試）。
3. Auth adapter + 模式選擇；production build 不可啟用 test 模式（單元測試 `selectAuthMode` + build 產物掃描測試）。
4. API client：錯誤形狀解析、401 → 導回登入。
5. Design tokens（三層、light/dark）＋對比度測試（解析 tokens.css 計算 WCAG 對比）。
6. App 外殼：專案切換、8 入口、直接網址擋下 → 無權限頁（文字原因）、M2 骨架頁、排程設定骨架頁。
7. Admin 專案 CRUD（含 409/422/403 行內錯誤、刪除前確認）。
8. Admin 帳號 CRUD、改帳號類型、重設密碼。
9. Admin 專案成員：加入（角色）、5 個權限勾選（預設跟角色）、PUT body、移除。
10. Playwright：8 入口全點、viewer 入口、1280×800 與 375×812 截圖、dark mode、Edge project。
11. README（繁中）、§11 色彩檢查清單。

## 測試清單（名稱帶驗收 ID）

- `TC-A02-02 entry visibility` — vw01 / md01 / ca01 / admin01 與規則表一致（單元＋Playwright）。
- `TC-A02-04 / TC-A03-05 direct URL to hidden entry shows access denied with text`。
- `TC-A02-01 admin clicks all 8 entries`（Playwright）。
- `TC-A03-03 non-admin cannot open account admin`（無權限提示）。
- `TC-A02-08 layout at 1280x800 and 375x812`（截圖到 `platform/web/test-results/`；Edge 缺少時 skip）。
- Admin CRUD：建立／修改／刪除（確認對話框）、409、422、403 顯示文字＋icon。
- 成員權限：PUT body 正確；改角色→勾選重設為角色預設。
- 401 → 回登入頁。
- production build 不能使用 test auth 模式。
- Token 對比：light/dark 兩套文字 ≥ 4.5:1、UI 邊界 ≥ 3:1。

## 需與甲方確認／待決事項

1. **入口可見規則**（`src/access/entries.ts`）：帳號管理 → admin；數據管理 → project；影像標註、自動影像分類標註 → labeling；建模管理 → training；AI 模型部署、推論服務管理 → prediction；LLM No-code 開發 → coding；admin 全看得到。
2. **M2 模組在 M1 顯示骨架頁**是否算「點擊成功」（TC-A02-01 備註）。
3. **後端缺少「列出專案成員」API**（`GET /api/admin/projects/{id}/members`）：成員頁目前只能「指定專案＋帳號」設定角色／權限，並列出本次操作過的成員；無法顯示既有成員。需請 WP1a 補 API。
4. 共享排程設定頁（TC-A02-07）等 WP4 API，目前只放骨架頁。
5. 使用者沒有任何專案時：只顯示「尚未加入任何專案」，入口全隱藏（admin 除外）。
6. **Gateway CORS**：瀏覽器由 `http://localhost:5173` 呼叫 `http://localhost:9080/api/*` 屬跨來源，Gateway 需允許此 origin 與 `Authorization` header（交給 Docker 堆疊負責人）。

## 實作時的技術決定

- test 登入與 MSW 以編譯期常數 `__DEV_SERVER__`（`vite.config.ts`：`command === 'serve'`）把關，而非 `import.meta.env.DEV`：後者受 `NODE_ENV` 影響，在 `NODE_ENV=test` 下執行 `vite build` 時會是 true（測試實際抓到過）。
- MSW service worker 由 dev server 中介層提供，不放 `public/`，因此不會進入正式打包。
- 入口可見規則與直接網址阻擋共用 `checkAccess()`，以「目前選取專案」的權限判斷。
- Node 25 內建 `localStorage` 與 jsdom 衝突，Vitest 以 `--no-experimental-webstorage` 執行。
