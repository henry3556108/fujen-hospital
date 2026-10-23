import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { EVIDENCE_DIR, clickMenu, login, note, useProject } from './helpers';

// M2 流程程式碼驗證（Desktop\workspace\M2驗證\00～09）共用：專案、帳號、流程程式碼表格、下載上傳、訓練紀錄、指標比對。
// 截圖與紀錄存到 <EVIDENCE_DIR>/<編號>/（run-m2.sh 指到 Desktop\workspace\M2測試紀錄）。
// 文字一律照原始碼（StagesPanel.tsx、stages.ts、api/app/training/stages.py 等）；與 md 不同處在紀錄裡標「與 md 不同」。

export const PA = 'M2-FLOW-A';
export const PB = 'M2-FLOW-B';
export const SETTING = 'FLOW-結構式';
export const DS = 'cohort_01';
export const DS80 = 'cohort_01-前80列';
export const DEMO_CSV = process.env.M2_DEMO_CSV || '/mnt/c/Users/skyland/Desktop/workspace/Demo腳本/演示資料/2-病人資料-cohort_01.csv';
export const CSV80 = process.env.M2_CSV80 || '/mnt/c/Users/skyland/Desktop/workspace/M2驗證/資料/cohort_01-前80列.csv';
export const FEATURES = ['age', 'sex', 'bmi', 'sbp', 'dbp', 'glucose', 'smoker'];
export const SERVICE = 'M2 驗證服務';
export const TRAIN_TIMEOUT = Number(process.env.M2_TRAIN_TIMEOUT_MIN || 20) * 60_000;

/** 流程環節表格的列名稱：來自 API（stages.py 的 STAGE_NAMES），部署是「模型匯出與部署」 */
export const ROW = { import: '資料匯入', labels: '標註', preprocess: '資料清理與前處理', train: '訓練', deploy: '模型匯出與部署' } as const;
/** 編輯區標題與「套用」按鈕：來自網頁（stages.ts 的 STAGE_NAMES），部署是「部署」 */
export const WEB = { import: '資料匯入', labels: '標註', preprocess: '資料清理與前處理', train: '訓練', deploy: '部署' } as const;
export type Stage = keyof typeof ROW;

export const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** <EVIDENCE_DIR>/<編號>/（不存在就建立） */
export function dirOf(tc: string, ...sub: string[]) {
  const d = path.join(EVIDENCE_DIR, tc, ...sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function begin(tc: string, title: string) {
  note(tc, `===== ${title} 開始（平台 ${process.env.WEB_URL || 'http://localhost:38982'}）=====`);
}

export function step(tc: string, n: number | string, text: string) {
  note(tc, `步驟 ${n}：${text}`);
}

/** 通過條件：逐項記錄，不中斷；finish() 時有不通過就讓測試失敗。與 md 不同但照原始碼的行為用 diff() 記錄。 */
export class Checks {
  readonly items: { name: string; ok: boolean }[] = [];
  constructor(readonly tc: string) {}

  check(name: string, ok: boolean, detail = '') {
    this.items.push({ name, ok });
    note(this.tc, `${ok ? '［通過］' : '［不通過］'}${name}${detail ? `：${detail}` : ''}`);
    return ok;
  }

  diff(text: string) {
    note(this.tc, `［與 md 不同］${text}`);
  }

  finish() {
    const bad = this.items.filter((c) => !c.ok).map((c) => c.name);
    note(this.tc, `===== 結束：檢查 ${this.items.length} 項，通過 ${this.items.length - bad.length} 項${bad.length ? `；不通過：${bad.join('、')}` : ''} =====`);
    expect(bad, '不通過的檢查項目').toEqual([]);
  }
}

// ---------------------------------------------------------------- 跨 spec 的狀態（訓練編號等）

const stateFile = () => path.join(EVIDENCE_DIR, 'm2-state.json');

export function loadState(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function saveState(patch: Record<string, unknown>) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify({ ...loadState(), ...patch }, null, 2));
}

// ---------------------------------------------------------------- 登入與專案

/** 每個帳號一個新的瀏覽器環境（等同無痕視窗），登入後切到指定專案 */
export async function openAs(browser: Browser, user: string, project?: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  await login(page, user);
  if (project) await switchProject(page, project);
  return { ctx, page };
}

/** 右上角「目前專案」切換 */
export async function switchProject(page: Page, name: string) {
  await page.getByLabel('目前專案', { exact: true }).waitFor();
  await useProject(page, name);
  await page.waitForLoadState('networkidle');
}

/** 左側「數據管理」→「結構式資料（CSV 表格）」 */
export async function gotoTabular(page: Page) {
  await clickMenu(page, '數據管理');
  await page.getByRole('navigation', { name: '數據管理分頁' }).getByRole('link', { name: '結構式資料（CSV 表格）', exact: true }).click();
  await expect(page.getByRole('table', { name: '資料集列表' })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

// ---------------------------------------------------------------- 建模管理

export async function gotoTraining(page: Page) {
  await clickMenu(page, '建模管理');
  await expect(page.getByRole('heading', { level: 1, name: '建模管理' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '訓練設定', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

export const settingsTable = (page: Page) => page.getByRole('table', { name: '訓練設定清單' });

export function settingRow(page: Page, name: string) {
  return settingsTable(page).getByRole('row').filter({ has: page.getByRole('button', { name: `送出訓練「${name}」`, exact: true }) });
}

export async function settingExists(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  return (await page.getByRole('button', { name: `送出訓練「${name}」`, exact: true }).count()) > 0;
}

/** 名稱旁「匯入控制：…」標籤的文字（沒有時空字串） */
export async function lockBadge(page: Page, name: string) {
  const badge = settingRow(page, name).getByTestId('locked-stages');
  return (await badge.count()) ? flat(await badge.innerText()) : '';
}

/** 按「流程程式碼「設定名稱」」，回傳下方出現的「流程程式碼「設定名稱」」區塊 */
export async function openFlow(page: Page, name: string) {
  const panel = page.getByRole('region', { name: `流程程式碼「${name}」` });
  if (!(await panel.count())) await page.getByRole('button', { name: `流程程式碼「${name}」`, exact: true }).click();
  await expect(panel.getByRole('table', { name: '流程環節' })).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  return panel;
}

export async function closeFlow(panel: Locator) {
  if (await panel.count()) await panel.getByRole('button', { name: '關閉流程程式碼', exact: true }).click();
}

export function stageRow(panel: Locator, rowName: string) {
  return panel.getByRole('table', { name: '流程環節' }).getByRole('row').filter({ has: panel.page().getByRole('rowheader', { name: rowName, exact: true }) });
}

/** 某一列「目前由誰控制」：介面設定／匯入檔控制（含說明） */
export async function stageState(panel: Locator, rowName: string) {
  return flat(await stageRow(panel, rowName).getByRole('cell').first().innerText());
}

export async function stageStates(panel: Locator) {
  const out: Record<string, string> = {};
  for (const n of Object.values(ROW)) {
    const t = await stageState(panel, n);
    out[n] = t.includes('匯入檔控制') ? '匯入檔控制' : t.startsWith('介面設定') ? '介面設定' : t;
  }
  return out;
}

export const statesText = (s: Record<string, string>) => Object.entries(s).map(([k, v]) => `${k}＝${v}`).join('、');

/** 「檢視程式碼／檢視設定檔」後出現的編輯區 */
export function editor(panel: Locator, stage: Stage) {
  const code = stage === 'labels' || stage === 'preprocess' || stage === 'train';
  return panel.getByRole('group', { name: `${code ? '程式碼' : '設定檔'}「${WEB[stage]}」` });
}

export async function openEditor(panel: Locator, stage: Stage) {
  const code = stage === 'labels' || stage === 'preprocess' || stage === 'train';
  await panel.getByRole('button', { name: `${code ? '檢視程式碼' : '檢視設定檔'}「${ROW[stage]}」`, exact: true }).click();
  const ed = editor(panel, stage);
  await expect(ed).toBeVisible();
  await ed.scrollIntoViewIfNeeded();
  return ed;
}

export const textArea = (ed: Locator, file: string) => ed.getByLabel(file, { exact: true });

/** 綠色訊息（role=status）中含有指定文字的那一則 */
export function statusMsg(scope: Page | Locator, text: string | RegExp) {
  return scope.getByRole('status').filter({ hasText: text });
}

/** 紅框（role=alert）的文字與「錯誤清單」各項 */
export async function errorAlert(scope: Locator) {
  const alert = scope.getByRole('alert').first();
  await expect(alert).toBeVisible({ timeout: 30_000 });
  const items = alert.getByRole('list', { name: '錯誤清單' }).getByRole('listitem');
  const list = (await items.count()) ? (await items.allInnerTexts()).map(flat) : [];
  return { text: flat(await alert.innerText()), list };
}

/** 改回用介面設定「列名稱」→ 確認視窗 */
export async function openUnlock(panel: Locator, rowName: string) {
  await panel.getByRole('button', { name: `改回用介面設定「${rowName}」`, exact: true }).click();
  const dlg = panel.page().getByRole('dialog', { name: `改回用介面設定「${rowName}」？` });
  await expect(dlg).toBeVisible();
  return dlg;
}

// ---------------------------------------------------------------- 匯入專案包

/** 「建模管理」→「匯入專案包」，回傳「匯入整個流程（專案包）」區塊 */
export async function openPackageImport(page: Page) {
  const region = page.getByRole('region', { name: '匯入整個流程（專案包）' });
  if (!(await region.count())) await page.getByRole('button', { name: '匯入專案包', exact: true }).click();
  await expect(region).toBeVisible();
  await region.scrollIntoViewIfNeeded();
  return region;
}

/** 「專案包（zip）」選檔，按「檢查專案包」，回傳「檢查結果」 */
export async function checkPackage(region: Locator, file: string) {
  await region.getByLabel('專案包（zip）', { exact: true }).setInputFiles(file);
  await region.getByRole('button', { name: '檢查專案包', exact: true }).click();
  const result = region.getByRole('group', { name: '檢查結果' });
  await expect(result.or(region.getByRole('alert').first())).toBeVisible({ timeout: 120_000 });
  if (!(await result.isVisible())) throw new Error(`檢查專案包失敗：${flat(await region.getByRole('alert').first().innerText())}`);
  return result;
}

/** 檢查結果的各部分文字 */
export async function planInfo(result: Locator) {
  const text = async (l: Locator) => ((await l.count()) ? flat(await l.first().innerText()) : '');
  const errors = await text(result.getByRole('alert'));
  const warnItems = result.getByRole('list', { name: '注意事項' }).getByRole('listitem');
  const warnings = (await warnItems.count()) ? (await warnItems.allInnerTexts()).map(flat) : [];
  const contents = await text(result.getByLabel('專案包內容', { exact: true }));
  const mapping = await text(result.getByTestId('package-mapping'));
  const button = result.getByRole('button', { name: /^(匯入「|處理中…)/ });
  const buttonText = await text(button);
  const enabled = (await button.count()) ? await button.first().isEnabled() : false;
  return { errors, warnings, contents, mapping, button, buttonText, enabled };
}

/** 匯入後頂端訊息：建立的訓練設定名稱與資料說明 */
export async function importedNotice(page: Page) {
  const msg = statusMsg(page, '已匯入專案包，建立訓練設定「').first();
  await expect(msg.or(page.getByRole('alert').first())).toBeVisible({ timeout: 120_000 });
  if (!(await msg.isVisible())) throw new Error(`匯入專案包失敗：${flat(await page.getByRole('alert').first().innerText())}`);
  const text = flat(await msg.innerText());
  const setting = /建立訓練設定「(.+?)」。/.exec(text)?.[1] ?? '';
  return { text, setting };
}

// ---------------------------------------------------------------- 下載、上傳、zip

/** 按下按鈕並存下瀏覽器下載的檔案；saveAs 省略時用伺服器給的檔名 */
export async function download(page: Page, click: () => Promise<unknown>, saveDir: string, saveAs?: string) {
  fs.mkdirSync(saveDir, { recursive: true });
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), click()]);
  const file = path.join(saveDir, saveAs ?? d.suggestedFilename());
  await d.saveAs(file);
  return { file, suggested: d.suggestedFilename() };
}

/** 按下按鈕後在檔案選擇視窗選檔（等同使用者選檔） */
export async function chooseFile(page: Page, click: () => Promise<unknown>, file: string) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), click()]);
  await chooser.setFiles(file);
}

const py = (code: string, args: string[]) =>
  execFileSync('python3', ['-c', code, ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });

export const zipList = (file: string) =>
  py('import sys,zipfile\nfor n in zipfile.ZipFile(sys.argv[1]).namelist(): print(n)', [file]).split('\n').filter(Boolean);

export const zipRead = (file: string, name: string) =>
  py('import sys,zipfile\nsys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', [file, name]);

export function unzip(file: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  py('import sys,zipfile\nzipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', [file, dest]);
}

/** 在 JSON 文字中找某個鍵的數值（任何深度） */
export function findNumber(text: string, key: string): number | null {
  const m = new RegExp(`"${esc(key)}"\\s*:\\s*(-?[0-9.]+)`).exec(text);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- 表單

/** 下拉選單選「以 prefix 開頭」的選項（例如資料集「cohort_01（100 列）」），回傳選到的文字 */
export async function selectByPrefix(select: Locator, prefix: string) {
  await expect(select.locator('option').filter({ hasText: prefix }).first()).toBeAttached({ timeout: 15_000 });
  const labels = (await select.locator('option').allInnerTexts()).map((s) => s.trim());
  const label = labels.find((l) => l.startsWith(prefix));
  if (!label) throw new Error(`選單沒有以「${prefix}」開頭的選項：${labels.join('、')}`);
  await select.selectOption({ label });
  return label;
}

/** 「用來預測的資料（Feature）」只勾 wanted，其他取消 */
export async function setFeatures(form: Locator, wanted: string[]) {
  const group = form.getByRole('group', { name: '用來預測的資料（Feature）' });
  await expect(group).toBeVisible();
  const labels = group.locator('label');
  const n = await labels.count();
  const checked: string[] = [];
  for (let i = 0; i < n; i++) {
    const label = labels.nth(i);
    const text = flat(await label.innerText());
    const on = wanted.some((w) => text === w || text.startsWith(`${w}（`));
    await label.getByRole('checkbox').setChecked(on);
    if (on) checked.push(text);
  }
  return checked;
}

// ---------------------------------------------------------------- 訓練紀錄

export const runsTable = (page: Page) => page.getByRole('table', { name: '訓練清單' });

export function runRow(page: Page, id: number) {
  return runsTable(page).getByRole('row').filter({ has: page.getByRole('cell', { name: `#${id}`, exact: true }) });
}

/** 按「送出訓練「名稱」」，回傳畫面訊息中的訓練編號 */
export async function submitTraining(page: Page, name: string) {
  await page.getByRole('button', { name: `送出訓練「${name}」`, exact: true }).click();
  const msg = statusMsg(page, new RegExp(`訓練 #\\d+（${esc(name)}）`)).first();
  const err = page.getByRole('alert').first();
  await expect(msg.or(err)).toBeVisible({ timeout: 30_000 });
  if (!(await msg.isVisible())) throw new Error(`送出訓練失敗：${flat(await err.innerText())}`);
  return Number(/#(\d+)/.exec(await msg.innerText())![1]);
}

/** 等訓練結束（已完成／失敗／已取消），回傳狀態文字 */
export async function waitRun(page: Page, id: number, timeout = TRAIN_TIMEOUT) {
  const status = runRow(page, id).getByRole('cell').nth(3);
  await expect(status).toHaveText(/已完成|失敗|已取消/, { timeout });
  return flat(await status.innerText());
}

export async function runCells(page: Page, id: number) {
  return (await runRow(page, id).getByRole('cell').allInnerTexts()).map(flat);
}

/** 展開訓練（已展開就不動） */
export async function expandRun(page: Page, id: number) {
  const open = page.getByRole('button', { name: `展開訓練 #${id}`, exact: true });
  if (await open.count()) await open.click();
  await expect(page.getByRole('heading', { name: new RegExp(`^訓練 #${id}：`) })).toBeVisible();
}

/** 點開 <details> 的摘要（沒開時才點） */
export async function openDetails(details: Locator, summary: string | RegExp) {
  await expect(details).toBeVisible();
  if ((await details.getAttribute('open')) === null) await details.locator('summary').filter({ hasText: summary }).first().click();
}

export interface UiMetrics {
  cards: string;
  rows: string[];
  cv: string[];
}

/** 展開訓練，點開「詳細」與「所有指標（訓練、驗證、測試）」，讀出畫面上的指標 */
export async function uiMetrics(page: Page, id: number): Promise<UiMetrics> {
  await expandRun(page, id);
  const cardsList = page.getByRole('list', { name: `訓練 #${id} 的重點指標` });
  const cards = (await cardsList.count()) ? flat(await cardsList.innerText()) : '';
  const details = page.getByTestId('result-details');
  await openDetails(details, /^詳細/);
  const all = details.locator('details').filter({ has: page.locator('summary', { hasText: '所有指標（訓練、驗證、測試）' }) });
  await openDetails(all, '所有指標（訓練、驗證、測試）');
  const table = page.getByRole('table', { name: `訓練 #${id} 的指標` });
  await expect(table).toBeVisible();
  const rows: string[] = [];
  for (const r of await table.locator('tbody tr').all()) {
    const c = (await r.locator('th, td').allInnerTexts()).map(flat);
    rows.push(`${c[0].replace(/（\d+ 筆）$/, '')}|${c[1]}|${c[2]}`);
  }
  const cv: string[] = [];
  const cvTable = page.getByRole('table', { name: `訓練 #${id} 的 K 折結果` });
  if (await cvTable.count()) {
    for (const r of await cvTable.locator('tbody tr').all()) {
      const c = (await r.locator('th, td').allInnerTexts()).map(flat);
      cv.push(`${c[0]}|${c[1]}|${c[2]}`);
    }
  }
  await table.scrollIntoViewIfNeeded();
  return { cards, rows, cv };
}

/** 訓練清單中某設定「介面設定版本」（沒有使用匯入的程式）且已完成的最新一筆 */
export async function latestUiRun(page: Page, settingName: string): Promise<number | null> {
  await expect(runsTable(page)).toBeVisible({ timeout: 15_000 });
  let best: number | null = null;
  for (const r of await runsTable(page).locator('tbody tr').all()) {
    const c = (await r.locator(':scope > td').allInnerTexts()).map(flat);
    if (c.length < 7 || c[1] !== settingName || !c[3].includes('已完成') || c[2].includes('使用匯入的程式')) continue;
    const id = Number(c[0].replace('#', ''));
    if (best === null || id > best) best = id;
  }
  return best;
}

// ---------------------------------------------------------------- 指標格式（照 src/pages/training/metrics.ts 與 components/format.ts）

const METRIC_LABEL: Record<string, string> = {
  accuracy: '準確率', f1_macro: 'F1 分數（各類平均）', auc: 'AUC（ROC 曲線下面積）', sensitivity: '敏感度', specificity: '特異度',
  baseline_accuracy: '比較基準：全部猜訓練資料最常見的類別', r2: 'R²（解釋量）', rmse: 'RMSE（均方根誤差）', mae: 'MAE（平均絕對誤差）',
  baseline_rmse: '比較基準：每次都猜平均值', pixel_accuracy: '像素準確率', dice: 'Dice 係數', mean_iou: '平均 IoU', score: '分數（快速測試）',
};
const PERCENT = new Set(['accuracy', 'sensitivity', 'specificity', 'baseline_accuracy', 'pixel_accuracy']);
const ORDER = ['auc', 'accuracy', 'sensitivity', 'specificity', 'f1_macro', 'r2', 'rmse', 'mae', 'dice', 'pixel_accuracy', 'mean_iou', 'score'];
const SPLIT_NAMES: Record<string, string> = { test: '測試集', validation: '驗證集', train: '訓練集' };
const BASELINES = ['baseline_accuracy', 'baseline_rmse'];
const sortMetrics = (names: string[]) => [...names].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));

function formatNumber(value: number, digits = 4) {
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  const abs = Math.abs(value);
  if (abs !== 0 && abs < 0.0001) return value.toExponential(2);
  return Number(value.toPrecision(digits)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function formatMetric(name: string, value: unknown) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  if (PERCENT.has(name)) return `${Math.round(value * 1000) / 10}%`;
  return formatNumber(value, 3);
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** metrics.json（地端 out/metrics.json）照畫面「所有指標」與「K 折結果」的格式排成文字列，用來和畫面比對 */
export function localMetricRows(metrics: Record<string, unknown>): { rows: string[]; cv: string[] } {
  const rows: string[] = [];
  for (const split of ['test', 'validation', 'train']) {
    const scores = Object.fromEntries(Object.entries(obj(metrics[split])).filter(([, v]) => typeof v === 'number'));
    for (const k of sortMetrics(Object.keys(scores))) rows.push(`${SPLIT_NAMES[split]}|${METRIC_LABEL[k] ?? k}|${formatMetric(k, scores[k])}`);
  }
  const cv: string[] = [];
  const c = obj(metrics.cv);
  if (c.folds) {
    const m = Object.fromEntries(Object.entries(c).filter(([, v]) => v && typeof v === 'object' && 'mean' in (v as object)));
    for (const k of sortMetrics(Object.keys(m).filter((x) => !BASELINES.includes(x)))) {
      const e = obj(m[k]);
      const values = Array.isArray(e.values) ? (e.values as unknown[]) : [];
      cv.push(`${METRIC_LABEL[k] ?? k}|${formatMetric(k, e.mean)} ± ${formatMetric(k, e.std)}|${values.map((v) => formatMetric(k, v)).join('、')}`);
    }
  }
  return { rows, cv };
}

/** 兩組指標文字列逐列比對，回傳差異（空陣列＝相同） */
export function diffRows(a: string[], b: string[]) {
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(`第 ${i + 1} 列：${a[i] ?? '（無）'} ≠ ${b[i] ?? '（無）'}`);
  return out;
}

/** Asia/Taipei 的 datetime-local 字串（YYYY-MM-DDTHH:mm） */
export function taipeiLocal(iso: string) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
  return parts.replace(' ', 'T').slice(0, 16);
}
