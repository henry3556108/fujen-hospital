# 真實自動標註工具（MONAI Label，B-03）

契約 B-03「整合第三方自動標註工具 1 式，須達 NVIDIA Clara 等級或同等」。採 **MONAI Label**（NVIDIA 與 MONAI 社群開發，
NVIDIA Clara 影像標註的開源後繼；Apache-2.0）。是否認定為「Clara 等級或同等」**仍待甲方書面確認**（`docs/TODO.md`）。

平台程式不需修改：平台只認自動標註規格 1.0（`docs/specs/autolabel-io-format.md`），由轉接服務把 MONAI Label 包成這個介面。

```
平台 API ──AUTOLABEL_URL──▶ 轉接服務 autolabel:8102 ──上傳 NIfTI──▶ MONAI Label :8000（GPU）
                               └── DICOMweb（Orthanc 唯讀帳號 autolabel）──▶ 平台 Orthanc
```

| 目錄 | 內容 |
|---|---|
| `Dockerfile.monailabel`、`monailabel/` | 映像 `platform-monailabel`：PyTorch 2.8.0 cu128（含 Blackwell sm_120）＋ monailabel 0.8.5 ＋ MONAI 1.4.0，radiology app |
| `adapter/` | 映像 `platform-autolabel`：轉接服務（FastAPI，非 root uid 10001） |
| `scripts/msd_to_dicom.py` | 測試資料：MSD Task09_Spleen 的 CT 轉成 DICOM 序列 |
| `build.sh` | 建置兩個映像（名稱來自 `deploy/k8s/components/images`） |

## 模型與授權

| 模型 | 內容 | 權重 | 授權 |
|---|---|---|---|
| `segmentation_spleen` | 脾臟分割（3D UNet，1 mm 重新取樣） | `radiology_segmentation_unet_spleen_total_seg.pt`（19 MB） | Apache-2.0（MONAI Label release） |
| `segmentation` | 腹部與胸部 25 個器官分割（SegResNet，1.5 mm） | `radiology_segmentation_segresnet_multilabel.pt`（75 MB） | Apache-2.0；訓練資料含 TotalSegmentator（CC-BY-4.0） |

- 權重來自 MONAI Label 官方 GitHub release（`pretrained` 標籤），建置時下載並以 SHA-256 檢查後烤進映像；**執行時不連網**（甲方離線環境可用）。
  內部鏡像站：`WEIGHTS_BASE_URL=http://<鏡像>/ ./build.sh`。
- 官方映像 `projectmonai/monailabel`（PyTorch 2.7.1 cu126，只到 sm_90）在 RTX PRO 6000 Blackwell 上任何 CUDA 運算都失敗，所以自建。
- 沒有 GPU 時同一個映像自動改用 CPU（較慢，見下方限制）。
- 模型只做影像標註的初稿，醫師在標註工作台確認修改；不是診斷用途。

## 轉接服務

- `GET /info/`：只列 MONAI Label 的 `segmentation` 模型（deepedit、scribbles 等要互動的不列），欄位只有規格列出的；`dimension` 固定 2。
- `POST /infer/{model}?image=<SOP Instance UID>`：
  1. QIDO-RS 找出影像所屬的研究與序列，WADO-RS 取回整個序列（要求未壓縮傳輸語法，Orthanc 會轉碼）；
  2. 依 ImagePositionPatient 在切面法向量上的投影排序組成 3D 體積（方向不同的定位片略過；缺片、重複位置拒絕）；
  3. 以 NIfTI 上傳 MONAI Label 推論，取回原影像空間的標籤體積；
  4. 依（模型, 序列）快取標籤體積（8 個、1 小時），同一序列的其他切面直接從快取回答；
  5. 回傳該切面的 RLE（row-major）與 `label_names`（含 background＝0）。
- 錯誤：模型或影像不存在 404；序列不能組成 3D 體積 422；MONAI Label 或 Orthanc 連不到 503；
  推論超過 `INFER_WAIT_SECONDS`（22 秒，平台等 25 秒）先回 503，推論在背景繼續，再送一次就用快取。
- 取像帳號：Orthanc 使用者 `autolabel`，Orthanc 端以 `deploy/local/orthanc/platform/autolabel-readonly.lua` 限制只能 `GET /dicom-web/…`
  （規格 §1「服務以自己的服務帳號向平台 DICOM 節點取像」）。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `MONAI_LABEL_URL` | `http://monai-label:8000` | |
| `DICOMWEB_URL`、`DICOMWEB_USERNAME`、`DICOMWEB_PASSWORD` | `http://orthanc:8042/dicom-web` | 平台 Orthanc 的 DICOMweb 與唯讀帳號 |
| `AUTOLABEL_MODELS` | 空（全部分割模型） | 逗號分隔的模型白名單 |
| `INFER_WAIT_SECONDS` | 22 | |
| `CACHE_SERIES`、`CACHE_TTL_SECONDS` | 8、3600 | |
| `MIN_SLICES`、`MAX_SLICES` | 8、2000 | 3D 推論的切面數範圍 |

## 啟動（本機 compose）

```bash
BUILD_NETWORK=host platform/autolabel/build.sh        # 先建映像（monai-label 約 15 GB，第一次約 10 分鐘）
cd platform/deploy/local
docker compose -f compose.yaml -f compose.labeling.yaml -f compose.monai.yaml up -d --no-build --wait
docker compose exec -T api /app/.venv/bin/python -m app.seed
```

WSL2 的 Docker bridge 網路對外下載很慢（實測約慢 100 倍），所以映像用 `build.sh` 以主機網路建置，compose 用 `--no-build` 不重建。
拿掉 `-f compose.monai.yaml` 再 `up -d` 就回到 fake-autolabel。

實測（2026-10-12，RTX PRO 6000 Blackwell，MSD spleen_2，90 張 512×512）：

| 項目 | 結果 |
|---|---|
| 經平台 API 第一次推論（含取序列、模型載入） | 4.1 秒 |
| 同序列冷快取（模型已載入）：脾臟模型／25 器官模型 | 2.3 秒／4.8 秒 |
| 同序列其他切面（快取） | 0.05 秒以內 |
| 與 MSD 標準答案比對（3 張切面） | 平均 Dice 0.981 |

`adapter/tests/fixtures/recorded/` 是這次經平台用戶端錄下的回應，`platform/api/tests/labeling/test_label_autolabel_monai.py` 用它檢查規格 1.0 零差異。

測試資料與驗收：

```bash
cd platform/autolabel/adapter
uv run python ../scripts/msd_to_dicom.py --msd <Task09_Spleen> --cases 2,3 --out <輸出資料夾>
cd ../../acceptance
AUTOLABEL_CT_DIR=<輸出資料夾> COMPOSE_PROJECT=ai-platform uv run pytest -q test_tc_b03.py
```

正式環境（Kubernetes）：`deploy/k8s/overlays/production/autolabel-monai.yaml`，說明在 `deploy/k8s/README.md`。kind 仍用 fake-autolabel。

## 限制

- **規格 1.0 是 2D**：MONAI Label 的模型是 3D（整個序列），轉接服務每次推論整個序列、只回傳要求的那一張切面的遮罩。
  醫師要標整個器官時要逐張送出（同一序列第二張起走快取，約 1 秒內）。整個序列一次回傳（NIfTI）要另訂規格 1.1（規格 §6 待甲方確認）。
- 只支援可組成 3D 體積的單張影像序列（CT／MR 軸切面等）；單張 X 光、多影格（enhanced）DICOM、彩色影像回 422。
- 模型在腹部 CT 上訓練；其他部位或模態結果沒有意義（仍會回傳格式正確的遮罩）。
- 快取只在轉接服務的記憶體內；序列內容在快取期間被修改（補片）時，1 小時內仍用舊結果。
- MONAI Label 佔 GPU 共享池 1 份 time-slice，不經 Kueue。
