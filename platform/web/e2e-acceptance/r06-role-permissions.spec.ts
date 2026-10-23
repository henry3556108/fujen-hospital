import { expect, test } from '@playwright/test';
import { P1, login, menuLabels, note, shot, useProject } from './helpers';
import { sh } from './ops';
import { freshPage, membersOf } from './r-common';

// M1 補拍 06：角色與權限一致（TC-A03-04）。只看不改：下拉選單、成員表格、各帳號選單（功能目錄）、/api/me 四者對照。成員管理在管理區專案頁「成員與權限」分頁。
const TC = 'TC-A03-04';
const ROLES: [string, string, string, string[]][] = [
  // [帳號, 角色代碼, 角色名稱, 權限]
  ['vw01', 'viewer', 'Viewer', ['Project', 'Prediction']],
  ['md01', 'medical_doctor', 'Medical Doctor', ['Project', 'Labeling', 'Prediction']],
  ['ra01', 'research_assistant', 'Research Assistant', ['Project', 'Labeling', 'Training', 'Prediction']],
  ['ca01', 'coder_assistant', 'Coder Assistant', ['Project', 'Training', 'Coding', 'Prediction']],
  ['pi01', 'principal_investigator', 'Principal Investigator', ['Project', 'Labeling', 'Training', 'Prediction', 'Coding']],
];
const ORDER = ['Project', 'Labeling', 'Training', 'Prediction', 'Coding'];
const sort = (a: string[]) => [...a].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));
const ENTRY_OF: Record<string, string[]> = {
  Project: ['數據管理'],
  Labeling: ['影像標註', '自動影像分類標註'],
  Training: ['建模管理'],
  Prediction: ['AI 模型部署', '推論服務管理'],
  Coding: ['LLM No-code 開發'],
};
const MENU_ORDER = ['數據管理', '影像標註', '自動影像分類標註', '建模管理', 'AI 模型部署', '推論服務管理', 'LLM No-code 開發'];
const menuFor = (perms: string[]) => MENU_ORDER.filter((m) => perms.some((p) => ENTRY_OF[p].includes(m)));

test('M1 補拍 06 角色與權限一致（TC-A03-04）', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const diffs = new Set<string>();
  const { ctx, page } = await freshPage(browser);
  await login(page, 'admin01');
  await membersOf(page, P1);
  await expect(page.getByRole('table', { name: '目前的專案成員' }).locator('tbody tr').first()).toBeVisible();
  // 選一個不是 P1 成員的帳號，只為了讓「角色」下拉可操作；不按「加入專案」
  await page.locator('#member-user').selectOption({ label: 'user01' });
  const roleSel = page.locator('#member-role');
  const options = (await roleSel.locator('option').allInnerTexts()).map((s) => s.trim());
  // 原生下拉選單展開的樣子截不到，暫時把 select 改成列表顯示（size=5）截圖，截完恢復
  await roleSel.evaluate((el) => el.setAttribute('size', '5'));
  await roleSel.scrollIntoViewIfNeeded();
  await shot(page, TC, '01-角色清單5個');
  await roleSel.evaluate((el) => el.removeAttribute('size'));
  const permBoxes = page.getByRole('group', { name: '權限' }).locator('label.checkbox');
  const permNames = (await permBoxes.allInnerTexts()).map((s) => s.trim());
  note(TC, `角色下拉 ${options.length} 個：${options.join('、')}；權限勾選框 ${permNames.length} 個：${permNames.join('、')}`);
  expect(options).toEqual(['Viewer', 'Medical Doctor', 'Research Assistant', 'Coder Assistant', 'Principal Investigator']);
  expect(permNames.map((s) => s.split('（')[0])).toEqual(['Project', 'Labeling', 'Training', 'Prediction', 'Coding']);

  for (const [i, [, code, label, perms]] of ROLES.entries()) {
    await roleSel.selectOption(code);
    const checked: string[] = [];
    for (const l of await permBoxes.all()) if (await l.locator('input').isChecked()) checked.push((await l.innerText()).trim().split('（')[0]);
    await page.getByRole('group', { name: '權限' }).scrollIntoViewIfNeeded();
    await shot(page, TC, `0${i + 2}-${label.replace(/ /g, '-')}預設權限`);
    const same = sort(checked).join() === sort(perms).join();
    if (!same) diffs.add(label);
    note(TC, `下拉選 ${label}：勾選 ${sort(checked).join('、')}（預設表 ${perms.join('、')}）${same ? '一致' : '不一致'}`);
  }
  // 不儲存：恢復表單
  await page.locator('#member-user').selectOption({ value: '' });

  // 成員表格
  const table = page.getByRole('table', { name: '目前的專案成員' });
  await table.scrollIntoViewIfNeeded();
  await shot(page, TC, '07-專案頁成員與權限表格');
  for (const [user, , label, perms] of ROLES) {
    const row = table.locator('tbody tr').filter({ has: page.getByRole('rowheader', { name: user, exact: true }) });
    const cells = (await row.locator('td').allInnerTexts()).map((s) => s.trim());
    const got = cells[1].split('、');
    const same = cells[0] === label && sort(got).join() === sort(perms).join();
    if (!same) diffs.add(user);
    note(TC, `成員表格 ${user}：${cells[0]}｜${cells[1]} ${same ? '一致' : '不一致'}`);
  }
  await ctx.close();

  // 各帳號的選單：功能目錄依權限列出的契約入口原名稱
  for (const [i, [user, , , perms]] of ROLES.entries()) {
    const u = await freshPage(browser);
    await login(u.page, user);
    await useProject(u.page);
    const menu = await menuLabels(u.page);
    await shot(u.page, TC, `${String(i + 8).padStart(2, '0')}-${user}-功能目錄`);
    const same = menu.join() === menuFor(perms).join();
    if (!same) diffs.add(user);
    note(TC, `${user} 功能目錄：${menu.join('、')} ${same ? '一致' : `不一致（應為 ${menuFor(perms).join('、')}）`}`);
    await u.ctx.close();
  }

  // /api/me
  const r = sh(
    TC,
    'TC-A03-04-me',
    `for u in vw01 md01 ra01 ca01 pi01; do
  T=$(curl -s -X POST http://localhost:38180/realms/ai-platform/protocol/openid-connect/token \\
    -d grant_type=password -d client_id=ai-platform-web -d username=$u --data-urlencode password='Dev-Passw0rd!' \\
    | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')
  echo "$u: $(curl -s -H "Authorization: Bearer $T" http://localhost:38980/api/me)"
done`,
  );
  for (const [user, code, , perms] of ROLES) {
    const line = r.out.split('\n').find((l) => l.startsWith(`${user}:`)) ?? '';
    const me = JSON.parse(line.slice(user.length + 1)) as { projects: { name: string; role: string; permissions: string[] }[] };
    const p = me.projects.find((x) => x.name === P1)!;
    const same = p.role === code && [...p.permissions].sort().join() === perms.map((x) => x.toLowerCase()).sort().join();
    if (!same) diffs.add(user);
    note(TC, `/api/me ${user}：P1 role ${p.role}、permissions ${p.permissions.join(',')} ${same ? '一致' : '不一致'}`);
  }
  note(TC, `下拉選單、成員表格、功能目錄、/api/me 四者對照，差異 ${diffs.size}/5${diffs.size ? `：${[...diffs].join('、')}` : ''}`);
  expect(diffs.size).toBe(0);
});
