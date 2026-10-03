# 結構式資料上傳與欄位總覽（QOCA 改善 A 組）

**上層計畫：** `2026-10-03-qoca-ux.md` 的 A1～A3。分支 `ux-tabular-data`。
**使用者：** 醫師、護理與研究人員，不寫程式。上傳時不必寫 JSON；畫面用中文型態名稱，技術名詞旁附一行說明。

## API

### `POST /api/projects/{pid}/tabular/schema/infer`（新）

multipart：`file`（CSV）、`missing_values`（選填，JSON 字串陣列；省略時用預設清單）。權限 `project`，與上傳相同；檔案大小上限與病毒掃描（`app/scanning.py`）同上傳。不寫資料庫、不寫物件儲存、不寫稽核（沒有寫入）。

回應 200：

```json
{
  "row_count": 30,
  "encoding": "utf-8",
  "missing_values": ["NA", "N/A", "null", "NaN", "none", "-"],
  "schema": {"columns": [{"name": "age", "type": "int", "required": true, "min": 0, "max": 120,
                          "missing_values": ["NA", "..."], "...": "..."}]},
  "columns": [{"name": "age", "type": "int", "required": true, "missing": 0, "distinct": 28,
               "examples": ["62", "76", "35"], "non_conforming": 1, "observed_min": 26, "observed_max": 150,
               "rare_values": [], "identifier": false, "range_source": "name", "notes": ["..."]}],
  "report": {"valid_rows": 22, "total_rows": 30, "rejected_row_count": 8, "rejected": [], "errors": [], "warnings": []}
}
```

`report` 是以推斷結構跑一次驗證（預檢），與上傳回傳的報告同一形狀。
錯誤：413 檔案過大；422（`{"detail": {code, message, detail}}`）空檔、只有標題列、無法辨識的編碼、欄名空白或重複、`missing_values` 格式錯誤。

### `POST /api/projects/{pid}/tabular/schema/check`（新）

multipart：`file`、`schema`（JSON，與上傳相同）。回應 `{"report": ...}`，只預檢、不建立資料集。使用者在欄位表改了型態或必填後用它重新預檢。權限、大小上限、掃毒同上。

### 既有 API 的變更（皆為相容的擴充）

- `POST /datasets` 照舊接受明確的結構定義；結構定義的每個欄位可多一個選填的 `missing_values`（字串清單，不分大小寫，視為缺值）。沒有這個鍵的結構定義行為與以前完全相同（只有空白是缺值）。
- CSV 不是 UTF-8 時改以 Big5（cp950，台灣 Excel「另存 CSV」的預設）讀取，報告加一則提醒；兩者都失敗才回「檔案編碼無法辨識」。
- `GET /datasets/{id}` 的 `columns[]` 多一個 `unique`（不同值個數，不含缺值）。

## 推斷規則（`tabular.infer`）

保守原則：型態由**多數值**決定，少數不符合的格子不會讓型態放寬，而是在驗證時被拒絕並列出原因（TC-B01-10「攔截 100%、誤放行 0」）。

1. 缺值：空白一律是缺值；另外 `NA`、`N/A`、`null`、`NaN`、`none`、`-`（不分大小寫）預設視為缺值，可在畫面上修改。推斷出的結構把清單寫進每個欄位的 `missing_values`。必填欄位遇到缺值寫法仍會被拒絕。
2. 型態，依序判斷，門檻 90%（非缺值格子中能轉換的比例；30 列的檔案容許 3 格不符，bad.csv 同一種錯誤最多出現 2 次）：
   是否（`true/false/yes/no/是/否/y/n/t/f`，不含 0／1）→ 整數 → 小數 → 日期（`YYYY-MM-DD`）→ 文字類。
3. 文字類再細分：
   - 格式一致（數字串化成 `\d`，90% 以上相同，且含數字）→ 文字＋`pattern`，例如 `^P\d{5}$`。
   - 疑似識別碼：有格式、沒有缺值、不同值占 90% 以上 → `unique: true`（病歷號重複的列會被拒絕）。
   - 類別：不同值 ≤ 20 且不超過非缺值格數的一半 → `category`，`allowed` 只收出現至少 3 次（且 ≥ 0.5%）的值；出現 1、2 次的罕見值不列入，驗證時被拒絕並列出（20 列以下的檔案不判斷罕見值）。
   - 其他 → 文字。
4. 必填：這欄在檔案中沒有任何缺值 → 必填；有缺值 → 選填，畫面提示「如果這欄不該空白，請勾選必填」。
5. 範圍：
   - 欄名在內建常見臨床欄位表中（例如 age／年齡 0–120、bmi 10–80、sbp／收縮壓 40–300、dbp／舒張壓 20–200、體溫 30–45、血氧 50–100），且 90% 以上的值落在範圍內 → 套用該範圍（`range_source: "name"`），畫面標示「依欄名建議」。
   - 否則數值欄 90% 以上不是負數 → 最小值 0。
   - 不從資料猜最大值（會誤殺真實的極端值）。
6. 欄名：保留原名（中文、空白、符號都可以），只去掉前後空白。欄名空白或重複時無法建立結構，回 422 並說明是第幾欄、請在檔案補上或改名（不自動改名，見「待確認」）。

## 網頁

- 上傳頁：選檔後自動推斷 → 欄位確認表（欄名、型態下拉：整數／小數／類別／文字／日期／是否、必填、不可重複、最小值、最大值、允許的值、資料摘要、提示）→ 預檢結果 →「上傳並驗證」用表上的結構。「視為缺值的寫法」在表下方，修改後重新推斷。原本的 JSON 欄位與「載入結構定義檔」收進「進階：自行提供結構定義（JSON）」，有填時優先使用。
- Target 與 Feature 分頁：欄位總覽表（欄名、型態、缺值、不同值、Target 單選、Feature 勾選、當作類別、提示）。
  提示：Target 有缺值；Target 只有一種值；Feature 缺值比例高（≥ 30%）；疑似識別碼（不同值等於列數）建議不要當 Feature；數字只有少數幾種時提示可當作類別。
  「當作類別」：數字代碼欄（如 0、1、2）打開後，前處理步驟自動加入「轉換資料型別→類別」與「One-Hot 編碼」（沿用既有 steps，畫面上的步驟清單同步顯示）；文字與類別欄位當 Feature 時自動加入 One-Hot。儲存時 Feature 自動換成 One-Hot 產生的欄位（例如 `sex` → `sex_F`、`sex_M`）。

## 測試清單

- `platform/libs/tabular`：`test_infer.py`（型態門檻、缺值寫法、格式與識別碼、類別與罕見值、必填、範圍、中文欄名、空白與重複欄名、Big5）；`test_validate.py` 增加 `missing_values` 與 Big5；bad.csv 以推斷結構驗證的拒絕列是手寫結構拒絕列的子集，加上使用者勾選 sbp 必填後完全相同；3 份正常 CSV 以推斷結構全部通過。
- `platform/api`：`test_tabular_infer.py`：推斷回應形狀、預檢不寫資料庫與物件、401／403／413／422、病毒掃描攔截、以推斷結構上傳 bad.csv 攔截全部 10 列、3 份 cohort 以推斷結構上傳 300 列全通過、中文欄名上傳後預覽與描述統計正常、`schema/check`；既有上傳測試不變（明確結構照舊）。
- `platform/web`：Vitest：上傳頁推斷表、修改型態後重新預檢、進階 JSON 優先、Target／Feature 總覽提示與當作類別；Playwright：`e2e/tabular.spec.ts`（不寫 JSON 上傳 cohort 與 bad.csv、進階 JSON 仍可用、總覽與當作類別）、`e2e/demo-flow.spec.ts` 段落 2 改用新流程。

## 待確認

- 「必填」的預設只看這份檔案有沒有空白：bad.csv 的 sbp 有 2 格空白，推斷為選填，需要使用者在表上勾選必填才會攔下（其餘 8 列推斷結構自動攔下）。
- 內建臨床欄位範圍表是否保留、內容是否由醫院確認。
- 欄名空白或重複時目前要求使用者修改檔案，不自動改名。
- 非 UTF-8 檔案以 Big5 讀取。
- 罕見值門檻 3 次：30 列的小檔案中，正確但只出現 1、2 次的類別值也會被拒絕，需要使用者加到允許的值（以 synth 種子 1～25 檢查：2 份 bad.csv 各有 1～2 列正常的 `current` 被拒；3×25 份正常 cohort 全部通過）。
- 預設缺值寫法包含 `N/A`：手寫結構把選填欄位的 `n/a` 當型別錯誤，推斷結構把它當缺值而接受。
