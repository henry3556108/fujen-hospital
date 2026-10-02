# 網頁前端的正式映像：Node 建置打包檔，nginx（非 root）提供靜態檔。網址在執行期設定（/config.js），同一個映像用在每個環境。
#   docker build -t platform-web:dev platform/web
# 執行期環境變數（都是公開設定，不放任何密碼）：
#   WEB_API_BASE          平台 API 的位址；空字串＝與網頁同源（經 Gateway 9082，/api 在同一個 Gateway 上）
#   WEB_OIDC_AUTHORITY    Keycloak realm，例：https://keycloak.example/realms/ai-platform
#   WEB_OIDC_CLIENT_ID    預設 ai-platform-web
#   WEB_OHIF_BASE         OHIF 檢視器（Gateway 9081）
#   WEB_GRAFANA_URL、WEB_PROMETHEUS_URL、WEB_ALERTMANAGER_URL、WEB_MAILPIT_URL   監控頁的連結
FROM node:22.23.3-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# 打包期不帶任何環境網址（測試登入與 API 模擬在 vite build 一律移除，見 tests/unit/prod-build.test.ts）
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31.6-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/40-platform-config.sh /docker-entrypoint.d/40-platform-config.sh
COPY --from=build /src/dist /usr/share/nginx/html
USER root
# config.js 在啟動時改寫；其他檔案唯讀
RUN chmod 755 /docker-entrypoint.d/40-platform-config.sh \
 && chown 101:101 /usr/share/nginx/html/config.js
USER 101
EXPOSE 8080
