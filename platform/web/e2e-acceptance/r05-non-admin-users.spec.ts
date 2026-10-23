import { expect, test } from '@playwright/test';
import { DENIED, login, menuLabels, note, shot } from './helpers';
import { sh } from './ops';
import { freshPage, gotoAdmin, logout, shotUrl } from './r-common';

// M1 補拍 05：非 Admin 不能管理帳號（TC-A03-03）。網頁 pi01、user01 各 3 頁；API 各 5 次新增帳號。
const TC = 'TC-A03-03';
const PAGES = ['/admin/users', '/admin/projects', '/admin/members'];

test('M1 補拍 05 非 Admin 不能管理帳號（TC-A03-03）', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const { ctx, page } = await freshPage(browser);
  let shown = 0;
  let entered = 0;
  let n = 1;
  for (const user of ['pi01', 'user01']) {
    await login(page, user);
    const menu = await menuLabels(page);
    await shot(page, TC, `${String(n++).padStart(2, '0')}-${user}-選單無帳號管理`);
    note(TC, `${user} 左側選單：${menu.join('、') || '（無）'}；有「帳號管理」：${menu.includes('帳號管理') ? '是' : '否'}`);
    expect(menu).not.toContain('帳號管理');
    for (const p of PAGES) {
      await page.goto(p);
      await page.waitForLoadState('networkidle');
      const a = await page.getByText(DENIED).first().isVisible();
      const b = await page.getByText('「帳號管理」需要 Admin 帳號類型，你的帳號類型是 User。').first().isVisible();
      const c = await page.getByRole('link', { name: '回首頁' }).or(page.getByRole('button', { name: '回首頁' })).first().isVisible();
      const listShown = (await page.getByRole('table', { name: /帳號列表|專案列表|目前的專案成員/ }).count()) > 0;
      if (a && b && c && !listShown) shown++;
      if (listShown) entered++;
      await shotUrl(page, TC, `${String(n++).padStart(2, '0')}-${user}-admin-${p.split('/').pop()}`);
      note(TC, `${user} 開 ${p}：「${DENIED}」${a ? '有' : '無'}、「「帳號管理」需要 Admin 帳號類型，你的帳號類型是 User。」${b ? '有' : '無'}、「回首頁」${c ? '有' : '無'}、看到管理表格 ${listShown ? '是' : '否'}`);
    }
    await page.goto('/');
    await logout(page);
  }
  await ctx.close();

  // API：pi01、user01 各 5 次新增帳號
  let codes: string[] = [];
  for (const user of ['pi01', 'user01']) {
    const r = sh(
      TC,
      'TC-A03-03-api',
      `echo "== ${user}"
TOKEN=$(curl -s -X POST http://localhost:38180/realms/ai-platform/protocol/openid-connect/token \\
  -d grant_type=password -d client_id=ai-platform-web -d username=${user} --data-urlencode password='Dev-Passw0rd!' \\
  | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')
echo "token 長度 \${#TOKEN}"
for i in 1 2 3 4 5; do
  curl -s -w '  HTTP %{http_code}\\n' -X POST http://localhost:38980/api/admin/users \\
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
    -d "{\\"username\\":\\"KIT-A-x$i\\",\\"password\\":\\"Kit-A-Init-2026!\\",\\"account_type\\":\\"admin\\"}"
done`,
    );
    const lines = r.out.split('\n').filter((l) => /HTTP \d+/.test(l));
    codes = codes.concat(lines.map((l) => /HTTP (\d+)/.exec(l)![1]));
    note(TC, `API ${user} 新增帳號 5 次：${lines.map((l) => l.trim()).join('；')}`);
    expect(lines.every((l) => l.includes('{"detail":"需要 Admin 權限"}'))).toBeTruthy();
  }

  // admin01 確認沒有新增
  const a = await freshPage(browser);
  await login(a.page, 'admin01');
  await gotoAdmin(a.page, 'Account 帳號');
  const names = (await a.page.getByRole('table', { name: '帳號列表' }).locator('tbody th').allInnerTexts()).map((s) => s.trim());
  const leaked = names.filter((x) => /^KIT-A-x/i.test(x));
  await a.page.evaluate(() => window.scrollTo(0, 0));
  await shot(a.page, TC, '09-admin01-帳號列表無新增');
  note(TC, `admin01 帳號列表 ${names.length} 個：${names.join('、')}；KIT-A-x 開頭 ${leaked.length} 個`);
  const success = codes.filter((c) => c !== "403").length + entered + leaked.length;
  note(TC, `網頁提示 ${shown}/6；API 403 ${codes.filter((c) => c === '403').length}/10；越權成功 ${success}/16`);
  expect(shown).toBe(6);
  expect(codes).toEqual(Array(10).fill('403'));
  expect(leaked).toEqual([]);
  await a.ctx.close();
});
