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
| `Dockerfile` | `platform-trainer` 映像（CPU）：推論服務、結構式訓練、結構式批次推論、假訓練 |
| `Dockerfile.gpu` | `platform-trainer-gpu` 映像（GPU）：影像訓練、影像批次推論。套件版本鎖在 `requirements-gpu.txt`、`constraints-gpu.txt` |
| `scripts/test-gpu-image.sh` | 在 GPU 映像內跑 GPU 檢查（TC-A01-03）與影像範本測試（兩種 Keras 後端） |

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

- **重現**：同一份資料、設定、亂數種子，在同一台機器（同一張 GPU 或 CPU）上模型檔與指標逐位元相同。Keras 以單執行緒加 `enable_op_determinism`（TensorFlow）或 `use_deterministic_algorithms`（PyTorch）達成。不同型號的 GPU 或 GPU 與 CPU 之間不保證逐位元相同。
- **Keras 後端**：環境變數 `KERAS_BACKEND` 選 `tensorflow`（預設）或 `torch`（備案），輸出一樣是 `model.h5`。模型卡的 `keras_backend`、`device` 記錄實際的後端與運算裝置（GPU 型號或 CPU）。目前 torch 後端訓練不了分割範本（Keras 3.15.1 torch 後端的反向傳播錯誤「grad_input must be contiguous」，CPU 也一樣），分類與偵測可以。
- **切分**：影像以研究或病例為單位，同一研究不會同時出現在訓練與測試。結構式以列為單位。
- **資料增強**：旋轉、長寬位移、Shear、Zoom、水平翻轉、垂直翻轉。影像、遮罩、方框套用同一個變換，只增強訓練資料。
- **結構式前處理**：在訓練資料上擬合，再套用到驗證、測試與推論資料，見 `libs/tabular` 的 `tabular.fitted`。
- **平台外使用**：`model.pkl` 只含 scikit-learn 原生物件；`model.h5` 只用 Keras 內建層與損失。載入方式寫在各範本開頭的說明。

## 兩個映像

| 映像 | 基底 | 內容 | 用在 |
|---|---|---|---|
| `platform-trainer` | `python:3.12-slim-trixie` | `uv.lock` 鎖定的套件，TensorFlow CPU 2.21、numpy 2.x；`CUDA_VISIBLE_DEVICES=""` | 推論服務、結構式訓練與批次推論、假訓練 |
| `platform-trainer-gpu` | `nvcr.io/nvidia/tensorflow:25.02-tf2-py3` | TensorFlow 2.17（NVIDIA 版，CUDA 12.8，原生支援 Blackwell sm_120）、PyTorch 2.8.0 cu128、Keras 3.15.1、numpy 1.26 | 影像訓練、影像批次推論（GPU 池） |

- **為什麼 GPU 映像不用官方 TensorFlow**：官方 pip 版只編到 sm_89／compute_90，RTX PRO 6000 Blackwell 用不到 GPU；NGC 25.02 是原生支援的最後一版 NGC TensorFlow 容器。實測紀錄見 `docs/superpowers/plans/2026-10-05-gpu-enablement.md`。
- **版本**：TF 2.17 以 numpy 1.x 編譯，所以 GPU 映像的科學計算套件版本與 CPU 映像不同（`requirements-gpu.txt`）。兩個映像的 Keras 都是 3.15.1，GPU 映像訓練的 `model.h5` 由 CPU 映像的推論服務讀取。結構式訓練留在 CPU 映像，scikit-learn 版本才會與推論服務一致。
- **共享 GPU**：`TF_FORCE_GPU_ALLOW_GROWTH=true`，TensorFlow 按需配置顯示記憶體，同一張卡的多份時間片才不會被第一件工作佔滿。時間片之間沒有記憶體隔離。
- **平台 API 的設定**：`TRAINING_GPU_IMAGE`（影像工作）、`TRAINING_IMAGE`（其餘）；沒設 `TRAINING_GPU_IMAGE` 時全部用 `TRAINING_IMAGE`。Kubernetes 的值在 `deploy/k8s/components/images/kustomization.yaml`。

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
docker build -f training/Dockerfile.gpu -t platform-trainer-gpu:dev platform/    # 約 35 GB
platform/training/scripts/test-gpu-image.sh     # GPU 映像內的 GPU 檢查與影像範本測試（需要 NVIDIA Container Toolkit）
platform/deploy/kind/load-trainer-image.sh      # 載入 kind 的 GPU 節點（映像約 6 GB）；WITH_GPU_IMAGE=1 另載入 GPU 映像
cd platform/deploy/local && docker compose -f compose.yaml -f compose.kind.yaml -f compose.training.yaml up -d
```

kind 內的 Job 要回連平台 API：`JOB_IO_BASE_URL` 設成 api 容器在 `kind` 網路上的名稱，例如 `http://ai-platform-api-1:8000`。
