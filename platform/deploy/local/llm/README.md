# WP7 本機整合環境的附屬檔案

`preload/`：離線預載目錄的範例（掛進 api 容器的 `/opt/llm-preload`）。每個模型一個資料夾，
內含 `manifest.json`（`repo`、`commit`）與模型檔。這裡只有幾個位元組的設定檔，沒有任何權重。

甲方環境沒有對外網路時，把核准的模型放進同樣結構的目錄，並在白名單登記相同的 commit 與 hash；
平台連不上來源時會改從這裡取，取回後一樣核對 commit 與 hash。
