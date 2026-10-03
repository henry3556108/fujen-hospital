// 用法：node act.mjs <截圖名稱> '<要執行的 JS，可用變數 page>'
// 執行後自動截圖到 shots/<名稱>.png，並印出目前網址與頁面上的可見文字（前 2500 字）。
import { createRequire } from 'module'; const require = createRequire(new URL('../../platform/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test'); import fs from 'fs';
const [name, code = ''] = process.argv.slice(2);
const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
const ctx = b.contexts()[0]; const page = ctx.pages()[0] || await ctx.newPage();
try { await (new Function('page', 'return (async () => {' + code + '})()'))(page); } catch (e) { console.log('ACTION ERROR:', String(e).split('\n')[0]); }
await page.waitForTimeout(1500); fs.mkdirSync('./shots', { recursive: true });
await page.screenshot({ path: './shots/' + name + '.png', fullPage: true });
console.log('URL:', page.url()); console.log((await page.locator('body').innerText()).slice(0, 2500));
process.exit(0);
