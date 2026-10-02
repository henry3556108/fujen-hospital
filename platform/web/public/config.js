// 執行期設定（見 src/runtimeConfig.ts）。開發時是空的；容器啟動時由 /docker-entrypoint.d/40-platform-config.sh 覆寫。
window.__PLATFORM_CONFIG__ = window.__PLATFORM_CONFIG__ || {};
