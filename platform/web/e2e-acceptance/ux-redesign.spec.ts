import { expect, test } from '@playwright/test';
import { ADMIN_SIDE, CONTRACT_ENTRIES, DENIED, P1, SIDE, catalogList, clickMenu, clickTab, menuLabels, note, openCatalog, sideNav, startsWith, useProject } from './helpers';
import { PROJECT_TABS, adminSide, psql, sh, userPage } from './ops';
import { shotUrl } from './r-common';

// 介面改版：依角色走 03-介面定案規格 第一節的流程並截圖（不改驗收判定，只確認新導覽走得通）。
//   md01（MD）：首頁「繼續標註」→ 工作台「儲存並開啟下一筆」
//   pi01（PI）：首頁 → 訓練紀錄 → 模型結果 → 預測新資料
//   admin01：管理區總覽 → 專案頁四分頁 → 運算資源 → 功能目錄 8 入口逐一點入
//   vw01（Viewer）：嘗試刪除表格資料集被拒
const TC = '介面改版';
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

test('MD：首頁繼續標註 → 工作台儲存並開啟下一筆', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const pid = psql(`select id from projects where name='${P1}'`);
  const startAnn = Number(psql('select coalesce(max(id),0) from label_annotations'));
  const { ctx, page } = await userPage(browser, 'md01');
  await useProject(page, P1);
  await sideNav(page).getByRole('link', { name: SIDE.home, exact: true }).click();
  const cont = page.getByRole('link', { name: '繼續標註' }).or(page.getByRole('button', { name: '繼續標註' })).first();
  await expect(cont).toBeVisible();
  const pending = page.getByText(/還有 \d+ 筆.*待處理/).first();
  note(TC, `md01 首頁：${(await pending.count()) ? flat(await pending.innerText()) : '（沒有「還有 N 筆待處理」字樣）'}`);
  await shotUrl(page, TC, 'md01-01-首頁');
  await cont.click();
  // 沒有「上次處理」時首頁先到影像標註的待處理清單，再按清單上的「繼續標註」開第一筆
  await page.waitForURL(/\/labeling(\/studies\/|$|\?)/);
  if (!/\/labeling\/studies\//.test(page.url())) {
    note(TC, `md01 首頁「繼續標註」先到 ${new URL(page.url()).pathname}（待處理清單），再按清單的「繼續標註」`);
    await shotUrl(page, TC, 'md01-01b-待處理清單');
    await page.getByTestId('label-progress').getByRole('button', { name: '繼續標註' }).click();
  }
  await expect(page).toHaveURL(/\/labeling\/studies\//);
  await expect(page.getByTestId('viewport').first()).toHaveAttribute('data-ready', '1', { timeout: 60_000 });
  const first = page.url();
  await shotUrl(page, TC, 'md01-02-工作台第一筆');

  // 分類標註一筆，按「儲存並開啟下一筆」
  const label = page.getByRole('combobox', { name: '標籤' });
  if ((await label.inputValue()) === '') await label.fill('normal');
  await page.getByRole('button', { name: '儲存並開啟下一筆' }).click();
  await expect(page).not.toHaveURL(first, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/labeling\/studies\//);
  await expect(page.getByTestId('viewport').first()).toHaveAttribute('data-ready', '1', { timeout: 60_000 });
  note(TC, `md01 儲存並開啟下一筆：${new URL(first).pathname} → ${new URL(page.url()).pathname}`);
  await shotUrl(page, TC, 'md01-03-儲存後開啟下一筆');

  // MD 看不到建立模型、語言模型與系統管理
  const side = (await sideNav(page).getByRole('link').allInnerTexts()).map((s) => s.trim());
  note(TC, `md01 側欄：${side.join('、')}`);
  expect(side).not.toContain(SIDE.training);
  expect(side).not.toContain(SIDE.llm);
  expect(side).not.toContain(SIDE.admin);
  await ctx.close();

  // 還原：刪除這次 md01 在 P1 存的標註（經 API，與畫面上刪除相同）
  const ids = psql(`select id from label_annotations where id > ${startAnn} and project_id=${pid} and created_by='md01'`).split('\n').filter(Boolean);
  for (const id of ids) {
    sh(
      TC,
      'md01-還原標註',
      `T=$(curl -s -X POST http://localhost:38180/realms/ai-platform/protocol/openid-connect/token \\
  -d grant_type=password -d client_id=ai-platform-web -d username=md01 --data-urlencode password='Dev-Passw0rd!' \\
  | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')
curl -s -w 'HTTP %{http_code}\\n' -X DELETE -H "Authorization: Bearer $T" http://localhost:38980/api/projects/${pid}/labels/annotations/${id}`,
    );
  }
  note(TC, `還原：刪除 md01 這次存的標註 ${ids.length} 筆（${ids.join('、') || '無'}）`);
});

test('PI：首頁 → 訓練紀錄 → 模型結果 → 預測新資料', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  // 用 pi01 有「已完成訓練」的專案（優先 P1；開發資料 P1 可能還沒有訓練）
  const proj =
    process.env.UX_PI_PROJECT ||
    psql(
      `select p.name from training_runs r join projects p on p.id=r.project_id join memberships m on m.project_id=p.id join users u on u.id=m.user_id ` +
        `where u.username='pi01' and r.status='succeeded' group by p.name order by (p.name='${P1}') desc, max(r.id) desc limit 1`,
    ) ||
    P1;
  note(TC, `pi01 使用專案：${proj}`);
  const { ctx, page } = await userPage(browser, 'pi01');
  await useProject(page, proj);
  await sideNav(page).getByRole('link', { name: SIDE.home, exact: true }).click();
  await page.waitForLoadState('networkidle');
  note(TC, `pi01 首頁：${flat(await page.locator('main').innerText()).slice(0, 300)}`);
  await shotUrl(page, TC, 'pi01-01-首頁');

  await clickMenu(page, SIDE.training);
  await expect(page.getByRole('navigation', { name: '建立模型分頁' }).getByRole('link', { name: '訓練紀錄' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('table', { name: '訓練清單' })).toBeVisible();
  await shotUrl(page, TC, 'pi01-02-訓練紀錄');

  // 打開一筆已完成的訓練（單次訓練頁）
  await page.getByRole('link', { name: /^查看結果 #\d+$/ }).first().click();
  await expect(page).toHaveURL(/\/training\/runs\/\d+/);
  const runId = /\/runs\/(\d+)/.exec(page.url())![1];
  await shotUrl(page, TC, 'pi01-03-單次訓練');

  // 模型結果
  await page.getByRole('link', { name: '前往使用模型' }).click();
  await expect(page).toHaveURL(new RegExp(`/models/${runId}/result`));
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main').getByText('載入中…')).toHaveCount(0, { timeout: 30_000 });
  const main = flat(await page.locator('main').innerText());
  note(TC, `pi01 模型 #${runId} 結果：${main.slice(0, 300)}`);
  await shotUrl(page, TC, 'pi01-04-模型結果');

  await clickTab(page, '預測新資料', page.getByRole('navigation', { name: '模型分頁' }));
  await expect(page).toHaveURL(new RegExp(`/models/${runId}/predict`));
  await shotUrl(page, TC, 'pi01-05-預測新資料');
  await ctx.close();
});

test('Admin：總覽 → 專案頁四分頁 → 運算資源 → 功能目錄 8 入口', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const { ctx, page } = await userPage(browser, 'admin01');
  // Admin 登入後（還沒選過專案）直接進管理區
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  note(TC, `admin01 登入後的位置：${new URL(page.url()).pathname}`);
  await adminSide(page, ADMIN_SIDE.overview);
  await expect(page).toHaveURL(/\/admin$/);
  await shotUrl(page, TC, 'admin01-01-管理區總覽');

  await adminSide(page, ADMIN_SIDE.projects);
  await page.getByRole('table', { name: '專案列表' }).getByRole('link', { name: P1, exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/projects\/\d+/);
  for (const [i, t] of Object.values(PROJECT_TABS).entries()) {
    await clickTab(page, t, page.locator('main'));
    await shotUrl(page, TC, `admin01-${String(i + 2).padStart(2, '0')}-專案頁-${t.replace(/\s/g, '')}`);
  }

  await adminSide(page, ADMIN_SIDE.compute);
  const tabs = ['GPU 使用對照', '排隊順序', '共享設定', 'GPU 群組', '節點'];
  for (const [i, t] of tabs.entries()) {
    await clickTab(page, t, page.locator('main'));
    await expect(page.getByText(DENIED)).toHaveCount(0);
    await shotUrl(page, TC, `admin01-${String(i + 6).padStart(2, '0')}-運算資源-${t.replace(/\s/g, '')}`);
  }

  // 回研究區選 P1，功能目錄的 8 個契約入口逐一點入
  await sideNav(page).getByRole('link', { name: ADMIN_SIDE.back, exact: true }).click();
  await useProject(page, P1);
  const labels = await menuLabels(page);
  note(TC, `admin01 功能目錄：${labels.join('、')}`);
  expect(labels).toEqual([...CONTRACT_ENTRIES]);
  await shotUrl(page, TC, 'admin01-11-功能目錄');
  let ok = 0;
  for (const [i, e] of CONTRACT_ENTRIES.entries()) {
    await openCatalog(page);
    await catalogList(page).getByRole('link', { name: startsWith(e) }).first().click();
    await page.waitForLoadState('networkidle');
    await expect(page).not.toHaveURL(/\/catalog$/);
    await expect(page.getByText(DENIED)).toHaveCount(0);
    note(TC, `功能目錄「${e}」→ ${new URL(page.url()).pathname}${new URL(page.url()).search}`);
    await shotUrl(page, TC, `admin01-${12 + i}-入口-${e.replace(/\s/g, '')}`);
    ok++;
  }
  note(TC, `功能目錄 8 入口進入成功 ${ok}/8`);
  expect(ok).toBe(8);
  await ctx.close();
});

test('Viewer：嘗試刪除表格資料集被拒', async ({ browser }) => {
  const ds = psql(`select t.id || '|' || t.name from tabular_datasets t join projects p on p.id=t.project_id where p.name='${P1}' order by t.id limit 1`);
  expect(ds).toMatch(/^\d+\|/);
  const [id, name] = ds.split('|');
  const pid = psql(`select id from projects where name='${P1}'`);
  const { ctx, page } = await userPage(browser, 'vw01');
  await useProject(page, P1);
  await clickMenu(page, SIDE.data);
  await clickTab(page, /^表格/, page.locator('main'));
  await expect(page.getByRole('link', { name, exact: true }).first()).toBeVisible();
  const delBtn = page.getByRole('button', { name: `刪除 ${name}`, exact: true });
  const btnCount = await delBtn.count();
  note(TC, `vw01 表格資料集清單：「刪除 ${name}」按鈕 ${btnCount} 個`);
  await shotUrl(page, TC, 'vw01-01-資料集清單沒有刪除按鈕');

  // 直接呼叫 API 刪除也被拒
  const r = sh(
    TC,
    'vw01-刪除資料集-api',
    `T=$(curl -s -X POST http://localhost:38180/realms/ai-platform/protocol/openid-connect/token \\
  -d grant_type=password -d client_id=ai-platform-web -d username=vw01 --data-urlencode password='Dev-Passw0rd!' \\
  | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')
curl -s -w '  HTTP %{http_code}\\n' -X DELETE -H "Authorization: Bearer $T" http://localhost:38980/api/projects/${pid}/tabular/datasets/${id}`,
  );
  const code = /HTTP (\d+)/.exec(r.out)?.[1];
  const still = psql(`select count(*) from tabular_datasets where id=${id}`);
  note(TC, `vw01 以 API 刪除資料集 #${id}：${r.out.trim()}；資料庫仍在 ${still} 筆`);
  expect(btnCount).toBe(0);
  expect(code).toBe('403');
  expect(still).toBe('1');
  await ctx.close();
});
