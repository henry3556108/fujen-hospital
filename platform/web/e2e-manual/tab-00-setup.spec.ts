import { expect, test } from '@playwright/test';
import { login } from '../e2e-acceptance/helpers';
import { PROJECT_TABS, adminTab, projectTab } from '../e2e-acceptance/ops';

// 結構式資料主線（C1～C4）的前置，不是手冊情境：admin01 建立專案「手冊-臨床表格研究」並加入成員。可重跑（已存在就沿用）。
const TAB_PROJECT = '手冊-臨床表格研究';
const MEMBERS: [string, string][] = [
  ['pi01', 'Principal Investigator'],
  ['ra01', 'Research Assistant'],
  ['ca01', 'Coder Assistant'],
  ['md01', 'Medical Doctor'],
  ['vw01', 'Viewer'],
];
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

test('TAB 前置：專案與成員', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  await login(page, 'admin01');
  await adminTab(page, '專案');
  await page.waitForLoadState('networkidle');
  const table = page.getByRole('table', { name: '專案列表' });
  await expect(table).toBeVisible();
  if (!(await table.getByRole('rowheader', { name: TAB_PROJECT, exact: true }).count())) {
    const form = page.getByRole('form', { name: '新增專案' });
    await form.getByLabel('專案名稱（必填）', { exact: true }).fill(TAB_PROJECT);
    await form.getByLabel('說明', { exact: true }).fill('操作手冊示範：臨床表格資料的統計與預測模型');
    const group = form.getByLabel('GPU 群組', { exact: true });
    const option = (await group.locator('option').allInnerTexts()).map((s) => s.trim()).find((t) => t.startsWith('gpu-shared'));
    if (option) await group.selectOption({ label: option });
    await form.getByRole('button', { name: '新增專案', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: `已新增專案「${TAB_PROJECT}」` })).toBeVisible();
  }
  await projectTab(page, TAB_PROJECT, PROJECT_TABS.members);
  const members = page.getByRole('table', { name: '目前的專案成員' });
  await expect(members).toBeVisible();
  await page.waitForLoadState('networkidle');
  for (const [user, role] of MEMBERS) {
    await expect(members.getByRole('rowheader').first().or(members.getByText('這個專案還沒有成員。'))).toBeVisible();
    const row = members.getByRole('row').filter({ has: page.getByRole('rowheader', { name: user, exact: true }) });
    const current = (await row.count()) ? flat(await row.getByRole('cell').first().innerText()) : null;
    if (current) continue; // 已是成員就沿用
    const form = page.getByRole('form', { name: '設定專案成員' });
    const userSelect = form.getByLabel('帳號', { exact: true });
    const label = (await userSelect.locator('option').allInnerTexts()).map((s) => s.trim()).find((t) => t === user || t.startsWith(`${user}（`));
    await userSelect.selectOption({ label: label! });
    await form.getByLabel('角色', { exact: true }).selectOption({ label: role });
    await form.getByRole('button', { name: current ? '儲存變更' : '加入專案', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '變更角色' });
    if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: '確認變更' }).click();
    await expect(page.getByRole('status').filter({ hasText: `已將「${user}」設定為「${TAB_PROJECT}」的 ${role}` })).toBeVisible();
  }
  console.log(`[TAB 前置] 成員：${flat(await members.innerText())}`);
});
