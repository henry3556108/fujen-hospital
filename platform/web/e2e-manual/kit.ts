import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { login as kcLogin, useProject } from '../e2e-acceptance/helpers';

// 結案手冊與教學影片的共用工具：一個情境＝一個 Scenario。
// 每一步同時產出：手冊截圖（紅框）＋Markdown 步驟、影片時間軸（字幕＝同一句話）。用法見同目錄 README.md。

/** 產出根目錄（WSL 路徑）。測試時可用 MANUAL_ROOT 指到暫存資料夾。 */
export const ROOT = process.env.MANUAL_ROOT || '/mnt/c/Users/skyland/Desktop/workspace/結案-操作手冊與影片';
const W = 1440;
const H = 900;

/** 帳號 → 角色名稱（影片角落標示、轉場卡） */
export const ROLE_LABEL: Record<string, string> = {
  admin01: '系統管理者',
  pi01: '計畫主持人',
  md01: '醫師',
  ra01: '研究助理',
  ca01: '程式助理',
  vw01: '檢視者',
};

export type Action =
  | 'click'
  | { fill: string }
  | { select: string | { label: string } }
  | { upload: string | string[] }
  | { hover: true }
  | { press: string };

export interface StepOptions {
  /** 只放手冊、不上字幕的補充說明（一兩句） */
  detail?: string;
  /** false：影片這一步不放大（例如目標是整個表格） */
  zoom?: boolean;
  /** 動作後額外停留毫秒（讓觀眾看清結果），預設 0 */
  settle?: number;
}

export interface ScenarioOptions {
  /** 情境代號，例如 'A2'（檔名用） */
  id: string;
  /** 情境標題，例如 '選擇專案與功能目錄'（手冊節標題、轉場卡） */
  title: string;
  /** 帳號：admin01 pi01 md01 ra01 ca01 vw01 */
  role: string;
  /** 手冊資料夾名稱，例如 '02-計畫主持人' */
  manual: string;
  /** 是否錄影（預設 true） */
  video?: boolean;
  /** 開始前先在鏡頭外登入（預設 true）；false 時由情境自己呼叫 s.login() 錄下登入過程 */
  login?: boolean;
  /** 開始前先在鏡頭外切到此專案（例如 'P1-lung-ct'） */
  project?: string;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Seg {
  kind: 'action' | 'wait' | 'note';
  t0: number;
  t1: number;
  bbox: Box | null;
  zoom: boolean;
  caption: string;
  shot?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n: number) => String(n).padStart(2, '0');
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** 注入每個頁面的假游標與點擊漣漪（跟著真的滑鼠事件走；位置存在 sessionStorage，換頁後留在原處） */
function cursorScript() {
  const KEY = '__kitCursor';
  const install = () => {
    if (document.getElementById('__kit_cursor')) return;
    const style = document.createElement('style');
    style.textContent = `
      #__kit_cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;
        transform:translate(-100px,-100px);will-change:transform}
      .__kit_ripple{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;pointer-events:none;
        z-index:2147483646;border:3px solid rgba(229,57,53,.9);background:rgba(229,57,53,.25);
        animation:__kit_rip .55s ease-out forwards}
      @keyframes __kit_rip{to{transform:scale(3.6);opacity:0}}
      .__kit_hl{position:fixed;z-index:2147483645;pointer-events:none;border:3px solid #e53935;border-radius:8px;
        box-shadow:0 0 0 3px rgba(229,57,53,.18)}`;
    document.documentElement.appendChild(style);
    const c = document.createElement('div');
    c.id = '__kit_cursor';
    c.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.3 L11.6 24 L15 22.5 L11.7 15 L19 15 Z" ' +
      'fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    const put = (x: number, y: number) => {
      c.style.transform = `translate(${x - 3}px,${y - 2}px)`;
    };
    try {
      const p = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (p) put(p.x, p.y);
    } catch {
      /* 無痕或停用儲存時略過 */
    }
    window.addEventListener(
      'mousemove',
      (e) => {
        put(e.clientX, e.clientY);
        try {
          sessionStorage.setItem(KEY, JSON.stringify({ x: e.clientX, y: e.clientY }));
        } catch {
          /* 略過 */
        }
      },
      true,
    );
    window.addEventListener(
      'mousedown',
      (e) => {
        const r = document.createElement('div');
        r.className = '__kit_ripple';
        r.style.left = `${e.clientX}px`;
        r.style.top = `${e.clientY}px`;
        document.documentElement.appendChild(r);
        setTimeout(() => r.remove(), 700);
      },
      true,
    );
  };
  if (document.documentElement) install();
  document.addEventListener('DOMContentLoaded', install);
}

export class Scenario {
  readonly ctx: BrowserContext;
  readonly page: Page;
  readonly opts: ScenarioOptions;
  private t0Video = 0;
  private segs: Seg[] = [];
  private blocks: string[] = [];
  private shots = 0;
  private stepNo = 0;
  private inSteps = false;
  private mouse = { x: W / 2, y: H / 2 };

  constructor(ctx: BrowserContext, page: Page, opts: ScenarioOptions) {
    this.ctx = ctx;
    this.page = page;
    this.opts = opts;
  }

  /** 由 startScenario 呼叫：記下錄影起點 */
  markVideoStart() {
    this.t0Video = Date.now();
  }

  private now() {
    return (Date.now() - this.t0Video) / 1000;
  }
  private get imgDir() {
    return path.join(ROOT, '手冊/img', this.opts.manual);
  }

  /** 手冊截圖（不含游標），回傳 Markdown 用的相對路徑（相對於片段檔） */
  private async screenshot(): Promise<string> {
    this.shots += 1;
    const name = `${this.opts.id}-${pad2(this.shots)}.jpg`;
    fs.mkdirSync(this.imgDir, { recursive: true });
    await this.page.evaluate(() => document.getElementById('__kit_cursor')?.style.setProperty('visibility', 'hidden')).catch(() => undefined);
    await this.page.screenshot({ path: path.join(this.imgDir, name), type: 'jpeg', quality: 80 });
    await this.page.evaluate(() => document.getElementById('__kit_cursor')?.style.removeProperty('visibility')).catch(() => undefined);
    return `../../img/${this.opts.manual}/${name}`;
  }

  /** 平滑移動滑鼠（假游標跟著走） */
  private async moveTo(x: number, y: number, ms = 550) {
    const from = { ...this.mouse };
    const n = Math.max(8, Math.round(ms / 22));
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      await this.page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      await sleep(ms / n / 2);
    }
    this.mouse = { x, y };
  }

  private async highlight(b: Box) {
    await this.page.evaluate((r) => {
      const d = document.createElement('div');
      d.className = '__kit_hl';
      const p = 5;
      Object.assign(d.style, { left: `${r.x - p}px`, top: `${r.y - p}px`, width: `${r.w + 2 * p}px`, height: `${r.h + 2 * p}px` });
      document.documentElement.appendChild(d);
    }, b);
  }
  private async unhighlight() {
    await this.page.evaluate(() => document.querySelectorAll('.__kit_hl').forEach((e) => e.remove())).catch(() => undefined);
  }

  private stepText(caption: string, img: string, detail?: string) {
    if (!this.inSteps) {
      this.blocks.push('### 操作步驟');
      this.inSteps = true;
    }
    this.stepNo += 1;
    let s = `${this.stepNo}. ${caption}\n\n    ![](${img})`;
    if (detail) s += `\n\n    ${detail}`;
    this.blocks.push(s);
  }

  private checkCaption(caption: string) {
    if ([...caption].length > 30) console.warn(`[${this.opts.id}] 字幕偏長（${[...caption].length} 字）：${caption}`);
  }

  private async settle(extra = 0) {
    await this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
    await sleep(450 + extra);
  }

  /**
   * 一步操作：游標移到元素 → 紅框 → 手冊截圖 → 執行動作 → 移除紅框。
   * caption 同時是手冊步驟文字與影片字幕（一句短句）。action 省略時只指出元素（例如「畫面右上角顯示目前專案」）。
   */
  async step(caption: string, target: Locator, action?: Action, o: StepOptions = {}) {
    this.checkCaption(caption);
    const t0 = this.now();
    await target.first().scrollIntoViewIfNeeded().catch(() => undefined);
    const bb = await target.first().boundingBox();
    if (!bb) throw new Error(`[${this.opts.id}] 找不到可見元素：${caption}`);
    const box = { x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.width), h: Math.round(bb.height) };
    await this.moveTo(box.x + box.w / 2, box.y + box.h / 2);
    await this.highlight(box);
    const img = await this.screenshot();
    this.stepText(caption, img, o.detail);
    await sleep(500); // 讓影片看得到紅框
    await this.act(target.first(), action);
    await this.unhighlight();
    await this.settle(o.settle);
    this.segs.push({ kind: 'action', t0, t1: this.now(), bbox: box, zoom: o.zoom !== false, caption, shot: img });
  }

  private async act(el: Locator, action?: Action) {
    if (!action) return;
    if (action === 'click') return el.click();
    if ('fill' in action) {
      await el.click();
      await el.fill('');
      if (action.fill.length <= 60) await el.pressSequentially(action.fill, { delay: 45 });
      else await el.fill(action.fill);
      return;
    }
    if ('select' in action) {
      await el.selectOption(action.select);
      return;
    }
    if ('upload' in action) {
      const isInput = await el.evaluate((n) => n instanceof HTMLInputElement && n.type === 'file');
      if (isInput) return el.setInputFiles(action.upload);
      const chooser = this.page.waitForEvent('filechooser');
      await el.click();
      return (await chooser).setFiles(action.upload);
    }
    if ('hover' in action) return el.hover();
    if ('press' in action) return el.press(action.press);
  }

  /** 不指定元素的說明畫面（整頁截圖、不加框、影片不放大），例如「畫面顯示專案首頁」 */
  async note(caption: string, o: { detail?: string; hold?: number } = {}) {
    this.checkCaption(caption);
    const t0 = this.now();
    await this.settle();
    const img = await this.screenshot();
    this.stepText(caption, img, o.detail);
    await sleep(o.hold ?? 800);
    this.segs.push({ kind: 'note', t0, t1: this.now(), bbox: null, zoom: false, caption, shot: img });
  }

  /**
   * 等待類（上傳、訓練、載入）：執行 fn 直到完成；影片中過長會自動加速並標「加速 ×N」。
   * 完成後截一張圖當作手冊的一步（manual: false 時不寫進手冊）。
   */
  async wait(caption: string, fn: () => Promise<unknown>, o: { manual?: boolean; detail?: string } = {}) {
    this.checkCaption(caption);
    const t0 = this.now();
    await fn();
    await this.settle();
    let img: string | undefined;
    if (o.manual !== false) {
      img = await this.screenshot();
      this.stepText(caption, img, o.detail);
    }
    this.segs.push({ kind: 'wait', t0, t1: this.now(), bbox: null, zoom: false, caption, shot: img });
  }

  /** 手冊文字段落：目的、開始前準備、完成後的樣子、常見問題（依呼叫順序排在步驟前後） */
  section(heading: string, text: string) {
    this.inSteps = false;
    this.blocks.push(`### ${heading}\n\n${text.trim()}`);
  }

  /** 在鏡頭前登入（startScenario 設 login: false 時使用） */
  async login() {
    const pw = this.opts.role === 'admin01' ? 'Admin01-dev!' : 'Dev-Passw0rd!';
    const p = this.page;
    if (!/\/realms\//.test(p.url())) {
      await p.goto('/');
      await p.waitForLoadState('networkidle').catch(() => undefined);
      await this.step('按「登入」前往登入頁', p.getByRole('button', { name: '登入' }), 'click');
    }
    await this.step(`在「帳號」欄輸入 ${this.opts.role}`, p.locator('#username'), { fill: this.opts.role });
    await this.step('在「密碼」欄輸入密碼', p.locator('#password'), { fill: pw });
    await this.step('按「登入」', p.locator('#kc-login'), 'click');
    await expect(p.locator('.topbar__username')).toHaveText(this.opts.role, { timeout: 20_000 });
  }

  /** 寫出手冊片段、時間軸，存影片 */
  async finish() {
    const { id, manual, title, role } = this.opts;
    const mdDir = path.join(ROOT, '手冊/md/片段', manual);
    fs.mkdirSync(mdDir, { recursive: true });
    fs.writeFileSync(path.join(mdDir, `${id}.md`), `## ${title}\n\n${this.blocks.join('\n\n')}\n`);

    const video = this.page.video();
    await this.ctx.close();
    let videoPath: string | null = null;
    if (video && this.opts.video !== false) {
      videoPath = path.join(ROOT, '影片/原始', `${id}.webm`);
      fs.mkdirSync(path.dirname(videoPath), { recursive: true });
      await video.saveAs(videoPath);
      await video.delete().catch(() => undefined);
    }
    const tl = { id, title, role, roleLabel: ROLE_LABEL[role] ?? role, manual, video: videoPath, size: [W, H], segments: this.segs };
    const tlDir = path.join(ROOT, '審片/時間軸');
    fs.mkdirSync(tlDir, { recursive: true });
    fs.writeFileSync(path.join(tlDir, `${id}.json`), JSON.stringify(tl, null, 2));
    console.log(`[${id}] 完成：${this.stepNo} 步、${this.segs.length} 段，片段 ${path.join(mdDir, `${id}.md`)}`);
  }
}

/** 開一個情境：新瀏覽器環境（錄影 1440×900）、注入假游標、（預設）鏡頭外登入與切專案 */
export async function startScenario(browser: Browser, opts: ScenarioOptions): Promise<Scenario> {
  const tmpVideo = path.join(process.env.MANUAL_OUT || 'test-results/manual', 'video-tmp', opts.id);
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    ...(opts.video === false ? {} : { recordVideo: { dir: tmpVideo, size: { width: W, height: H } } }),
  });
  await ctx.addInitScript(cursorScript);
  const page = await ctx.newPage();
  const s = new Scenario(ctx, page, opts);
  s.markVideoStart();
  if (opts.login !== false) {
    await kcLogin(page, opts.role);
    if (opts.project) await useProject(page, opts.project);
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }
  await page.mouse.move(W / 2, H / 2);
  return s;
}
