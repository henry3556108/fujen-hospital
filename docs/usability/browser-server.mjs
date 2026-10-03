// 開一個持續存在的瀏覽器（保留登入狀態與分頁），動作腳本以 CDP 連到 127.0.0.1:9333。
import { createRequire } from 'module'; const require = createRequire(new URL('../../platform/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const ctx = await chromium.launchPersistentContext('./profile', { channel: 'msedge', headless: true,
  viewport: { width: 1440, height: 900 }, locale: 'zh-TW', acceptDownloads: true, args: ['--remote-debugging-port=9333'] });
if (!ctx.pages().length) await ctx.newPage();
console.log('browser ready'); setInterval(() => {}, 1 << 30);
