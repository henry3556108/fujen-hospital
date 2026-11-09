import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { EVIDENCE_DIR, login, note, shot, useProject } from './helpers';

// 情境 7：結構式資料與醫學統計（TC-B04-01～08）。pi01 在 P2-tabular 開 cohort_01.csv，照 B-04 劇本操作；
// 數字與 expected_stats.py（pandas、scikit-learn、statsmodels、lifelines 直接計算）的參考值比對。
// 會改：pi01 的 Target／Feature 設定（第 3 次的設定留著）、上傳 cohort_01_empty_note.csv；欄位隱藏最後會還原。

const REPO = path.resolve(process.cwd(), '../..');
const KIT = path.join(REPO, 'docs/acceptance-kit/m1');
const P2 = 'P2-tabular';
const COLS = ['patient_id', 'age', 'sex', 'bmi', 'sbp', 'dbp', 'glucose', 'smoker', 'diagnosis', 'time_to_event', 'event', 'study_accession'];

test.describe.configure({ mode: 'serial' });
let page: Page;

/** 下拉選單依「選項文字包含」選取（選項文字常帶說明，例如「age（數值）」） */
async function pick(sel: Locator, text: string) {
  // 先找文字完全相同的選項（避免 event 選到 time_to_event），找不到才用「包含」
  const exact = sel.locator('option', { hasText: new RegExp(`^\\s*${text}\\s*$`) });
  const option = (await exact.count()) ? exact.first() : sel.locator('option', { hasText: text }).first();
  const value = await option.getAttribute('value');
  await sel.selectOption(value ?? text);
}
/** 在一組勾選框中只勾 want（其他取消） */
async function only(group: Locator, want: string[]) {
  for (const c of COLS.concat('note')) {
    const box = group.getByRole('checkbox', { name: c, exact: true });
    if (await box.count()) await box.setChecked(want.includes(c));
  }
}
/** 舊分頁名稱 → 新版資料集分頁（資料視覺化／資料清洗／醫學統計分析）與頁內段落 */
const TAB_OF: Record<string, [string, string?]> = {
  描述性統計: ['資料視覺化', '欄位描述性統計'],
  預覽: ['資料視覺化', '資料預覽'],
  Correlation Matrix 與 Scatter Chart: ['資料視覺化', 'Correlation Matrix 與 Scatter Chart'],
  'Target／Feature': ['資料清洗'],
  前處理: ['資料清洗'],
  醫學統計分析: ['醫學統計分析'],
};
/** 切到資料集的分頁與段落（沿用舊分頁名稱呼叫） */
async function go(tab: string) {
  const [t, sub] = TAB_OF[tab] ?? [tab];
  const nav = page.getByRole('navigation', { name: '資料集分頁' });
  const link = nav.getByRole('link', { name: t, exact: true });
  if ((await link.getAttribute('aria-current')) !== 'page') await link.click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  if (!sub) return;
  const btn = page.getByRole('group', { name: '資料視覺化的段落' }).getByRole('button', { name: sub, exact: true });
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
}
/** 資料清洗頁「前處理步驟」的加入步驟表單：收在「進階：自己加前處理步驟」時先展開 */
async function openStepForm() {
  const det = page.getByTestId('steps-advanced');
  if ((await det.count()) && (await det.getAttribute('open')) === null) await det.locator('summary').first().click();
  await expect(page.getByRole('form', { name: '加入前處理步驟' })).toBeVisible();
}
/** 數據管理 › 表格 → 資料集 → 分頁 */
async function openDataset(name: string, tab: string) {
  await useProject(page, P2);
  await page.goto('/data/tabular');
  await page.getByRole('link', { name, exact: true }).first().click();
  await expect(page.getByText(`資料集：${name}`)).toBeVisible();
  await go(tab);
}

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await login(page, 'pi01');
  await useProject(page, P2);
  // 參考值只算一次（約 1 分鐘，期間瀏覽器停在首頁）；已有檔案就沿用
  if (fs.existsSync(path.join(EVIDENCE_DIR, 'TC-B04-參考值', '參考值.md'))) return;
  const out = execSync(`uv run --project platform/libs/tabular python ${KIT}/tools/expected_stats.py`, { cwd: REPO, encoding: 'utf8', shell: '/bin/bash' });
  fs.mkdirSync(path.join(EVIDENCE_DIR, 'TC-B04-參考值'), { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'TC-B04-參考值', '參考值.md'), out);
});

test('TC-B04-01 描述性統計、分布、預覽', async () => {
  const tc = 'TC-B04-01';
  await openDataset('cohort_01.csv', '描述性統計');
  await expect(page.getByText('100 列、12 欄').first()).toBeVisible();
  const table = page.getByRole('table', { name: '描述性統計' });
  for (const v of ['59.15', '19.8', '25.15', '132.3', '105.1', '697.6']) await expect(table.getByText(v, { exact: true }).first()).toBeVisible();
  await shot(page, tc, '01-資料視覺化-欄位描述性統計');
  await pick(page.locator('#dist-column'), 'age');
  await page.getByText('表格檢視').first().click();
  await expect(page.getByText('缺值 0 筆').first()).toBeVisible();
  await shot(page, tc, '02-age分布-表格檢視');
  for (const c of ['sex', 'smoker']) {
    await pick(page.locator('#dist-column'), c);
    await shot(page, tc, `03-${c}分布`);
  }
  await go('預覽');
  for (const v of ['P10001', 'P10002', 'P10005', 'ACC0005']) await expect(page.getByText(v, { exact: true }).first()).toBeVisible();
  await shot(page, tc, '04-資料視覺化-資料預覽前5列');
  note(tc, '描述性統計、age 分布、預覽數字與參考值相同');
});

test('TC-B04-02 欄位顯示與隱藏（重新載入後一致，最後還原）', async () => {
  const tc = 'TC-B04-02';
  const group = page.getByRole('group', { name: '顯示欄位' });
  for (const c of ['patient_id', 'bmi', 'smoker']) await group.getByRole('checkbox', { name: c, exact: true }).uncheck();
  const hint = page.getByText('顯示 9 個欄位，已隱藏 3 個：patient_id、bmi、smoker');
  await expect(hint).toBeVisible();
  await shot(page, tc, '01-隱藏3欄');
  await page.reload();
  await expect(hint).toBeVisible();
  await shot(page, tc, '02-重新載入後');
  await go('描述性統計');
  await go('預覽');
  await expect(hint).toBeVisible();
  await page.getByRole('button', { name: '全部顯示' }).click();
  await expect(page.getByText('顯示全部 12 個欄位').first()).toBeVisible();
  await shot(page, tc, '03-還原全部顯示');
  note(tc, '隱藏 3 欄，重新載入與切換分頁後一致；已還原');
});

const ROUNDS: [string, string[], string[], RegExp][] = [
  ['diagnosis', ['age', 'sex', 'glucose'], ['sex'], /Target 欄位 diagnosis；Feature 欄位 3 個欄位/],
  ['event', ['age', 'sbp', 'smoker', 'glucose'], ['smoker'], /Target 欄位 event；Feature 欄位 4 個欄位/],
  ['sbp', ['age', 'bmi', 'sex', 'smoker', 'glucose'], ['sex', 'smoker'], /Target 欄位 sbp；Feature 欄位 5 個欄位/],
];

test('TC-B04-03 Target 與 Feature 3 次（含補值與 One Hot Encoding）', async () => {
  const tc = 'TC-B04-03';
  await openDataset('cohort_01.csv', 'Target／Feature'); // 單獨重跑時不依賴前一個案例停在資料集頁
  for (const [i, [target, feats, cats, msg]] of ROUNDS.entries()) {
    const table = page.getByRole('table', { name: '欄位設定' });
    await table.getByRole('radio', { name: `Target ${target}` }).check();
    await only(table, feats);
    for (const c of ['sex', 'smoker']) {
      const sw = table.getByRole('switch', { name: `${c} 當作類別` });
      if (await sw.count()) await sw.setChecked(cats.includes(c));
    }
    const gaps = page.getByRole('radiogroup', { name: '有缺值的病人怎麼處理' });
    if (await gaps.count()) await gaps.getByRole('radio').first().check();
    await page.getByRole('button', { name: '儲存前處理步驟' }).click();
    await expect(page.getByText(msg).first()).toBeVisible();
    await shot(page, tc, `${i + 1}a-${target}-儲存訊息`);
    await page.reload();
    await expect(page.getByTestId('saved-target')).toHaveText(target);
    await expect(page.getByRole('table', { name: '欄位設定' }).getByRole('radio', { name: `Target ${target}` })).toBeChecked();
    for (const f of feats) await expect(page.getByRole('table', { name: '欄位設定' }).getByRole('checkbox', { name: f, exact: true })).toBeChecked();
    await shot(page, tc, `${i + 1}b-${target}-重新載入後`);
    note(tc, `第 ${i + 1} 次 Target ${target}、Feature ${feats.join('、')}、One Hot Encoding ${cats.join('、')}：重新載入後一致`);
  }
});

test('TC-B04-04 補值與 One Hot Encoding 結果', async () => {
  const tc = 'TC-B04-04';
  await openDataset('cohort_01.csv', '前處理'); // 單獨重跑時不依賴前一個案例停在資料集頁
  while (await page.getByRole('button', { name: '移除第 1 步' }).count()) await page.getByRole('button', { name: '移除第 1 步' }).click();
  await openStepForm();
  const form = page.getByRole('form', { name: '加入前處理步驟' });
  const addStep = async (cat: string, method: string, col: string) => {
    await pick(page.locator('#step-category'), cat);
    await pick(page.locator('#step-method'), method);
    await form.getByRole('group', { name: /套用欄位/ }).getByRole('checkbox', { name: col, exact: true }).check();
    await page.getByRole('button', { name: '加入步驟' }).click();
  };
  await addStep('缺值處理', '平均數補值', 'glucose');
  await addStep('類別編碼', 'One Hot Encoding', 'sex');
  await page.getByRole('button', { name: '預覽處理結果' }).click();
  await expect(page.getByText(/套用 2 個步驟後：100 列、13 欄，缺值合計 88 筆/)).toBeVisible();
  await expect(page.getByText('105.132').first()).toBeVisible();
  await shot(page, tc, '01-資料清洗-補值與OneHot預覽');
  note(tc, 'glucose 平均數補值 105.132；sex 拆成 sex_F、sex_M；100 列、13 欄');
});

test('TC-B04-05 Correlation Matrix 與 Scatter Chart', async () => {
  const tc = 'TC-B04-05';
  await go('Correlation Matrix 與 Scatter Chart');
  await page.getByRole('button', { name: '產生 Correlation Matrix' }).click();
  await expect(page.getByText('Correlation Matrix（pearson）').first()).toBeVisible();
  await expect(page.getByText('0.87').first()).toBeVisible();
  await shot(page, tc, '01-資料視覺化-Correlation Matrix');
  await pick(page.locator('#scatter-x'), 'age');
  await pick(page.locator('#scatter-y'), 'bmi');
  await page.getByRole('button', { name: '產生 Scatter Chart' }).click();
  await expect(page.getByText('共 100 點').first()).toBeVisible();
  await page.getByText('表格檢視').last().click();
  await shot(page, tc, '02-Scatter Chart-age與bmi');
  note(tc, 'Correlation Matrix 8×8 產生成功；Scatter Chart 100 點');
});

test('TC-B04-06 前處理方法清單 66 種', async () => {
  const tc = 'TC-B04-06';
  await openDataset('cohort_01.csv', '前處理'); // 單獨重跑時不依賴前一個案例停在資料集頁
  const count = page.getByTestId('method-count'); // 「全部前處理方式：共 66 種（…）」摺疊標題
  await expect(count).toContainText(/共 66 種/);
  await count.click();
  const ids = (await page.getByRole('table', { name: '前處理方式清單' }).locator('tbody td.mono').allInnerTexts()).map((s) => s.trim());
  await shot(page, tc, '01-資料清洗-共66種方法清單');
  const csv = fs.readFileSync(path.join(KIT, 'data/preprocessing_methods.csv'), 'utf8').trim().split('\n');
  const header = csv[0].split(',');
  const col = header.findIndex((h) => /代號|id/i.test(h));
  const want = csv.slice(1).map((l) => l.split(',')[col].trim());
  const diff = want.filter((w) => !ids.includes(w)).length + ids.filter((x) => !want.includes(x)).length;
  let sum = 0;
  await openStepForm();
  const cats = await page.locator('#step-category option').allInnerTexts();
  for (const c of cats) {
    await pick(page.locator('#step-category'), c);
    sum += await page.locator('#step-method option:not([value=""])').count();
  }
  note(tc, `畫面清單 ${ids.length} 種、文件清單 ${want.length} 種，差異 ${diff} 項；7 類下拉選單合計 ${sum} 種`);
  expect(ids.length).toBe(66);
  expect(diff).toBe(0);
  expect(sum).toBe(66);
});

async function runStats(model: string, set: () => Promise<void>) {
  await go('醫學統計分析');
  await pick(page.locator('#stats-model'), model);
  await set();
  await page.getByRole('button', { name: '執行分析' }).click();
}
const feats = () => page.getByRole('group', { name: /Feature 欄位|共變項/ });

test('TC-B04-07 四種醫學統計', async () => {
  const tc = 'TC-B04-07';
  await openDataset('cohort_01.csv', '醫學統計分析'); // 單獨重跑時不依賴前一個案例停在資料集頁
  await runStats('Logistic Regression', async () => { await pick(page.locator('#stats-target'), 'diagnosis'); await only(feats(), ['age', 'bmi']); });
  await expect(page.getByText('0.8369').first()).toBeVisible({ timeout: 30_000 });
  await shot(page, tc, '01-Logistic');
  await runStats('Linear Regression', async () => { await pick(page.locator('#stats-target'), 'sbp'); await only(feats(), ['age', 'bmi']); });
  await expect(page.getByText('0.3191').first()).toBeVisible({ timeout: 30_000 });
  await shot(page, tc, '02-Linear');
  await runStats('Kaplan-Meier', async () => {
    await pick(page.locator('#stats-duration'), 'time_to_event');
    await pick(page.locator('#stats-event'), 'event');
    await pick(page.locator('#stats-group'), 'sex');
  });
  await expect(page.getByText('0.3754').first()).toBeVisible({ timeout: 30_000 });
  await shot(page, tc, '03-KaplanMeier');
  await runStats('Cox', async () => {
    await pick(page.locator('#stats-duration'), 'time_to_event');
    await pick(page.locator('#stats-event'), 'event');
    await only(feats(), ['age', 'diagnosis']);
  });
  await expect(page.getByText('0.7198').first()).toBeVisible({ timeout: 30_000 });
  await shot(page, tc, '04-Cox');
  note(tc, 'Logistic AUC 0.8369、Linear R² 0.3191、KM log-rank p 0.3754、Cox C-index 0.7198，與參考值相同；失敗 0 次');
});

test('TC-B04-08 文字欄與全空欄給清楚錯誤', async () => {
  const tc = 'TC-B04-08';
  await openDataset('cohort_01.csv', '醫學統計分析');
  await runStats('Linear Regression', async () => { await pick(page.locator('#stats-target'), 'sbp'); await only(feats(), ['age', 'smoker']); });
  await expect(page.getByText('欄位「smoker」不是數值欄位，無法進行數值分析').first()).toBeVisible();
  await shot(page, tc, '01-文字欄位smoker-錯誤訊息');

  await page.goto('/data/tabular');
  await page.locator('#csv-file').setInputFiles(path.join(KIT, 'data/tabular/cohort_01_empty_note.csv'));
  await expect(page.getByText('這欄全部空白或缺值').first()).toBeVisible();
  // 重跑時同名資料集已存在：選「取代舊的」（這份檔案只給本案例用）
  const replace = page.getByRole('radio', { name: /^取代舊的/ });
  if (await replace.count()) await replace.check();
  await page.getByRole('button', { name: '上傳並驗證' }).click();
  await expect(page.getByText('「cohort_01_empty_note.csv」的上傳結果')).toBeVisible();
  await shot(page, tc, '02-上傳全空欄位檔');

  await openDataset('cohort_01_empty_note.csv', '描述性統計');
  await pick(page.locator('#dist-column'), 'note');
  await expect(page.getByText('缺值 100 筆，共 0 個類別').first()).toBeVisible();
  await shot(page, tc, '03-全空欄位note-分布');
  await runStats('Linear Regression', async () => { await pick(page.locator('#stats-target'), 'sbp'); await only(feats(), ['age', 'note']); });
  const msg = page.getByText('欄位「note」全部是空值，無法進行分析').first();
  await expect(msg).toBeVisible();
  await shot(page, tc, '04-全空欄位note-統計錯誤訊息');
  await go('Correlation Matrix 與 Scatter Chart');
  await pick(page.locator('#scatter-x'), 'age');
  await pick(page.locator('#scatter-y'), 'note');
  await page.getByRole('button', { name: '產生 Scatter Chart' }).click();
  await expect(msg).toBeVisible();
  await shot(page, tc, '05-全空欄位note-Scatter Chart 錯誤訊息');
  note(tc, '文字欄、全空欄都回清楚的錯誤訊息，沒有錯誤頁');
});
