# 自動標註輸入輸出格式規格（B-03）

版本：1.0（2026-09-29）。狀態：**待甲方於開工前書面確認**；確認前以本文件為準。
驗收 TC-B03-04 比對的就是本文件：`platform/api/app/labeling/formats.py` 的欄位定義、自動標註服務的實際回應、本文件三者差異必須為 0。不驗標註正確率。

介面採 MONAI Label HTTP API 的子集。開發機以 `platform/fakes` 的 fake-autolabel 提供同一介面；正式環境換成 MONAI Label（或甲方指定的同等工具）時，平台程式不需修改，只改服務位址。

## 1. 呼叫方式

| 項目 | 內容 |
|---|---|
| 查詢模型 | `GET /info/` |
| 送出標註 | `POST /infer/{model}?image={image_id}` |
| 影像 ID | 2D 模型為 SOP Instance UID；服務以自己的服務帳號向平台 DICOM 節點取像，不使用使用者的 token |
| 逾時 | 平台等候 25 秒（環境變數 `AUTOLABEL_TIMEOUT_SECONDS`），逾時視為服務離線 |
| 錯誤 | 服務回 4xx／5xx、無法連線、逾時、回應不合本規格時，平台不寫入任何標註 |

## 2. 查詢模型的回應（`GET /info/`）

<!-- spec:info -->
| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| name | string | 是 | 服務名稱 |
| description | string | 否 | 服務說明 |
| version | string | 是 | 服務版本 |
| labels | array<string> | 是 | 服務支援的標籤（不含 background） |
| models | object | 是 | 模型名稱 → 模型資訊 |
<!-- /spec:info -->

每個模型資訊：

<!-- spec:model -->
| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| type | string | 是 | `segmentation` 或 `detection` |
| labels | array<string> | 是 | 這個模型輸出的標籤 |
| dimension | integer | 是 | 2 或 3 |
| description | string | 否 | 說明文字 |
<!-- /spec:model -->

## 3. 分割模型的回應（`type = segmentation`）

<!-- spec:segmentation -->
| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| model | string | 是 | 與請求的模型名稱相同 |
| image | string | 是 | 與請求的影像 ID 相同 |
| shape | array<integer> | 是 | `[高, 寬]`，遮罩的像素格 |
| encoding | string | 是 | 固定為 `rle` |
| rle_order | string | 否 | 說明文字；順序固定為 row-major |
| rle | array<array<integer>> | 是 | `[標籤值, 長度]` 的清單；長度總和＝高×寬 |
| label_names | object | 是 | 標籤名稱 → 標籤值；必含 `background`＝0 |
<!-- /spec:segmentation -->

## 4. 偵測模型的回應（`type = detection`）

<!-- spec:detection -->
| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| model | string | 是 | 與請求的模型名稱相同 |
| image | string | 是 | 與請求的影像 ID 相同 |
| shape | array<integer> | 是 | `[高, 寬]` |
| box_format | string | 是 | 固定為 `xyxy` |
| boxes | array<object> | 是 | 每個框含 `label`（string）、`box`（4 個整數 `[x1, y1, x2, y2]`）、`score`（0–1，可省略）；可為空清單 |
<!-- /spec:detection -->

## 5. 回存到平台的標註

| 模型種類 | 平台標註種類 | 內容 |
|---|---|---|
| segmentation | segmentation | `shape`、`encoding`、`rle`、`label_names` 原樣保存 |
| detection | detection | `shape`、`box_format`、`boxes` 原樣保存 |

- 標註的 `source` 為 `autolabel`，並記錄模型名稱、送出者、耗時（毫秒）。
- 偵測模型沒有找到任何物件（`boxes` 為空）時不建立標註，回報「沒有偵測到物件」。
- 醫師在標註工作台修改後，`source` 不變、`version` 加 1、`updated_by` 記修改者。
- 本規格未列的欄位一律忽略，不保存。

## 6. 待甲方確認

- 自動標註工具是否採 MONAI Label（契約寫「NVIDIA Clara 等級或同等」）。
- 3D 模型（整個序列）的輸出格式：目前規格只涵蓋 2D（單張影像）；若需要 3D，遮罩改以 NIfTI 檔回傳，另訂 1.1 版。
