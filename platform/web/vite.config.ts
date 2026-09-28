/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// MSW 的 service worker 只由 dev server 提供，不放 public/，因此不會進 production build。
function mswWorkerDevOnly(): Plugin {
  return {
    name: 'msw-worker-dev-only',
    apply: 'serve',
    configureServer(server) {
      const file = createRequire(import.meta.url).resolve('msw/mockServiceWorker.js');
      server.middlewares.use('/mockServiceWorker.js', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(readFileSync(file));
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), mswWorkerDevOnly()],
  // 只有 dev server（含 Vitest）為 true；任何 vite build 都是 false，用來移除測試登入與 API 模擬。
  define: { __DEV_SERVER__: JSON.stringify(command === 'serve') },
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    css: false,
    // Node 25 內建的 localStorage 會蓋掉 jsdom 的實作
    execArgv: ['--no-experimental-webstorage'],
  },
}));
