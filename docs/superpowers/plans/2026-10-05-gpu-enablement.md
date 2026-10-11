# GPU 實際運算：依等級分群、GPU 訓練映像、vLLM 實作計畫

> **For agentic workers:** 依 superpowers:test-driven-development 逐 Task 執行；每個 Task 一個 commit。
> 標 **〔WSL〕** 的 Task 在 Windows + WSL2 開發機（RTX PRO 6000 Blackwell 96 GB）完成；標 **〔Ubuntu〕** 的要在原生 Ubuntu 24.04 + GPU（或甲方主機）重做或補做。

**Goal：** 讓平台的 GPU 從「模擬」走到「真的拿來算」：
- **軌 A**：C-01「GPU 群組依等級分群」與群組張數上限真的生效（M1，原定 10/6）。
- **軌 B**：GPU 版訓練映像，含 TensorFlow 與 PyTorch，影像訓練在 GPU 上跑並輸出 H5（A-01，M1，原定 10/8）。
- **軌 C**：以 vLLM 提供真模型，載入／卸載真的啟動與停止服務，驗證 4-bit、8-bit 量化（B-07，M2）。

**依據：** 2026-10-05 的程式碼盤點與在開發機的實測（見「附：實測紀錄」）。

## 先講結論與要決定的事

2026-10-05 已定案：

| # | 事項 | 決定 |
|---|---|---|
| D1 | 「等級」的意思 | **使用等級，不是硬體等級**：3 張卡型號完全相同，沒有高低階之分。等級只表示一張卡怎麼用：「獨占」＝一件工作用整張卡（gpu-exclusive），「共享」＝一張卡切成時間片給多件工作（gpu-shared）。合約為「MIG 移除修訂版」，原本的等級應是 MIG 切分規格，移除後以獨占／共享對應。畫面與文件不使用「高／一般等級」的字眼 |
| D2 | 合約文字不一致（data.js「建立 2 個群組，依等級分群」、報告「依等級分群 1 組」） | **以 data.js 為準**：建 2 個群組，一個獨占、一個共享 |
| D3 | 群組張數怎麼限制 | 每個群組一個 Kueue ClusterQueue，`nominalQuota = gpu_count`，同池的群組放進同一個 cohort、不准借用 |
| D4 | 甲方 GPU | **與開發機相同：NVIDIA RTX PRO 6000 Blackwell，共 3 張**（sm_120）。種子基線維持獨占 2 張、共享 1 張 |
| D5 | Windows 驅動升級到 R580 以上 | **先不升級**，列入 `docs/TODO.md`。開發與正式映像一律用 CUDA 12.8（Windows 572.83 支援到 12.8；Linux R580 驅動也能跑 12.8 映像） |

## 全域限制

- 不破壞現有測試：模擬 GPU（kind + fake-gpus.sh）與 FakeJobBackend 的行為要保留，所有新功能先在 Fake 上有單元測試。
- 資料表沒有 Alembic，只有 `create_all`：**既有資料表不能加欄位**，新欄位一律另開表（照 `DeploymentTitle`、`InferenceBatch` 的做法）。
- 所有映像版本只寫在 `deploy/k8s/components/images/kustomization.yaml`。
- 換映像後要重新產生套件清單、授權清單與漏洞報告（`compliance packages generate`）。

---

## 軌 A：GPU 群組依等級分群與張數上限（C-01）

**現況：** `gpu_groups` 只有名稱、池、模式、張數；送出工作時群組只用來決定池，`gpu_count` 完全沒用到。Kueue 是一個池一個 ClusterQueue，同池的群組共用配額。程式、節點標籤、網頁都沒有「等級」或「型號」。

**設計（D1：等級＝使用等級，3 張同型號卡）：**
- **等級**：就是現有的 GPU 池，不另存欄位、不加節點標籤、不做型號偵測。API 的群組輸出加 `tier`（`exclusive`、`shared`）；網頁把「GPU 池」改稱「使用等級」，選項為「獨占（一件工作用整張卡）」「共享（時間片，多件工作共用一張卡）」。現有資料不必遷移。
- **張數上限**：每個群組一個 ClusterQueue（名稱 `grp-<群組 id>`）與同名 LocalQueue，沿用現有 ResourceFlavor（gpu-exclusive、gpu-shared）；`nominalQuota`：獨占＝`gpu_count`，共享＝`gpu_count × 時間片份數`；同池放同一個 `cohortName`，`borrowingLimit: 0`。
- **總量檢查**：同一等級所有群組的 `gpu_count` 合計不得超過該池的實體卡數（3 張卡：獨占 2 張、共享 1 張），超過回 422。
- **誰建立 Kueue 物件**：平台 API 在新增、修改、刪除群組時同步（`JobBackend.sync_group`），RBAC 增加 `clusterqueues`、`localqueues` 的 create／patch／delete。預設群組由部署建立，不可刪除或改名（同時修掉目前「預設群組可被刪除」的問題）。共享排程設定改時間片份數時，一併更新一般等級群組的配額。
- **送出工作**：`JobSpec.queue` 改成群組的佇列；Fake 後端以群組為單位做 StrictFIFO 與配額。

| Task | 內容 | 測試 | 環境 |
|---|---|---|---|
| A1 | 群組輸出加 `tier`；建立、修改時依等級決定池與模式 | `test_sched_gpu_groups.py`；TC-C01-02 改成「2 個群組、獨占與共享各 1，重新載入一致」 | 〔WSL〕 |
| A2 | 總量檢查：同等級合計張數不超過實體卡數（讀節點的 `platform/gpu-physical`） | 超過時回 422 的測試 | 〔WSL〕 |
| A3 | FakeJobBackend：每群組一個佇列與配額，同池不同群組互不佔用 | 新增「群組 A 滿了，群組 B 照常執行」「群組內依序排隊」 | 〔WSL〕 |
| A4 | Kubernetes 後端 `sync_group`：產生 ClusterQueue、LocalQueue；`build_job_manifest` 用群組佇列；`configure_shared` 同步更新一般等級群組配額 | `test_sched_kube.py` 比對產生的 manifest | 〔WSL〕 |
| A5 | 部署：`queues.yaml` 改成預設群組各一組（加 cohort）、RBAC 擴充；預設群組不可刪除 | `test_k8s_manifests.py`；`deploy.sh kind` 重新部署 | 〔WSL〕 |
| A6 | 網頁：GPU 群組表單與列表的「GPU 池」改成「使用等級」（獨占／共享）；專案的 GPU 群組選項顯示等級 | `scheduling-cluster.test.tsx`、`admin-projects.test.tsx`；Playwright `scheduling.spec.ts` | 〔WSL〕 |
| A7 | kind 驗收：`test_tc_c01.py` 加「同池兩群組配額互不影響」；重新確認 TC-C01-05、08 的排隊順序；更新 C-01 驗收手冊、已知問題與使用者操作手冊第 11 節 | `test_tc_c01.py`（kind） | 〔WSL〕 |
| A8 | 真 GPU：配額以實體卡數（獨占）與時間片複本數（共享）驗證 | 安裝後實跑 | 〔Ubuntu〕 |

**風險：** 開了 time-slicing 後 `nvidia.com/gpu` 是複本數，一般等級的配額要換算；StrictFIFO 改成每群組一條佇列後，跨群組不再保證先來先服務，要在手冊寫清楚。要先向甲方說明「等級＝獨占／共享」的解讀並取得書面確認。

---

## 軌 B：GPU 版訓練映像（A-01）

**現況：** 訓練映像只有 `tensorflow-cpu 2.21`，沒有 PyTorch；`Dockerfile` 第 23 行 `CUDA_VISIBLE_DEVICES=""` 會讓任何 GPU 都看不見。所有訓練工作（含結構式）都要求 1 張 GPU。

**實測（開發機 RTX PRO 6000 Blackwell，Windows 驅動 572.83，2026-10-05～06）：**

| 組合 | 結果 | 說明 |
|---|---|---|
| PyTorch 2.8.0 + CUDA 12.8 | ✅ GPU 可用 | sm_120 正常，矩陣運算正常 |
| Keras 3.15 改用 PyTorch 後端 | ✅ GPU 可用 | GPU 上訓練，`.h5` 存檔再讀回一致 |
| TensorFlow 2.21 官方映像（CUDA 12.5） | ❌ 看不到 GPU | cuDNN 初始化失敗 |
| TensorFlow 2.21 + 換成 CUDA 12.8、cuDNN 9.27 函式庫 | ❌ 看不到 GPU | 官方 wheel 只編到 sm_89 + compute_90，直接略過這張卡 |
| TensorFlow 2.22.0rc0（CUDA 12.9） | ⚠️ 看得到 GPU，配置記憶體失敗 | 提示「沒有 12.0 的 kernel，改從 PTX 即時編譯」；CUDA 12.9 超過目前驅動支援的 12.8，升級驅動後要重測 |
| tf-nightly | — 未完成 | pip 下載逾時（網路），未測到 |
| **NVIDIA NGC TensorFlow 25.02（TF 2.17 + CUDA 12.8）** | **✅ GPU 可用** | **原生編了 sm_100、sm_120**；矩陣、卷積、Keras 訓練都在 GPU 上，`.h5` 存讀一致；第一個 epoch 1.1 秒，之後每 epoch 約 0.06 秒 |

**結論：** TensorFlow 的官方 pip 版本確實不支援 Blackwell，但 **NVIDIA 自己編的 TensorFlow（NGC 容器）可以**。NGC TensorFlow 容器在 25.02 之後停止發行，所以 25.02 是最後一版，TF 停在 2.17、Keras 3.3.2。

**設計：**
- **分成兩個映像**：`platform-trainer`（CPU，維持現狀，給推論服務、結構式訓練與 CI）與新的 `platform-trainer-gpu`（給 GPU 工作）。GPU 映像只載入 GPU 節點。
- **GPU 映像以 NGC TensorFlow 25.02 為基底**（Ubuntu 24.04、Python 3.12.3、TF 2.17 原生支援 sm_120），再加裝 PyTorch cu128 與訓練程式。TC-A01-03 的「PyTorch GPU 運算」「TensorFlow GPU 運算」都能是 True，且不需升級驅動。
- **Keras 後端可切換（備案）**：`imagekit.keras_setup()` 依 `KERAS_BACKEND` 決定，預設 `tensorflow`；NGC 映像出問題或未來要換掉時，改成 `torch` 即可，輸出一樣是 `.h5`。模型卡記錄實際的後端與函式庫版本。
- **結構式訓練改走 CPU 池**：scikit-learn 用不到 GPU，結構式訓練改成 `cpu-data`，不再佔 GPU。
- **之後的路**：驅動升級後重測 TF 2.22 正式版（rc0 已經認得這張卡）；若可用，GPU 映像改回官方 TF，與 CPU 映像版本一致。列入 `docs/TODO.md`。

| Task | 內容 | 測試 | 環境 |
|---|---|---|---|
| B1 | `Dockerfile.gpu`：`nvcr.io/nvidia/tensorflow:25.02-tf2-py3` 為基底，加 torch（cu128）、訓練程式與 `libs/tabular`；確認 NGC 內建的 Keras 3.3.2 能否升到 3.15（不行就鎖 3.3.2 並跑完所有影像範本測試）；以 uid 10001 執行；不設 `CUDA_VISIBLE_DEVICES=""` | 容器內跑 TC-A01-03 的檢查程式：PyTorch、TensorFlow GPU 運算都 True | 〔WSL〕 |
| B2 | `imagekit` 支援 `KERAS_BACKEND`（tensorflow／torch）；三個影像範本在兩種後端都能訓練並輸出 `.h5` | `test_image_templates.py` 參數化兩種後端 | 〔WSL〕 |
| B3 | 可重現性：TF 的 `enable_op_determinism`、torch 的 `use_deterministic_algorithms` + `CUBLAS_WORKSPACE_CONFIG`；驗證「同一張卡重跑 3 次 `.h5` sha256 相同」 | TC-B05-04 在 GPU 上重跑 | 〔WSL〕 |
| B4 | 平台：GPU 工作用 `TRAINING_GPU_IMAGE`；結構式訓練改 CPU 池；`bundle.py` 匯出的 `requirements.txt` 依映像寫入實際版本 | `test_train_runs.py`、`test_train_batch.py`、`test_sched_jobs.py` | 〔WSL〕 |
| B5 | 映像清單、`build-and-load.sh`、`load-trainer-image.sh` 加 GPU 映像（只載入 GPU 節點）；核准映像來源加 `nvcr.io`；授權清單加 NVIDIA Deep Learning Container License；重新產生套件清單、授權清單、漏洞報告 | `compliance packages check`；合規測試 | 〔WSL〕 |
| B6 | 更新 A-01 驗收手冊的預期輸出（TF 2.17、CUDA 12.8）與版本清單 | — | 〔WSL〕 文件 |
| B7 | 在 K8s 上真的用 GPU 跑訓練 Job（device plugin + time-slicing），量訓練時間 | kind 驗收換成真 GPU 節點 | 〔Ubuntu〕 |

**風險：**
- **映像很大**：NGC 25.02 本身 27.8 GB，加上 PyTorch 預估 30 GB 以上。B1 先試多階段建置瘦身；kind 節點磁碟曾經滿過，只載入 GPU 節點，並在 TODO 註明磁碟需求。
- **停止更新**：NGC TF 25.02 不會再有安全更新，Trivy 會報出既有弱點；要在漏洞報告中說明，並以「驅動升級後改回官方 TF 2.22」為退場方案。
- **授權**：NGC 映像受 NVIDIA Deep Learning Container License 規範，需列入第三方授權清單，必要時請甲方確認。
- **版本不一致**：CPU 映像是 TF 2.21、GPU 映像是 TF 2.17；`.h5` 由 GPU 訓練、CPU 推論服務讀取，B1 要驗證跨版本讀取。
- **GPU 上的逐位元可重現**：不保證所有 kernel 都可重現；B3 先驗證，不行就把 TC-B05-04 的判定改成「同一張卡、同一映像」並請甲方確認。

**實作結果（2026-10-11，B1–B6 完成，B7 待甲方主機）：**

| 項目 | 結果 |
|---|---|
| B1 映像 | `platform-trainer-gpu:dev`，NGC TF 25.02 + PyTorch 2.8.0 cu128 + Keras 3.15.1（與 CPU 映像相同）、numpy 1.26.4；磁碟 39.3 GB（內容 13.4 GB）。NGC 內建的 Keras 3.3.2 可以直接升到 3.15.1，不用鎖舊版。套件鎖在 `requirements-gpu.txt`，NGC 內建的 TF、numpy、ml-dtypes、protobuf 以 `constraints-gpu.txt` 固定。`TF_FORCE_GPU_ALLOW_GROWTH=true`（共享卡） |
| TC-A01-03 檢查 | PyTorch 2.8.0+cu128（CUDA 12.8、cuDNN 91002）與 TensorFlow 2.17.0（CUDA 12.8、cuDNN 9）的 GPU 運算都是 True（驅動 572.83） |
| B2 後端 | `KERAS_BACKEND=tensorflow`（預設）／`torch`。torch 後端訓練不了分割範本：Keras 3.15.1 torch 後端反向傳播出錯「grad_input must be contiguous」，CPU、GPU、關掉決定性都一樣，測試標為 strict xfail；分類、偵測可以 |
| B3 重現 | GPU 上 tensorflow 後端三種範本重跑 3 次權重逐位元相同；torch 後端分類、偵測也相同。`scripts/test-gpu-image.sh`：15 passed、2 xfailed |
| 跨映像 | GPU 映像（TF 2.17）訓練的 `model.h5` 由 CPU 映像（TF 2.21、同 Keras 3.15.1）載入並預測成功 |
| 沒有 GPU | 同一個映像在沒有 GPU 的節點（kind 假 GPU）自動改用 CPU，影像分類可訓練 |
| B4 平台 | `job_image()`：影像訓練與影像批次推論用 `TRAINING_GPU_IMAGE`，結構式訓練、結構式批次推論、假訓練用 `TRAINING_IMAGE`（scikit-learn 版本與推論服務一致）；沒設 GPU 映像時全部用 CPU 映像。**結構式訓練改走 CPU 池沒做**：會改變 M1 已驗證的排程與 TC-B05-01 的排隊測試，驗收後再做。匯出原始碼的 `requirements.txt` 改為 `keras==3.15.1`、`tensorflow>=2.17,<2.22`，README 加 GPU 說明 |
| B5 部署與合規 | Kustomize `platform-images` 加 `TRAINING_GPU_IMAGE`；`images.py gpu-jobs`；`build-and-load.sh`（`SKIP_GPU_IMAGE`）、離線 `bundle.sh`／`install.sh` 只把 GPU 映像放 GPU 節點；`load-trainer-image.sh` 的 `WITH_GPU_IMAGE=1`；核准來源加 `nvcr.io/nvidia/tensorflow`；`掃毒與來源檢核說明.md` 補授權與漏洞說明 |
| B6 文件 | A-01 劇本 TC-A01-03 的預期輸出與開發環境範例改為實測值 |
| 記憶體 | 影像分類（合成資料）在 GPU 上訓練程序峰值 1749 MB，平台給影像 Job 的上限 2 GB；甲方安裝時要調高（`docs/TODO.md`） |

---

## 軌 C：vLLM 真模型服務（B-07，M2）

**現況：** 平台 API 只是 OpenAI 相容的用戶端（`/chat/completions`、`/embeddings`、`/models`，同一個 `LLM_BASE_URL`）。「載入／卸載」只把設定寫進資料庫（`RecordingModelRuntime`），不會啟動任何服務；量化、CPU、記憶體、GPU 只是記錄。正式的模型下載來源（`ModelSource`）沒有實作，下載時整個模型讀進記憶體，存到 10 GiB 的 RWO PVC。

**設計：**
- **一個模型一個 vLLM 服務**：`KubernetesModelRuntime.load()` 產生 Deployment + Service（`vllm/vllm-openai`，`--served-model-name` 用白名單名稱、`--quantization`、`--tensor-parallel-size = gpu_count`、`--trust-remote-code` 依核准），`unload()` 刪除。用 Deployment，不經 Kueue（長駐服務），但放在 GPU 池節點並受群組張數管制（與軌 A 共用計數）。
- **模型路由**：資料庫記錄每個已載入模型的端點；`LlmClient` 依模型名稱選端點。新增 `LLM_EMBED_BASE_URL`，讓 embedding 模型（`vllm serve --runner pooling`）可以是另一個服務。
- **量化對應（3 張 Blackwell）**：4-bit 用預先量化的 AWQ／GPTQ 權重（Marlin kernel），或 Blackwell 原生的 NVFP4；8-bit 用 FP8 W8A8。白名單上標註每個模型可用的量化版本。bitsandbytes 只當備案（8-bit 在 vLLM 沒有直接支援）。
- **vLLM 版本受 CUDA 12.8 限制（D5）**：vLLM 0.31 預設映像是 CUDA 13.0，`-cu129` 變體是 CUDA 12.9，兩者都超過 Windows 驅動 572.83 支援的 12.8（TF 2.22rc0 在 CUDA 12.9 下已出現配置記憶體失敗）。C1 要先找出最新一版以 CUDA 12.8 建置的 vLLM 映像並實測；正式環境（Linux 驅動）若裝 R580 以上則不受此限，但開發與正式最好用同一版。
- **模型儲存**：下載改成串流寫檔，不整包讀進記憶體；模型目錄改為獨立的 RWX PVC（或 MinIO + 啟動時同步），vLLM Pod 唯讀掛載。
- **正式下載來源**：實作 Hugging Face（或甲方鏡像）來源，帶 Token，記錄 commit 與 hash。

| Task | 內容 | 測試 | 環境 |
|---|---|---|---|
| C1 | 先用 docker 在開發機跑 vLLM（一個對話小模型 + 一個 embedding 模型），把 compose 的 `LLM_BASE_URL` 指過去，跑通 Playground、RAG、發布 API | 手動 + 量 TC-B07-03 回應時間 | 〔WSL〕 |
| C2 | `LLM_EMBED_BASE_URL`；`LlmClient` 依模型選端點 | `test_llm_client.py` | 〔WSL〕 |
| C3 | 驗收測試分版：依賴 fake 回覆內容的斷言（B07-05、B07-06、B08-04、B07-08、Playwright、S0 smoke）拆成 fake 專用與真模型版；參數是否送達改查呼叫紀錄 | `test_tc_b07.py`、`test_tc_b08.py` | 〔WSL〕 |
| C4 | 4-bit、8-bit 實測：同一模型的 AWQ 版與 FP8 版各載入一次，記錄顯存、首字延遲、每秒 token | TC-B07-04 | 〔WSL〕 |
| C5 | 串流下載、獨立模型 PVC、Hugging Face 來源 | `test_llm_models.py`；大檔下載測試 | 〔WSL〕 |
| C6 | `KubernetesModelRuntime`：Deployment + Service 產生、RBAC 加 deployments／services、NetworkPolicy 放行 vLLM | manifest 單元測試 | 〔WSL〕 |
| C7 | 在 K8s 上真的載入、卸載、切換量化；production overlay 補齊 vLLM 設定 | TC-B07-04、TC-B07-08 | 〔Ubuntu〕 |

**風險：** 甲方是否允許從 Hugging Face 下載（或要內部鏡像）未定；vLLM 每月發版、API 旗標變動快，要釘版本；長駐模型會一直佔著 GPU，要在手冊說明「卸載才會釋放 GPU」。

---

## 時程與順序

M1 驗收 10/22，甲方主機 10/9 才給，所以 M1 的 A、B 優先，C 是 M2 範圍。

| 順序 | 工作 | 預估 |
|---|---|---|
| 1 | A1–A7（依等級分群與張數上限） | 2 天 |
| 2 | B1–B6（GPU 訓練映像，含兩種 Keras 後端） | 2–3 天 |
| 3 | C1–C4（vLLM 在開發機跑通、量化實測） | 2 天 |
| 4 | C5–C6（下載與 K8s 載入） | 3 天 |
| 5 | A8、B7、C7 與 M1 待辦 1、2、5（安裝腳本、版本清單、DCGM 監控）| 原生 Ubuntu 或甲方主機上 |

## 原生 Ubuntu 階段要重做或補做的事

在 WSL 上只能驗證到「容器能用 GPU」，以下要在原生 Ubuntu 24.04 + GPU 上完成：
- 安裝 NVIDIA 驅動（R580 以上）、GPU Operator（含 device plugin、time-slicing、DCGM exporter）；開發機的 RTX PRO 6000 **Workstation** Edition 不在 GPU Operator 官方支援清單，若裝不起來改用 device plugin + 自裝驅動。
- 真 GPU 節點接進 K8s，Kueue 配額以真實卡數與複本數驗證（A8）。
- 訓練 Job 在 K8s 上用 GPU（B7）；vLLM 以 Deployment 載入與卸載（C7）。
- 產出正式的版本清單（作業系統、驅動、CUDA、cuDNN、PyTorch、TensorFlow）。

## 附：實測紀錄（2026-10-05，WSL2 + Docker 29.8 + NVIDIA Container Toolkit 1.20，Windows 驅動 572.83）

```
== PyTorch (cu128) ==
2.8.0+cu128 12.8 True NVIDIA RTX PRO 6000 Blackwell Workstation Edition (12, 0)
matmul ok True
== TensorFlow latest-gpu ==
cuda_executor.cc:1755] Failed to determine cuDNN version ... CUDNN_STATUS_INTERNAL_ERROR
Skipping registering GPU devices...
2.21.0 12.5.1 9
GPUs []
== Keras 3 on torch backend ==
keras 3.15.1 backend torch cuda True
device of weights: cuda:0
h5 roundtrip ok True
== TF 2.21 + CUDA 12.8 / cuDNN 9.27 libs ==
tf 2.21.0 cuda 12.5.1 cudnn 9 archs ['sm_60', 'sm_70', 'sm_80', 'sm_89', 'compute_90']
GPUs []   (Skipping registering GPU devices...)
== TF 2.22.0rc0 (CUDA 12.9 libs) ==
GPUs [GPU:0] compute_capability (12, 0)
TensorFlow was not built with CUDA kernel binaries compatible with compute capability 12.0a. CUDA kernels will be jit-compiled from PTX
Failed to allocate device memory ... CUDA_ERROR_UNKNOWN  → OPS_FAIL
== NGC nvcr.io/nvidia/tensorflow:25.02-tf2-py3 ==
tf 2.17.0 cuda 12.8 cudnn 9 archs ['sm_100', 'sm_120', 'sm_75', 'sm_80', 'sm_86', 'compute_90']
ops {'matmul': 0.06, 'conv2d': 0.23} device GPU:0
keras fit first-epoch 1.13 s; next 3 epochs 0.17 s; h5 roundtrip True; weights on GPU:0
```

測試程式：`tf_probe.py`（列出 GPU、矩陣與卷積、Keras 小模型訓練 4 個 epoch、`.h5` 存讀）。

## 參考版本（2026-10-05）

| 元件 | 版本 |
|---|---|
| TensorFlow | 2.21.0（2.22.0rc0 加入 CUDA 13 設定，尚未正式） |
| PyTorch | 2.14.1（預設 CUDA 13.0；Blackwell 最低 2.7 + cu128） |
| vLLM | 0.31.0（`vllm/vllm-openai:v0.31.0`，CUDA 13.0；`-cu129` 變體） |
| NVIDIA GPU Operator | v26.7.1（DCGM exporter 內建） |
| Kueue | 0.19.7／0.20.0（repo 目前 0.19.6，v1beta2 不受影響） |
| 驅動需求 | CUDA 12.8 需 Linux ≥570.26；CUDA 13 需 ≥580；Windows 572.83 只到 CUDA 12.8 |
