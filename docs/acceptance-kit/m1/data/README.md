# M1 驗收示範資料包

**全部是程式產生的合成資料，不含任何真實病人資料。** 病人姓名、病歷號、影像、檢驗值都是亂數產生；DICOM 的 UID 放在測試用根 `1.2.826.0.1.3680043.10.9999.` 之下，病歷號為 `SYN-<seed>-<序號>`（影像）與 `P1xxxx`、`P9xxxx`（CSV）。影像是雜訊加上一個亮圓，makesense 的方框也不對應影像中的實際結構，只用來測匯入與配對。

- 大小：約 2.2 MB（165 個檔案，含本說明與 `regenerate.sh`）。DICOM 切片 64×64、16 位元。
- 產生工具：`platform/tools/synth`（固定 seed，同一個 seed 產出的檔案逐位元相同）。
- 對應合約附件冊第 3 節「中期測試資料基線」與《M1 應備事項需求函》附件二：DICOM 研究 20 個（CT、MR）、NIfTI／ITK／makesense 各 3 筆、CSV 3 份共 300 筆加一份錯誤資料、Accession 清單 10 筆。

## 重新產生

在 repo 根目錄執行（需要 `uv`，第一次會自動安裝 synth 的套件）：

```bash
bash docs/acceptance-kit/m1/data/regenerate.sh
```

腳本會先刪除下表的子資料夾再重建；`seed` 主資料為 42、PACS 資料為 7。重跑後 `git status` 應該沒有任何變更。

## 檔案與用途

| 路徑 | 內容 | 筆數 | 用在 |
|---|---|---|---|
| `dicom/study_0001` … `study_0020/series_001/IM0001.dcm` … `IM0005.dcm` | 20 個研究，CT 與 MR 各 10 個；每個研究 1 個序列、5 張影像；Accession `ACC0001`–`ACC0020` | 研究 20、序列 20、影像 100 | TC-B01-02、06、08、09 |
| `dicom/manifest.json` | 每個研究的 UID、Accession、病歷號、性別、日期、描述、檔案清單；`accession_allowlist` 10 筆 | — | 核對用（匯入時以 `--exclude manifest.json` 略過） |
| `nifti/case_00{1,2,3}_image.nii.gz`、`_label.nii.gz` | NIfTI 影像與標註各 3 筆（32×32×16，標註 1–2 類） | 6 檔 | TC-B01-03、04 |
| `itk/case_00{1,2,3}_image.mha`、`_label.mha` | ITK（.mha）影像與標註各 3 筆 | 6 檔 | TC-B01-03、04 |
| `makesense/makesense_00{1,2,3}.json` | makesense（COCO 格式）標註 3 筆；第 i 份指向 `dicom/study_000i` 的 5 張影像，標註數 9、6、8 | 3 檔 | TC-B01-03、04 |
| `pairing/makesense_with_dicom/` | makesense 3 份與它對應的 DICOM 研究 1–3（15 張），放在同一個資料夾，示範「同時匯入」與「個別匯入」 | 18 檔 | TC-B01-04 |
| `bad-files/` | `good_01.dcm`、`good_02.dcm`（研究 1 的前 2 張，正常）、`truncated.dcm`（研究 1 第 3 張截掉一半）、`wrong_ext.dcm`（其實是 NIfTI 檔，副檔名卻是 .dcm）、`notes.txt`（不支援的副檔名） | 5 檔 | TC-B01-05 |
| `pacs/` | 放進 PACS 的 2 個研究（seed 7，UID 與主資料不同）：ACC0001 CT、ACC0002 MR，各 5 張 | 研究 2、影像 10 | TC-B01-07 |
| `accession_allowlist.txt` | Accession 清單，一行一筆，取自 `dicom/manifest.json` | 10 筆 | TC-B01-08 |
| `tabular/cohort_01.csv`、`cohort_02.csv`、`cohort_03.csv` | 3 份正常 CSV，各 100 列、12 欄；glucose 有缺值（cohort_01 缺 5 格），study_accession 大多空白 | 300 列 | TC-B01-10、TC-B04-01～07 |
| `tabular/bad.csv` | 30 列，其中 10 列有錯 | 30 列（錯 10） | TC-B01-10 |
| `tabular/bad_rows.json` | `bad.csv` 錯誤列的標準答案（列號從 0 起算、不含表頭） | 10 筆 | TC-B01-10 |
| `tabular/schema.json` | CSV 欄位規則（型別、必填、範圍、允許值），可在上傳頁「進階：自行提供結構定義（JSON）」載入 | 12 欄 | TC-B01-10（進階做法） |
| `tabular/cohort_01_empty_note.csv` | cohort_01.csv 多一欄 `note`，每列都是空白 | 100 列、13 欄 | TC-B04-08 |
| `preprocessing_methods.csv` | 前處理方法文件清單（取自 `platform/libs/tabular/README.md`） | 66 種 | TC-B04-06 |
| `*/manifest.json` | 各子資料夾的產生紀錄與筆數 | — | 核對用 |

### DICOM 20 個研究（篩選答案）

| Accession | 病歷號 | 性別 | Modality | Study Date | Study Description | Series Description |
|---|---|---|---|---|---|---|
| ACC0001 | SYN-42-0001 | M | CT | 2024-07-24 | CT CHEST WO CONTRAST | AXIAL 5MM SOFT TISSUE |
| ACC0002 | SYN-42-0002 | F | MR | 2024-05-20 | MR BRAIN WWO CONTRAST | AX T2 FLAIR |
| ACC0003 | SYN-42-0003 | F | CT | 2024-03-31 | CT ABDOMEN PELVIS W CONTRAST | AXIAL 1MM LUNG |
| ACC0004 | SYN-42-0004 | M | MR | 2024-08-21 | MR BRAIN WWO CONTRAST | AX T1 |
| ACC0005 | SYN-42-0005 | M | CT | 2024-08-15 | CT ABDOMEN PELVIS W CONTRAST | AXIAL 5MM SOFT TISSUE |
| ACC0006 | SYN-42-0006 | F | MR | 2024-07-03 | MR BRAIN WWO CONTRAST | AX T2 FLAIR |
| ACC0007 | SYN-42-0007 | F | CT | 2024-07-02 | CT ABDOMEN PELVIS W CONTRAST | AXIAL 5MM SOFT TISSUE |
| ACC0008 | SYN-42-0008 | M | MR | 2024-05-12 | MR KNEE WO CONTRAST | AX T2 FLAIR |
| ACC0009 | SYN-42-0009 | M | CT | 2024-12-10 | CT CHEST WO CONTRAST | AXIAL 1MM LUNG |
| ACC0010 | SYN-42-0010 | F | MR | 2024-04-03 | MR BRAIN WWO CONTRAST | AX T1 |
| ACC0011 | SYN-42-0011 | M | CT | 2024-10-17 | CT CHEST WO CONTRAST | AXIAL 5MM SOFT TISSUE |
| ACC0012 | SYN-42-0012 | M | MR | 2024-08-01 | MR KNEE WO CONTRAST | AX T1 |
| ACC0013 | SYN-42-0013 | F | CT | 2024-02-19 | CT ABDOMEN PELVIS W CONTRAST | AXIAL 1MM LUNG |
| ACC0014 | SYN-42-0014 | F | MR | 2024-02-24 | MR KNEE WO CONTRAST | AX T1 |
| ACC0015 | SYN-42-0015 | F | CT | 2024-03-26 | CT CHEST WO CONTRAST | AXIAL 1MM LUNG |
| ACC0016 | SYN-42-0016 | M | MR | 2024-06-30 | MR KNEE WO CONTRAST | AX T2 FLAIR |
| ACC0017 | SYN-42-0017 | M | CT | 2024-09-03 | CT CHEST WO CONTRAST | AXIAL 5MM SOFT TISSUE |
| ACC0018 | SYN-42-0018 | F | MR | 2024-06-12 | MR KNEE WO CONTRAST | AX T1 |
| ACC0019 | SYN-42-0019 | F | CT | 2024-09-17 | CT ABDOMEN PELVIS W CONTRAST | AXIAL 1MM LUNG |
| ACC0020 | SYN-42-0020 | M | MR | 2024-11-17 | MR BRAIN WWO CONTRAST | AX T2 FLAIR |

合成資料的描述是隨機搭配的（例如腹部 CT 配「AXIAL 1MM LUNG」序列），不代表臨床意義。

- Accession 清單（10 筆）：ACC0001、ACC0002、ACC0006、ACC0008、ACC0009、ACC0011、ACC0015、ACC0016、ACC0018、ACC0019。清單外 10 筆：ACC0003、0004、0005、0007、0010、0012、0013、0014、0017、0020。
- 5 欄位篩選的預期筆數：Modality＝MR 10 筆；Patient's Sex＝F 10 筆；Study Description 含「chest」5 筆；Study Date 2024-03-01～2024-05-31 5 筆；Series Description 含「lung」5 筆（明細見 B-01 劇本 TC-B01-09）。

### bad.csv 的 10 列錯誤（標準答案）

畫面上的「第幾列」從 1 起算＝`bad_rows.json` 的 `row` 加 1；「檔案行號」再加 1（含表頭）。

| 第幾列 | 欄位 | 值 | 原因 |
|---|---|---|---|
| 8 | sbp | （空白） | 必填欄位缺值 |
| 11 | patient_id | P90001 | 與第 1 列重複 |
| 13 | sbp | 12O | 型別錯（字母 O，不是數字 0） |
| 14 | sex | unknown | 不在允許值（F、M） |
| 15 | bmi | 95.0 | 超出範圍 |
| 16 | age | 150 | 超出範圍 |
| 18 | smoker | sometimes | 不在允許值（current、former、never） |
| 26 | sbp | （空白） | 必填欄位缺值 |
| 29 | age | forty | 型別錯 |
| 30 | patient_id | P90001 | 與第 1 列重複 |

正確結果：共 30 列，通過 20 列，拒絕 10 列。平台自動判斷欄位時 sbp 預設為選填，要勾選「sbp 必填」才會攔下第 8、26 列（資料字典規定 sbp 必填）；改用 `schema.json` 則直接攔下 10 列。

### CSV 欄位（12 欄）

`patient_id`（識別碼）、`age`、`sex`（F／M）、`bmi`、`sbp`、`dbp`、`glucose`（有缺值）、`smoker`（never／former／current）、`diagnosis`（0／1）、`time_to_event`（天）、`event`（0／1）、`study_accession`（對應 DICOM 的 Accession，大多空白）。統計參考值見 `../tools/expected_stats.py` 與 B-04 劇本。

## 核對工具

| 工具 | 用途 |
|---|---|
| `../tools/kit_check.py` | 只讀。沿用匯入程式的登入，核對專案內筆數（counts）、配對（pairing）、Accession 清單外存取（access）、PACS 中繼資料（pacs）。用法見檔案開頭說明 |
| `../tools/expected_stats.py` | 以 pandas、scikit-learn、statsmodels、lifelines 直接計算 cohort_01.csv 的參考值，格式與平台畫面相同 |
