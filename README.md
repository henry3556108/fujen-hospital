# AI 模型開發管理平台｜系統架構導覽

依《AI 模型開發管理軟體平台 契約附件冊 R2（MIG 移除修訂版）》與開發時程甘特圖整理。

## 使用方式
直接用瀏覽器（Chrome、Edge）開啟 `index.html` 即可，不需要安裝或啟動伺服器。

## 專案結構
```
index.html          頁面骨架
src/data.js         所有內容：模組、子功能、驗收指標、架構分層、使用情境（要改內容就改這裡）
src/app.js          互動邏輯
src/styles.css      樣式（支援深色模式）
docs/               由 data.js 產生的 Markdown，方便討論、評論、放進版控
gen-docs.js         重新產生 docs：node gen-docs.js
```

## 修改內容
1. 編輯 `src/data.js`：
   - 模組 `subs`：`[子功能名稱, 內容說明, 驗收指標]`
   - 情境 `steps`：`[步驟說明, 負責模組編號]`
2. 重新整理瀏覽器即可看到變更。
3. 有安裝 Node.js 的話，執行 `node gen-docs.js` 同步更新 `docs/` 的 Markdown（`docs/04-待討論事項.md` 為手寫，不會被覆蓋）。

## 資料來源
- 附件一第 1 至 11 節、附件二
- 開發時程甘特圖（1.1 節）

## 平台程式碼

- `platform/`：平台實作（API、網頁、部署、測試工具），各子目錄有自己的 README。
- `docs/TODO.md`：開發追蹤（待辦、需甲方確認事項、技術債、換機器開發步驟）。
- `docs/test-cases/acceptance-test-cases.md`：依契約驗收指標整理的測試案例。
- `docs/superpowers/plans/`：各工作包的實作計畫與路線圖。
