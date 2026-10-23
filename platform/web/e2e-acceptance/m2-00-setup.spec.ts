import { expect, test, type Page } from '@playwright/test';
import { note, shot } from './helpers';
import { PROJECT_TABS, adminTab, projectTab } from './ops';
import { CSV80, Checks, DEMO_CSV, DS, DS80, PA, PB, begin, flat, gotoTabular, loadState, openAs, saveState, statusMsg, step, switchProject } from './m2-common';

// M2 驗證 00 前置（M2驗證\00-驗證清單.md「前置」）。可重跑：專案、成員已存在就沿用；資料集已存在就不重複上傳。
const TC = '00';
const MEMBERS: Record<string, [string, string][]> = {
  [PA]: [['pi01', 'Principal Investigator'], ['ra01', 'Research Assistant'], ['md01', 'Medical Doctor']],
  [PB]: [['pi01', 'Principal Investigator']],
};

async function ensureProject(page: Page, c: Checks, name: string) {
  const table = page.getByRole('table', { name: '專案列表' });
  const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
  if (await row.count()) {
    const text = flat(await row.innerText());
    note(TC, `專案 ${name} 已存在，沿用：${text}`);
    c.check(`${name} 的 GPU 群組是 gpu-shared`, text.includes('gpu-shared'), text);
    return;
  }
  const form = page.getByRole('form', { name: '新增專案' });
  await form.getByLabel('專案名稱（必填）', { exact: true }).fill(name);
  await form.getByLabel('說明', { exact: true }).fill('M2 流程程式碼驗證');
  const group = form.getByLabel('GPU 群組', { exact: true });
  const option = (await group.locator('option').allInnerTexts()).map((s) => s.trim()).find((t) => t.startsWith('gpu-shared'));
  if (!c.check(`GPU 群組選單有 gpu-shared（${name}）`, Boolean(option))) return;
  await group.selectOption({ label: option! });
  await form.getByRole('button', { name: '新增專案', exact: true }).click();
  await expect(statusMsg(page, `已新增專案「${name}」`)).toBeVisible();
  c.check(`新增專案 ${name}（GPU 群組 ${option}）`, true);
}

async function ensureMember(page: Page, c: Checks, project: string, user: string, role: string) {
  const members = page.getByRole('table', { name: '目前的專案成員' });
  // 成員表載入完（有成員列或「還沒有成員」）才判斷
  await expect(members.getByRole('rowheader').first().or(members.getByText('這個專案還沒有成員。'))).toBeVisible();
  const row =members.getByRole('row').filter({ has: page.getByRole('rowheader', { name: user, exact: true }) });
  const current = (await row.count()) ? flat(await row.getByRole('cell').first().innerText()) : null;
  if (current === role) {
    note(TC, `${project}：${user} 已是 ${role}，沿用`);
    c.check(`${project} 成員 ${user}（${role}）`, true, '已存在');
    return;
  }
  const form = page.getByRole('form', { name: '設定專案成員' });
  const userSelect = form.getByLabel('帳號', { exact: true });
  const label = (await userSelect.locator('option').allInnerTexts()).map((s) => s.trim()).find((t) => t === user || t.startsWith(`${user}（`));
  if (!c.check(`帳號選單有 ${user}`, Boolean(label))) return;
  await userSelect.selectOption({ label: label! });
  await form.getByLabel('角色', { exact: true }).selectOption({ label: role });
  await form.getByRole('button', { name: current ? '儲存變更' : '加入專案', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '變更角色' });
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: '確認變更' }).click();
  await expect(statusMsg(page, `已將「${user}」設定為「${project}」的 ${role}`)).toBeVisible();
  c.check(`${project} 成員 ${user}（${role}）`, true, current ? `原本是 ${current}，已改為 ${role}` : '已加入');
}

async function ensureDataset(page: Page, c: Checks, project: string, file: string, name: string) {
  await switchProject(page, project);
  await gotoTabular(page);
  const list = page.getByRole('table', { name: '資料集列表' });
  if (await list.getByRole('rowheader', { name, exact: true }).count()) {
    const row = list.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
    note(TC, `${project}：資料集 ${name} 已存在，不重複上傳：${flat(await row.innerText())}`);
    c.check(`${project} 有資料集 ${name}`, true, '已存在');
    return;
  }
  const form = page.getByRole('form', { name: '上傳 CSV' });
  await form.getByLabel(/^CSV 檔案/).setInputFiles(file);
  await form.getByLabel('資料集名稱', { exact: true }).fill(name);
  await form.getByRole('button', { name: '上傳並驗證', exact: true }).click();
  const result = page.getByRole('region', { name: `「${name}」的上傳結果` });
  await expect(result).toBeVisible({ timeout: 120_000 });
  note(TC, `${project}：上傳 ${file} → ${flat(await result.innerText()).slice(0, 300)}`);
  await expect(list.getByRole('rowheader', { name, exact: true })).toBeVisible({ timeout: 30_000 });
  c.check(`${project} 上傳資料集 ${name}`, true);
}

test.use({ actionTimeout: 30_000 });

test('M2 00 前置：專案、成員、資料集', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  begin(TC, 'M2 00 前置');
  const c = new Checks(TC);
  if (!loadState().setupAt) saveState({ setupAt: new Date().toISOString() });

  // 1. admin01 新增兩個專案（gpu-shared）與成員
  step(TC, 1, `admin01 管理區「專案」新增 ${PA}、${PB}（GPU 群組 gpu-shared），再到各專案頁「成員與權限」設定成員`);
  const admin = await openAs(browser, 'admin01');
  const page = admin.page;
  await adminTab(page, '專案');
  await page.waitForLoadState('networkidle');
  for (const p of [PA, PB]) await ensureProject(page, c, p);
  await page.getByRole('table', { name: '專案列表' }).getByRole('rowheader', { name: PB, exact: true }).scrollIntoViewIfNeeded();
  await shot(page, TC, '01-專案');
  for (const p of [PA, PB]) {
    await projectTab(page, p, PROJECT_TABS.members);
    await expect(page.getByRole('table', { name: '目前的專案成員' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    for (const [u, role] of MEMBERS[p]) await ensureMember(page, c, p, u, role);
    note(TC, `${p} 成員：${flat(await page.getByRole('table', { name: '目前的專案成員' }).innerText())}`);
    await shot(page, TC, `02-成員-${p}`);
  }
  await admin.ctx.close();

  // 2、3. pi01 上傳兩個資料集
  step(TC, 2, `pi01 切到 ${PA}，上傳 cohort_01；切到 ${PB}，上傳 cohort_01-前80列`);
  const pi = await openAs(browser, 'pi01');
  await ensureDataset(pi.page, c, PA, DEMO_CSV, DS);
  await shot(pi.page, TC, `03-資料集-${PA}`);
  await ensureDataset(pi.page, c, PB, CSV80, DS80);
  await shot(pi.page, TC, `04-資料集-${PB}`);
  await pi.ctx.close();
  c.finish();
});
