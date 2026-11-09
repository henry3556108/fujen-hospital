import { expect, test, type Locator, type Page } from '@playwright/test';
import { note, shot } from './helpers';
import { adminTab } from './ops';
import { Checks, begin, flat, loadState, openAs, step, taipeiLocal } from './m2-common';

// M2驗證\09-稽核紀錄.md（F-14）。帳號 admin01。動作欄位依序搜尋，每項截一張圖，抽 3 筆打開明細。
const TC = '09';

interface Entry {
  row: Locator;
  id: string;
  at: string;
  actor: string;
  category: string;
  action: string;
  target: string;
  result: string;
  source: string;
}

async function search(page: Page, action: string, since: string | null): Promise<Entry[]> {
  await adminTab(page, '稽核紀錄');
  const form = page.getByRole('form', { name: '篩選稽核紀錄' });
  await form.getByLabel('動作（開頭符合）', { exact: true }).fill(action);
  if (since) await form.getByLabel('開始時間', { exact: true }).fill(since);
  await form.getByRole('button', { name: '查詢', exact: true }).click();
  await page.getByLabel('每頁', { exact: true }).selectOption({ label: '100 筆' });
  await expect(page.getByRole('status').filter({ hasText: /^共 \d+ 筆/ })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  const table = page.getByRole('table', { name: '稽核紀錄' });
  const out: Entry[] = [];
  for (const row of await table.locator('tbody tr').all()) {
    const c = (await row.locator(':scope > th, :scope > td').allInnerTexts()).map(flat);
    if (c.length < 9) continue;
    out.push({ row, id: c[0], at: c[1], actor: c[2], category: c[3], action: c[4], target: c[5], result: c[6], source: c[7] });
  }
  return out;
}

/** 點開明細（內容欄的「查看」），回傳 JSON 文字 */
async function openDetail(e: Entry) {
  const summary = e.row.getByText('查看', { exact: true });
  if (!(await summary.count())) return '';
  await summary.click();
  const pre = e.row.locator('pre');
  await expect(pre).toBeVisible();
  return flat(await pre.innerText());
}

const fieldsOk = (e: Entry) => [e.at, e.actor, e.action, e.target, e.result].every(Boolean) && e.source !== '' && e.source !== '（未記錄）';

test.use({ actionTimeout: 30_000 });

test('M2 09 稽核紀錄', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  begin(TC, 'M2 09 稽核紀錄');
  const c = new Checks(TC);
  const setupAt = loadState().setupAt;
  const since = typeof setupAt === 'string' ? taipeiLocal(new Date(Date.parse(setupAt) - 60_000).toISOString()) : null;
  if (since) c.diff(`另外在「開始時間」填 00 前置開始的時間 ${since}，只看這一輪 M2 驗證的紀錄（md 沒寫）`);
  const { ctx, page } = await openAs(browser, 'admin01');

  const cases: { n: number; action: string; file: string; expect: string; judge: (rows: Entry[], details: string[]) => [boolean, string] }[] = [
    {
      n: 1, action: 'flow.stage_export', file: '01-階段匯出', expect: '01 下載三個階段檔、04、05 的下載',
      judge: (rows) => {
        const ok = rows.filter((r) => r.result === '成功').length;
        return [ok >= 5, `成功 ${ok} 筆（01 三筆、03 下載匯入檔、04、05 各一筆，至少 5）`];
      },
    },
    {
      n: 2, action: 'flow.stage_import', file: '02-階段匯入', expect: '01 訓練、04 資料匯入、05 部署兩次成功；02 的 4 次失敗，失敗筆記錄錯誤內容',
      judge: (rows, details) => {
        const ok = rows.filter((r) => r.result === '成功').length;
        const fail = rows.filter((r) => r.result === '失敗').length;
        const failDetails = details.filter((d) => d.includes('"errors"')).length;
        return [ok >= 4 && fail >= 4 && failDetails > 0, `成功 ${ok}、失敗 ${fail}；打開的失敗明細有 errors：${failDetails} 筆`];
      },
    },
    {
      n: 3, action: 'flow.stage_unlock', file: '03-改回', expect: '03、04、05 各一筆',
      judge: (rows) => [rows.length >= 3, `${rows.length} 筆`],
    },
    {
      n: 4, action: 'flow.package_export', file: '04-專案包匯出', expect: '06 兩筆；附資料的那筆類別是「資料交換」',
      judge: (rows) => {
        const ex = rows.filter((r) => r.category === '資料交換').length;
        return [rows.length >= 2 && ex >= 1, `${rows.length} 筆，類別「資料交換」${ex} 筆`];
      },
    },
    {
      n: 5, action: 'flow.package_import', file: '05-專案包匯入', expect: '07 兩筆、08 一筆，含專案 M2-FLOW-B',
      judge: (rows) => {
        const ok = rows.filter((r) => r.result === '成功').length;
        return [ok >= 3, `成功 ${ok} 筆`];
      },
    },
    {
      n: 6, action: 'deployment.access', file: '06-部署授權帳號', expect: '05 步驟 5 改授權帳號，來源標示 flow.stage_import',
      judge: (_rows, details) => {
        const via = details.filter((d) => d.includes('flow.stage_import')).length;
        return [via >= 1, `打開的明細中 via＝flow.stage_import：${via} 筆`];
      },
    },
  ];

  let missingFields = 0;
  for (const cs of cases) {
    step(TC, cs.n, `動作搜尋 ${cs.action}；應看到：${cs.expect}`);
    const rows = await search(page, cs.action, since);
    note(TC, `${cs.action}：${rows.length} 筆`);
    for (const r of rows) note(TC, `  #${r.id} ${r.at} ${r.actor} ${r.category} ${r.action} ${r.target} ${r.result} 來源 ${r.source}`);
    // 抽 3 筆打開明細；匯入另外把失敗筆也打開，部署授權帳號把全部打開找 via
    const pick = cs.n === 2 ? [...rows.slice(0, 3), ...rows.filter((r) => r.result === '失敗').slice(0, 4)]
      : cs.n === 6 ? rows.slice(0, 10) : rows.slice(0, 3);
    const details: string[] = [];
    for (const e of [...new Set(pick)]) {
      const d = await openDetail(e);
      details.push(d);
      const okFields = fieldsOk(e);
      if (!okFields) missingFields++;
      note(TC, `  明細 #${e.id}：時間 ${e.at}、帳號 ${e.actor}、來源 IP ${e.source}、動作 ${e.action}、對象 ${e.target}、結果 ${e.result}；內容 ${d.slice(0, 300)}${okFields ? '' : '（欄位有缺）'}`);
    }
    if (rows.length) await rows[0].row.scrollIntoViewIfNeeded();
    await shot(page, TC, cs.file);
    const [ok, why] = cs.judge(rows, details);
    c.check(`步驟 ${cs.n} ${cs.action}：${cs.expect}`, rows.length > 0 && ok, why);
    if (cs.n === 5) c.diff('flow.package_import 的紀錄只有 project_id（數字）與對象 training_setting:N，畫面上不會出現專案名稱「M2-FLOW-B」');
    if (cs.n === 6) c.diff('deployment.access 的「來源」欄是 IP；flow.stage_import 寫在「內容」明細的 via 欄位');
  }
  c.check('抽查的明細欄位缺漏 0（時間、帳號、來源 IP、動作、對象、結果）', missingFields === 0, `缺漏 ${missingFields} 筆`);
  await ctx.close();
  c.finish();
});
