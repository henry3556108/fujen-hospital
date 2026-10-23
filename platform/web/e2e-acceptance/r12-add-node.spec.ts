import { expect, test, type Page } from '@playwright/test';
import { login, note, shot } from './helpers';
import { q, schedulingTab, sh } from './ops';

// M1 補拍 12：新增節點（TC-C01-07）。加入 ai-platform-extra-1（cpu-data），平台清單自動出現；最後一定移除。
const TC = 'TC-C01-07';
const NODE = 'ai-platform-extra-1';

async function summary(page: Page) {
  const tiles = page.getByRole('list', { name: '叢集摘要' }).locator(':scope > li');
  const out: Record<string, string> = {};
  for (const li of await tiles.all()) out[(await li.locator('.stat-tile__label').innerText()).trim()] = (await li.locator('.stat-tile__value').innerText()).trim();
  return out;
}

async function refresh(page: Page) {
  await page.getByRole('button', { name: '重新整理', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: '重新整理', exact: true })).toBeEnabled();
}

const nodeRow = (page: Page) =>
  page.getByRole('table', { name: '叢集節點列表' }).locator('tbody tr').filter({ has: page.getByRole('rowheader', { name: NODE, exact: true }) });

test('M1 補拍 12 新增節點（TC-C01-07）', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  // 上一輪殘留先移除
  if (q(`kubectl get node ${NODE} --no-headers 2>/dev/null`) || q(`docker ps -a --format '{{.Names}}' | grep -x ${NODE}`)) {
    sh(TC, 'TC-C01-07-前置清除', `platform/deploy/kind/remove-node.sh ${NODE}`);
  }
  await login(page, 'admin01');
  // 管理區「運算資源」→「節點」
  await schedulingTab(page, '叢集節點');
  await expect(page.getByRole('table', { name: '叢集節點列表' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const s0 = await summary(page);
  await shot(page, TC, '01-運算資源-節點-新增前');
  note(TC, `新增前：節點數 ${s0['節點數']}、就緒 ${s0['就緒節點']}`);
  let s1: Record<string, string> = {};
  let row: string[] = [];
  let nodeOut = '';
  let flavor = '';
  try {
    const t0 = Date.now();
    const a = sh(TC, 'TC-C01-07-add-node', `platform/deploy/kind/add-node.sh ${NODE} cpu-data`);
    note(TC, `add-node.sh 結束碼 ${a.code}，耗時 ${((Date.now() - t0) / 1000).toFixed(0)} 秒；輸出：${a.out.trim().split('\n').filter((l) => /^==|condition met/.test(l)).join('／')}`);
    expect(a.code).toBe(0);
    await refresh(page);
    await expect(nodeRow(page)).toBeVisible();
    s1 = await summary(page);
    row = (await nodeRow(page).locator('th, td').allInnerTexts()).map((s) => s.trim());
    await nodeRow(page).scrollIntoViewIfNeeded();
    await shot(page, TC, '02-運算資源-節點-新增節點後');
    note(TC, `新增後：節點數 ${s1['節點數']}、就緒 ${s1['就緒節點']}；新列 ${row.join('｜')}（平台未做任何設定）`);
    nodeOut = sh(TC, 'TC-C01-07-node', `kubectl get node ${NODE} -L platform/pool`).out;
    flavor = sh(TC, 'TC-C01-07-node', `kubectl get resourceflavor cpu-data -o jsonpath='{.spec.nodeLabels}{"\\n"}'`).out.trim();
    note(TC, `kubectl：${nodeOut.trim().split('\n').pop()?.replace(/\s+/g, ' ')}；ResourceFlavor cpu-data 節點標籤 ${flavor}`);
  } finally {
    const r = sh(TC, 'TC-C01-07-remove-node', `platform/deploy/kind/remove-node.sh ${NODE}`);
    note(TC, `remove-node.sh：${r.out.trim()}（結束碼 ${r.code}）`);
    await refresh(page);
    await expect(nodeRow(page)).toHaveCount(0);
    const s2 = await summary(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, TC, '03-運算資源-節點-移除節點後');
    note(TC, `移除後：節點數 ${s2['節點數']}、就緒 ${s2['就緒節點']}；kubectl get nodes：${q('kubectl get nodes --no-headers | wc -l')} 個`);
    expect(r.out).toContain(`已移除 ${NODE}`);
    expect(s2['節點數']).toBe(s0['節點數']);
  }
  expect(s0['節點數']).toBe('5');
  expect(s1['節點數']).toBe('6');
  expect(s1['就緒節點']).toBe('6');
  expect(row.slice(0, 4)).toEqual([NODE, 'cpu-data', '資料清洗', '就緒']);
  expect(nodeOut).toMatch(new RegExp(`${NODE}\\s+Ready.*cpu-data`));
  expect(flavor).toBe('{"platform/pool":"cpu-data"}');
});
