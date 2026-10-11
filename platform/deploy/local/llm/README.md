# WP7 本機整合環境的附屬檔案

## 預設模型（`models.json`）

疊加 `compose.ollama.yaml` 時使用真的模型：Ollama（GPU）跑對話與向量模型，模型檔由平台從 Hugging Face 下載。

| 名稱 | 來源 | 用途 | 授權 |
|---|---|---|---|
| gemma-3-4b-it | ggml-org/gemma-3-4b-it-GGUF（Google Gemma 3 4B Instruct） | 對話；4-bit（Q4_K_M）與 8-bit（Q8_0） | Gemma Terms of Use |
| embeddinggemma-300m | ggml-org/embeddinggemma-300M-GGUF（Google EmbeddingGemma 300M） | 知識庫向量（多語言、768 維）；8-bit（Q8_0） | Gemma Terms of Use |

向量模型選多語言的 EmbeddingGemma：以合成的 6 份中文文件測試，10 題檢索全中；英文為主的 nomic-embed-text-v1.5 只中 8 題。
查詢與文件會依模型加上任務前綴（`app/llm/knowledge.py` 的 `EMBED_PREFIXES`）。

每項都固定 commit 與內容 hash（`sha256`，以 `/api/admin/llm/whitelist/inspect` 取得），`files` 限定只下載哪些檔。
安裝後執行一次（可重複執行，已完成的步驟會略過）：

```
docker compose exec -T api /app/.venv/bin/python -m app.llm.model_setup /opt/llm-models.json
```

依序：登記白名單 → 申請下載 → 核准 → 下載並核對 commit 與 hash → 依 `load` 的設定（量化、CPU、記憶體、GPU）載入。
每一步都以 `system-setup` 寫進稽核。需要授權的模型加 `--token hf_xxx`（Token 不會被儲存，只記指紋）。
換模型：用管理介面或 inspect API 取得新的 commit 與 hash，改 `models.json` 後重跑。

對外連線：api 要能連 `huggingface.co`，以及 Hugging Face 大檔轉址的 `cas-bridge.xethub.hf.co`。

## 離線預載（`preload/`）

掛進 api 容器的 `/opt/llm-preload`（`LLM_PRELOAD_HOST_DIR` 可改成主機上其他目錄）。每個模型一個資料夾，
資料夾名稱同白名單的名稱，內含 `manifest.json`（`repo`、`commit`）與模型檔：

```
preload/
  gemma-3-4b-it/
    manifest.json        {"repo": "ggml-org/gemma-3-4b-it-GGUF", "commit": "d0976223747697cb51e056d85c532013931fe52e"}
    gemma-3-4b-it-Q4_K_M.gguf
    gemma-3-4b-it-Q8_0.gguf
```

平台連不上來源時改從這裡取，取回後一樣核對 commit 與 hash，與白名單登記的不同就拒絕。
甲方環境沒有對外網路時，先在可上網的機器下載同一個 commit 的檔案，放進這個結構再帶進去。
這個 repo 裡的 `offline-small` 只有幾個位元組的設定檔，給驗收測試用，沒有任何權重。
