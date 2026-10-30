import { expect, test } from '@playwright/test';
import { P1, SIDE, sideNav, startsWith } from '../e2e-acceptance/helpers';
import { startScenario } from './kit';

// 工具組示範（A2 簡版）：pi01 在鏡頭前登入 → 選擇專案 P1-lung-ct → 專案首頁 → 功能目錄。
test('A2 示範：登入、選擇專案、功能目錄', async ({ browser }) => {
  const s = await startScenario(browser, {
    id: 'A2',
    title: '登入與選擇專案',
    role: 'pi01',
    manual: '02-計畫主持人',
    login: false,
  });
  const p = s.page;
  s.section('目的', '登入平台，進入要工作的研究專案，並找到各項功能的入口。');
  s.section('開始前準備', '向系統管理者取得帳號與密碼，並確認帳號已加入研究專案。');

  await s.login();
  if (!/\/projects/.test(p.url())) await p.goto('/projects');
  const main = p.locator('main');
  await s.step(`點選專案「${P1}」`, main.getByRole('button', { name: startsWith(P1) }), 'click');
  await s.step('按「進入專案」', main.getByRole('button', { name: /進入專案/ }), 'click');
  await expect(p.locator('select#project-switcher option:checked')).toHaveText(P1);
  await s.note('畫面顯示專案首頁');
  await s.step('按左側選單的「功能目錄」', sideNav(p).getByRole('link', { name: SIDE.catalog, exact: true }), 'click');
  await expect(p.getByRole('heading', { level: 1, name: SIDE.catalog })).toBeVisible();
  await s.note('功能目錄列出你能使用的功能');

  s.section('完成後的樣子', `頂端「目前專案」顯示 ${P1}，左側選單可以進入各項功能。`);
  s.section('常見問題', '看不到專案：帳號還沒加入任何專案，請聯絡系統管理者。');
  await s.finish();
});
