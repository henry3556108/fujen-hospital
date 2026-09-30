# trainer：訓練範本、Job 進入點、推論服務（WP5b）

獨立的 uv 專案，不是平台 API 的相依套件。平台 API 不 import TensorFlow，也不載入模型。

| 路徑 | 用途 |
|---|---|
| `trainer/templates/` | 5 種訓練範本與共用模組。「匯出原始碼」匯出的就是這些檔案 |
| `trainer/fake_trainer.py` | 假訓練：寫出隨機初始化的極小模型，不需要 TensorFlow |
| `trainer/runner.py` | 訓練 Job 的進入點 |
| `trainer/batch.py` | 批次推論 Job 的進入點（`python -m trainer.batch`） |
| `trainer/serve.py`、`trainer/predict.py` | 推論服務 |
| `scripts/load_exported_models.py` | TC-B05-06：在平台外載入匯出的模型並預測 |
| `Dockerfile` | `platform-trainer` 映像，Job 與推論服務共用 |

## 範本

| 種類 | 檔案 | 產出 |
|---|---|---|
| 影像分類 | `image_classification.py` | `model.h5`（Keras） |
| 影像分割 | `image_segmentation.py` | `model.h5` |
| 物件偵測 | `image_detection.py` | `model.h5` |
| 結構式分類 | `tabular_classification.py` | `model.pkl`（scikit-learn）＋`preprocess.pkl` |
| 結構式迴歸 | `tabular_regression.py` | `model.pkl`＋`preprocess.pkl` |

每個範本都用同一個介面執行，產出 `metrics.json`、`splits.json`、`model_card.json`：

```bash
python train.py --config config.json --data dataset --out out
```

`dataset/` 是平台凍結的資料：`manifest.json` 加上 `blobs/<sha256>`。

- **重現**：同一份資料、設定、亂數種子，CPU 上的模型檔與指標逐位元相同。Keras 以單執行緒加 `enable_op_determinism` 達成。
- **切分**：影像以研究或病例為單位，同一研究不會同時出現在訓練與測試。結構式以列為單位。
- **資料增強**：旋轉、長寬位移、Shear、Zoom、水平翻轉、垂直翻轉。影像、遮罩、方框套用同一個變換，只增強訓練資料。
- **結構式前處理**：在訓練資料上擬合，再套用到驗證、測試與推論資料，見 `libs/tabular` 的 `tabular.fitted`。
- **平台外使用**：`model.pkl` 只含 scikit-learn 原生物件；`model.h5` 只用 Keras 內建層與損失。載入方式寫在各範本開頭的說明。

## Job 容器

`python -m trainer.runner` 只讀三個環境變數：`JOB_IO_URL`、`JOB_IO_TOKEN`、`RUN_ID`。token 只對這一次訓練有效，訓練結束即失效。

訓練程式在子程序執行。子程序的環境變數全部清掉，只補回執行 Python 需要的幾個，所以使用者修改的程式拿不到 token。Pod 不掛 ServiceAccount token、不注入叢集服務位址，以 uid 10001 執行。

## 批次推論 Job

`python -m trainer.batch` 讀 `JOB_IO_URL`、`JOB_IO_TOKEN`、`INFERENCE_ID`：下載這一筆推論的輸入包（模型、前處理、輸入資料），以與推論服務相同的 `trainer.predict` 預測（影像每 32 個檔案一批），把原始預測回報給平台 API。加預測欄、存結果由平台 API 做。token 只對這一筆推論有效。

## 推論服務

`uvicorn trainer.serve:app`。上傳推論與線上推論用；批次推論改在 Job 內執行。只給平台 API 呼叫，以 `X-Admin-Token` 驗證，不對主機開放連接埠，也沒有 Gateway 路由。模型只放在記憶體，服務重啟後由平台 API 重新推送。

## 開發

```bash
uv sync --extra keras        # TensorFlow CPU 約 2 GB；不裝時影像範本測試會失敗，其餘可跑
uv run pytest                # 範本、增強、fake-trainer、推論服務
uv run pytest -m "not keras" # 不需要 TensorFlow 的部分
```

映像與部署：

```bash
docker build -f training/Dockerfile -t platform-trainer:dev platform/
platform/deploy/kind/load-trainer-image.sh      # 載入 kind 的 GPU 節點（映像約 6 GB）
cd platform/deploy/local && docker compose -f compose.yaml -f compose.kind.yaml -f compose.training.yaml up -d
```

kind 內的 Job 要回連平台 API：`JOB_IO_BASE_URL` 設成 api 容器在 `kind` 網路上的名稱，例如 `http://ai-platform-api-1:8000`。
