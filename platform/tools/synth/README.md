# synth：合成測試資料產生器

不用下載任何公開資料集或模型，就能產生整個平台冒煙測試用的資料。輸出是確定性的：同一個 seed 產出的檔案逐位元相同（不寫入含時間戳的格式；`.nii.gz` 的 gzip 標頭 mtime 固定為 0）。每個指令都會寫一份 `manifest.json`，列出產生的內容與筆數。

```bash
cd platform/tools/synth
uv sync
uv run python -m synth all --out ./out            # 預設 --seed 42
uv run python -m synth dicom --out ./out/dicom --seed 7
uv run pytest                                     # 驗證產出
```

| 指令 | 產出 | 用途 | 案例 |
|---|---|---|---|
| `dicom --studies 20` | 20 個研究（CT、MR 各半），每個 1 個序列、5 張 64×64 uint16 切片；UID 在測試根 `1.2.826.0.1.3680043.10.9999.` 下；Accession `ACC0001`–`ACC0020`；manifest 含 5 個篩選欄位與 10 筆 `accession_allowlist` | 取代 TCIA 20 個研究 | TC-B01-02、05（可自行截斷檔案）、06、07、08、09 |
| `nifti --count 3` | `case_00i_image.nii.gz` + `case_00i_label.nii.gz`，標註 1–2 類 | 取代 MSD NIfTI | TC-B01-03、04 |
| `itk --count 3` | `case_00i_image.mha` + `case_00i_label.mha`（SimpleITK） | ITK 標註 | TC-B01-03、04 |
| `makesense --count 3` | `makesense_00i.json`（COCO 格式）；`file_name` 對應 **`dicom` 輸出**的切片相對路徑，例如 `study_0001/series_001/IM0003.dcm`，第 i 份對應第 i 個研究 | makesense 標註匯入 | TC-B01-03、04 |
| `tabular` | `cohort_01..03.csv`（各 100 筆、12 欄，glucose 有少量缺值）、`schema.json`（型別、必填、範圍、允許類別，給 CSV 驗證器用）、`bad.csv`（正常列混錯誤列）、`bad_rows.json`（錯誤列索引從 0 起算、不含標頭，及原因：缺必填、型別錯、超出範圍、未知類別、重複 patient_id） | 取代 Synthea CSV | TC-B01-10、TC-B04-01～08 |
| `clinical` | 同一組 20 位病人（與 `dicom` 的 PatientID 相同）：`hl7/` 20 則 ADT^A01（分段以 `\r` 分隔）、`labs.json` 20 筆檢驗、`patients.sql`（CREATE TABLE + 20 筆 INSERT，PostgreSQL 相容）、`encounters.csv` 20 筆；`invalid/` 2 則不合格訊息（缺 PID-3、PID-8 性別代碼錯誤） | FHIR 接入來源 | TC-C03-01、04、05、13 |
| `vitals --count 100` | `vitals.jsonl`：100 筆心率、SpO2、呼吸速率，時間間隔 1 秒；manifest 附 LOINC 代碼 | 生理監視器模擬 | TC-C03-12 |
| `all` | 以上全部，各自放在同名子資料夾 | 一次建立基線 | 共用測試基線 |

注意：`dicom` 的影像與 `makesense` 的方框都是合成的，方框不對應影像中的實際結構，只用來測匯入與配對。
