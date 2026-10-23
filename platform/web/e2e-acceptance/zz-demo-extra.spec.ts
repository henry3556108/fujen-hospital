import { expect, test, type Locator, type Page } from '@playwright/test';
import { clickMenu, note, shot, useProject } from './helpers';
import { adminTab, userPage } from './ops';

// 一條龍演示腳本的輔助檢查（部署驗證用，非正式驗收腳本）：
//   還原：admin01 刪除並重建 DEMO-一條龍（gpu-shared），成員 pi01（PI）、md01（MD）
//   醫學統計：第 3 段的數字（描述統計、Logistic、Kaplan-Meier）
//   巨集：建模管理有「流程程式碼「…」」與「匯入專案包」按鈕（只看不操作）
const PROJECT = 'DEMO-一條龍';
const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

test('還原：刪除並重建 DEMO-一條龍', async ({ browser }) => {
  const TC = process.env.RESTORE_TC || '還原DEMO專案';
  const { ctx, page } = await userPage(browser, 'admin01');
  await adminTab(page, '專案');
  await page.waitForLoadState('networkidle');
  const table = page.getByRole('table', { name: '專案列表' });
  if (await table.getByRole('rowheader', { name: PROJECT, exact: true }).count()) {
    await page.getByRole('button', { name: `刪除 ${PROJECT}`, exact: true }).click();
    const dlg = page.getByRole('dialog');
    note(TC, `刪除確認視窗：${flat(await dlg.innerText())}`);
    await dlg.getByRole('button', { name: '確認刪除' }).click();
    await expect(status(page, `已刪除專案「${PROJECT}」`)).toBeVisible();
    note(TC, `已刪除專案 ${PROJECT}`);
  }
  const form = page.getByRole('form', { name: '新增專案' });
  await form.getByLabel('專案名稱（必填）').fill(PROJECT);
  const group = form.getByLabel('GPU 群組');
  const option = (await group.locator('option').allInnerTexts()).find((t) => t.startsWith('gpu-shared'));
  expect(option, 'GPU 群組選單要有 gpu-shared').toBeTruthy();
  await group.selectOption({ label: option! });
  await form.getByRole('button', { name: '新增專案' }).click();
  await expect(status(page, `已新增專案「${PROJECT}」`)).toBeVisible();
  note(TC, `已新增專案 ${PROJECT}，GPU 群組 ${option}`);
  await shot(page, TC, '01-專案');
  await adminTab(page, '專案成員');
  await page.locator('#member-project').selectOption({ label: PROJECT });
  await page.waitForLoadState('networkidle');
  for (const [user, role] of [['pi01', 'Principal Investigator'], ['md01', 'Medical Doctor']]) {
    const f = page.getByRole('form', { name: '設定專案成員' });
    await f.getByLabel('帳號').selectOption({ label: user });
    await f.getByLabel('角色').selectOption({ label: role });
    await f.getByRole('button', { name: '加入專案' }).click();
    await expect(status(page, `已將「${user}」設定為`)).toBeVisible();
  }
  note(TC, `專案成員：${flat(await page.getByRole('table', { name: '目前的專案成員' }).innerText())}`);
  await shot(page, TC, '02-專案成員');
  await ctx.close();
});

async function pick(sel: Locator, text: string) {
  const exact = sel.locator('option', { hasText: new RegExp(`^\\s*${text}\\s*$`) });
  const option = (await exact.count()) ? exact.first() : sel.locator('option', { hasText: text }).first();
  const value = await option.getAttribute('value');
  await sel.selectOption(value ?? text);
}
const labelOf = async (page: Page, id: string) => {
  const l = page.locator(`label[for=${id}]`);
  return (await l.count()) ? flat(await l.first().innerText()) : '(無 label)';
};

test('第 3 段醫學統計數字', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const TC = '一條龍醫學統計';
  const { ctx, page } = await userPage(browser, 'pi01');
  await useProject(page, PROJECT);
  await clickMenu(page, '數據管理');
  await page.getByRole('navigation', { name: '數據管理分頁' }).getByRole('link', { name: /^結構式資料/ }).click();
  note(TC, `結構式資料頁：${flat(await page.locator('main').innerText()).slice(0, 600)}`);
  await page.getByRole('link', { name: /^cohort_01/ }).first().click();
  await page.getByRole('link', { name: '描述統計', exact: true }).first().click();
  await page.waitForTimeout(2000);
  const main = flat(await page.locator('main').innerText());
  note(TC, `描述統計頁（前 800 字）：${main.slice(0, 800)}`);
  note(TC, `列欄文字：${(main.match(/[^ ]*\d+ 列、\d+ 欄[^ ]*/g) || []).join(' | ')}`);
  const table = page.getByRole('table', { name: '描述統計' });
  note(TC, `描述統計表頭：${flat(await table.locator('thead').innerText())}`);
  const ageRow = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'age', exact: true }) });
  const ageAlt = table.locator('tr').filter({ hasText: /^\s*age\b/ });
  note(TC, `age 列：${(await ageRow.count()) ? flat(await ageRow.first().innerText()) : (await ageAlt.count()) ? flat(await ageAlt.first().innerText()) : '找不到'}`);
  await shot(page, TC, '01-描述統計');

  await page.getByRole('link', { name: '統計分析', exact: true }).first().click();
  const model = page.locator('#stats-model');
  note(TC, `模型下拉 label：${await labelOf(page, 'stats-model')}；選項：${(await model.locator('option').allInnerTexts()).map(flat).join('／')}`);
  await pick(model, 'Logistic 迴歸');
  note(TC, `結果欄位 label：${await labelOf(page, 'stats-target')}`);
  await pick(page.locator('#stats-target'), 'diagnosis');
  const feats = page.getByRole('group', { name: /特徵欄位|共變項/ });
  note(TC, `特徵欄位群組名：${flat((await feats.first().locator('legend').allInnerTexts()).join('|'))}`);
  for (const box of await feats.first().getByRole('checkbox').all()) {
    const name = (await box.getAttribute('aria-label')) || (await box.evaluate((e) => (e.closest('label')?.textContent || '').trim()));
    await box.setChecked(['age', 'bmi'].includes(String(name).trim()));
  }
  await page.getByRole('button', { name: '執行分析' }).click();
  await expect(page.getByText(/AUC/).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const lr = flat(await page.locator('main').innerText());
  note(TC, `Logistic 結果 AUC 附近：${(lr.match(/.{0,40}AUC.{0,60}/g) || []).join(' | ')}`);
  note(TC, `Logistic 有 ROC 字樣：${/ROC/.test(lr)}；有 0.8369：${lr.includes('0.8369')}`);
  await shot(page, TC, '02-Logistic');

  await pick(model, 'Kaplan-Meier');
  note(TC, `KM 選項文字：${flat(await model.locator('option:checked').innerText())}`);
  note(TC, `KM labels：${await labelOf(page, 'stats-duration')}｜${await labelOf(page, 'stats-event')}｜${await labelOf(page, 'stats-group')}`);
  await pick(page.locator('#stats-duration'), 'time_to_event');
  await pick(page.locator('#stats-event'), 'event');
  await pick(page.locator('#stats-group'), 'sex');
  await page.getByRole('button', { name: '執行分析' }).click();
  await expect(page.getByText(/[Ll]og-?rank/).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const km = flat(await page.locator('main').innerText());
  note(TC, `KM 結果 log-rank 附近：${(km.match(/.{0,40}[Ll]og-?rank.{0,60}/g) || []).join(' | ')}`);
  note(TC, `KM 有 0.3754：${km.includes('0.3754')}`);
  await shot(page, TC, '03-KaplanMeier');
  await ctx.close();
});

test('巨集功能按鈕存在（只看）', async ({ browser }) => {
  const TC = '巨集功能確認';
  const { ctx, page } = await userPage(browser, 'pi01');
  await useProject(page, PROJECT);
  await clickMenu(page, '建模管理');
  await page.waitForLoadState('networkidle');
  const flowBtns = page.getByRole('button', { name: /^流程程式碼「.+」$/ });
  const importBtn = page.getByRole('button', { name: '匯入專案包' });
  note(TC, `流程程式碼按鈕 ${await flowBtns.count()} 個：${(await flowBtns.allInnerTexts()).map(flat).join('、')}`);
  note(TC, `匯入專案包按鈕 ${await importBtn.count()} 個`);
  await shot(page, TC, '01-建模管理');
  expect(await importBtn.count()).toBeGreaterThan(0);
  expect(await flowBtns.count()).toBeGreaterThan(0);
  await ctx.close();
});
