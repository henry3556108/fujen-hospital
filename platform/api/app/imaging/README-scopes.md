# 資料範圍（imaging scopes）

資料範圍存的是**篩選條件**，不是影像清單。之後新匯入、符合條件的研究會自動算在範圍內。
研究一律先套用 Admin 設的 Accession 清單（看得到的才算），範圍是在看得到的研究裡再挑。

## API（`/api/projects/{project_id}/imaging`）

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| GET | `/scopes` | Project | `Scope[]` |
| POST | `/scopes` | Labeling | body `{name, filters}`，201 回 `Scope`；同名 409 |
| GET | `/scopes/{id}` | Project | `Scope` |
| PUT | `/scopes/{id}` | Labeling | body `{name?, filters?}`（只改有給的欄位） |
| DELETE | `/scopes/{id}` | Labeling | 204；用到它的標註資料集改成不限範圍 |
| GET | `/studies?scope_id=` | Project | 只列範圍內的研究，可再加其他條件（同時成立） |

`Scope = {id, name, filters, study_count, created_by, created_at}`；`study_count` 是目前符合條件、看得到的研究數。

## filters 的 key（與 `GET /imaging/studies` 的查詢參數同名）

| key | 比對方式 |
|---|---|
| `modality` | 任一序列的 Modality 相同（不分大小寫），例 `CT` |
| `patient_sex` | 病人性別相同（不分大小寫），`F`／`M`／`O` |
| `study_description` | 研究描述包含這段文字（不分大小寫） |
| `series_description` | 任一序列描述包含這段文字（不分大小寫） |
| `study_date` | 單一天 `YYYYMMDD`，或區間 `YYYYMMDD-YYYYMMDD`（可省略一端：`20240101-`、`-20240331`） |

前端（B）照上面五個 key 送，與研究列表頁的查詢參數完全相同。

另外也接受（選用，前端不必用）：

| key | 比對方式 |
|---|---|
| `study_date_from` | 檢查日期 ≥ 這天，`YYYYMMDD` 或 `YYYY-MM-DD` |
| `study_date_to` | 檢查日期 ≤ 這天，`YYYYMMDD` 或 `YYYY-MM-DD` |
| `sex` | `patient_sex` 的別名，存檔時改成 `patient_sex` |

- 空字串或 `null` 的條件視為沒填，不存。其他 key 回 422；`study_date` 格式不對也回 422。
- 研究列表 API 同樣多接受 `study_date_from`、`study_date_to`、`scope_id`。
