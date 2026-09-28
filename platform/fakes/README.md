# fakes：測試用假模型服務

> **警告：僅供開發與測試。絕對不可部署到甲方（客戶）的正式環境。**
> 這兩個服務回傳的是依雜湊產生的固定假資料，不是任何模型的推論結果。

不下載任何模型權重，就能把平台從頭到尾跑一遍冒煙測試。平台程式不需修改，只要把服務網址指向這裡。

## 取代什麼

| 假服務 | 取代 | 介面 | 預設埠 |
|---|---|---|---|
| `fakes.llm` | vLLM（正式環境）／Ollama（Mac） | OpenAI 相容：`GET /v1/models`、`POST /v1/chat/completions`（含 `stream: true`）、`POST /v1/embeddings` | 8101 |
| `fakes.autolabel` | MONAI Label | `GET /info/`、`POST /infer/{model}?image=<影像 ID>` | 8102 |

行為重點：

- 對話回應固定為 `[fake-llm] params{收到的取樣參數} [context: 檢索內容前 60 字 |] echo: 最後一則使用者訊息`，可驗證參數與 RAG 檢索內容確實送到模型；`max_tokens` 以字數截斷。Token 數＝空白分隔字數。
- Embedding 為 384 維、L2 正規化，同一文字結果相同，共用字詞的文字相似度較高。
- 自動標註結果只由「模型＋影像 ID」決定，可重現；分割回傳 RLE 遮罩與 `label_names`，偵測回傳框與分數。
- 故障注入：標頭 `X-Fake-Delay-Ms`（延遲毫秒）、`X-Fake-Status`（回傳指定狀態碼）；環境變數 `FAKE_LLM_DELAY_MS`、`FAKE_LLM_FAIL_RATE`、`FAKE_AUTOLABEL_DELAY_MS`、`FAKE_AUTOLABEL_FAIL_RATE`（0–1，依請求序號決定，可重現）。

## 執行

```bash
cd platform/fakes
uv sync
uv run pytest                                   # 測試
uv run python -m fakes.llm --port 8101          # 假 LLM
uv run python -m fakes.autolabel --port 8102    # 假 MONAI Label
```

平台設定：LLM base URL 設為 `http://localhost:8101/v1`，模型 `fake-llm-small`、`fake-embed-small`；自動標註服務設為 `http://localhost:8102`。

容器（同一映像，以 `FAKE_SERVICE` 選擇）：

```bash
docker build -t ai-platform-fakes platform/fakes
docker run -e FAKE_SERVICE=llm -p 8101:8101 ai-platform-fakes
docker run -e FAKE_SERVICE=autolabel -p 8102:8102 ai-platform-fakes
```

## 支援的驗收案例

- B-03 自動標註：TC-B03-01、TC-B03-02（Mac 只驗流程）、TC-B03-03、TC-B03-04（只驗格式，不驗正確率）、TC-B03-05（以 `X-Fake-Status` 或停止服務模擬離線）
- B-07 LLM 與 RAG：TC-B07-03（Playground，含逾時提示）、TC-B07-05（生成參數）、TC-B07-06（RAG 建庫）、TC-B07-07（發布 API）、TC-B07-08（服務中斷）
- B-08 工作流與 Wiki：TC-B08-01、TC-B08-03、TC-B08-04（紀錄中可看到 LLM 請求與回應）

不適用：TC-B07-01（真實模型下載）、TC-B07-04（量化載入，需甲方實機），以及任何回應品質或正確率的驗證。
