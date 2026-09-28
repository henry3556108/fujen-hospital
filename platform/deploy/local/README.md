# 本機整合環境（Docker Compose）

PostgreSQL、Keycloak、APISIX Gateway、平台 API。平台 API 不對主機開放連接埠，只能經 Gateway（`http://localhost:9080`）存取。

## 啟動

```bash
cd platform/deploy/local
docker compose up -d --build
docker compose exec -T api /app/.venv/bin/python -m app.seed   # 重建測試基線：3 個專案、8 個帳號
```

Keycloak 管理台：`http://localhost:8080`（本機管理帳號見 `compose.yaml`）。

## 驗收與端對端測試

```bash
cd platform/acceptance && uv run pytest -q                      # TC-SS、TC-A03，經 Gateway
cd platform/web && VITE_API_BASE=http://localhost:9080 VITE_AUTH_MODE=oidc npm run dev   # 另一個終端
cd platform/web && npm run test:e2e:real                          # 真的 Keycloak 登入
```

## 已知狀況

- 若 `docker pull` 卡住不動，通常是 Docker Desktop 的憑證工具在等 macOS 鑰匙圈授權。可以按下鑰匙圈視窗的「允許」，或暫時用不含 `credsStore` 的設定檔下載公開映像：
  `DOCKER_CONFIG=<含 {"auths":{}} 的資料夾> DOCKER_HOST=unix://$HOME/.docker/run/docker.sock docker compose pull`
- `realm-ai-platform.json` 的 `directAccessGrantsEnabled` 只為本機驗收腳本取 token，正式環境必須關閉。
- 所有密碼都是本機測試值，不可用於甲方環境。

## 停止

```bash
docker compose down        # 保留資料
docker compose down -v     # 連同資料庫一起清掉
```
