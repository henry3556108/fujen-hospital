import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { clickMenu, note, shot } from './helpers';
import {
  Checks, PA, ROW, SERVICE, SETTING, WEB, begin, dirOf, download, flat, gotoTraining, openEditor, openFlow, openUnlock, openAs,
  stageStates, statesText, statusMsg, step, textArea, zipList,
} from './m2-common';

// M2驗證\05-部署環節.md（F-04、F-05 部署環節；部署頁的鎖定與改回）。帳號 pi01，專案 M2-FLOW-A。
const TC = '05';
const NAME = 'flow-test';

async function gotoDeployments(page: Page) {
  await clickMenu(page, 'AI 模型部署');
  await expect(page.getByRole('heading', { level: 1, name: 'AI 模型部署' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const section = page.getByRole('region', { name: '已分享的模型' });
  await expect(section).toBeVisible();
  return section;
}

/** 已分享的模型中名為 SERVICE 的列：數量、分享給、鎖定說明、「修改分享對象」是否可按 */
async function serviceInfo(section: Locator) {
  const page = section.page();
  const rows = section.getByRole('table', { name: '已分享的模型' }).getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: SERVICE, exact: true }) });
  const count = await rows.count();
  if (!count) return { count, users: '', lock: '', editEnabled: false };
  const row = rows.first();
  await row.scrollIntoViewIfNeeded();
  const usersCell = flat(await row.getByRole('cell').nth(1).innerText());
  const lockEl = row.getByTestId('deployment-lock');
  const lock = (await lockEl.count()) ? flat(await lockEl.innerText()) : '';
  const users = lock ? flat(usersCell.replace(lock, '')) : usersCell;
  const editEnabled = await row.getByRole('button', { name: `修改分享對象「${SERVICE}」`, exact: true }).isEnabled();
  return { count, users, lock, editEnabled };
}

async function applyDeploy(page: Page, label: string, users: string[]) {
  const panel = await openFlow(page, SETTING);
  const ed = await openEditor(panel, 'deploy');
  const area = textArea(ed, 'deploy.json');
  const cfg = JSON.parse(await area.inputValue()) as { model?: { sha256?: string }; deployment?: Record<string, unknown> | null };
  cfg.deployment = { ...(cfg.deployment ?? {}), name: NAME, title: SERVICE, allowed_users: users };
  await area.fill(`${JSON.stringify(cfg, null, 2)}\n`);
  await ed.getByRole('button', { name: `套用「${WEB.deploy}」`, exact: true }).click();
  const applied = statusMsg(panel, `已套用「${WEB.deploy}」`);
  await expect(applied.or(panel.getByRole('alert').first())).toBeVisible({ timeout: 60_000 });
  const ok = await applied.isVisible();
  note(TC, `${label}套用結果：${flat(await (ok ? applied : panel.getByRole('alert').first()).innerText())}`);
  return { ok, panel };
}

test.use({ actionTimeout: 30_000 });

test('M2 05 部署環節', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  begin(TC, 'M2 05 部署環節');
  const c = new Checks(TC);
  const { ctx, page } = await openAs(browser, 'pi01', PA);
  const pre = await serviceInfo(await gotoDeployments(page));
  if (pre.count) c.diff(`開始前已有「${SERVICE}」（前一輪留下）：分享給 ${pre.users}${pre.lock ? `；${pre.lock}` : ''}。套用時會更新同名服務；若模型已不同會被擋下，請先在部署頁「停止分享」`);
  await gotoTraining(page);

  // 1 下載部署環節檔
  step(TC, 1, `流程程式碼表格「下載環節檔「${ROW.deploy}」」，存到 05\\`);
  let panel = await openFlow(page, SETTING);
  const d = await download(page, () => panel.getByRole('button', { name: `下載環節檔「${ROW.deploy}」`, exact: true }).click(), dirOf(TC));
  note(TC, `下載 ${path.basename(d.file)}：${zipList(d.file).join('、')}`);
  c.diff(`部署那一列是「${ROW.deploy}」，按鈕是「下載環節檔「${ROW.deploy}」」「檢視設定檔「${ROW.deploy}」」「改回用介面設定「${ROW.deploy}」」；編輯區的套用按鈕才是「套用「${WEB.deploy}」」`);

  // 2 deploy.json 帶入模型
  step(TC, 2, `「檢視設定檔「${ROW.deploy}」」：deploy.json 的 model.sha256 已帶入最近一次訓練的模型`);
  const ed = await openEditor(panel, 'deploy');
  const text = await textArea(ed, 'deploy.json').inputValue();
  const cfg = JSON.parse(text) as { model?: { sha256?: string; run_id?: number } | null };
  note(TC, `deploy.json：${flat(text).slice(0, 400)}`);
  await shot(page, TC, '01-部署設定檔');
  c.check('步驟 2 model.sha256 已帶入', Boolean(cfg.model?.sha256), `run_id ${cfg.model?.run_id ?? '—'}，sha256 ${cfg.model?.sha256?.slice(0, 12) ?? '—'}`);
  await ed.getByRole('button', { name: '不套用，關閉', exact: true }).click();

  // 3 套用部署
  step(TC, 3, `deploy.json：deployment.name ${NAME}、title「${SERVICE}」、allowed_users ["pi01", "md01"]，按「套用「${WEB.deploy}」」`);
  const a3 = await applyDeploy(page, '步驟 3 ', ['pi01', 'md01']);
  panel = a3.panel;
  await shot(page, TC, '02-套用部署');
  c.check(`步驟 3 建立服務 ${NAME}`, a3.ok);
  note(TC, `五環節：${statesText(await stageStates(panel))}`);

  // 4 部署頁鎖定
  step(TC, 4, '左側「AI 模型部署」→「已分享的模型」');
  const i4 = await serviceInfo(await gotoDeployments(page));
  note(TC, `「${SERVICE}」${i4.count} 列；分享給 ${i4.users}；${i4.lock || '（沒有匯入檔控制標示）'}；修改分享對象 ${i4.editEnabled ? '可按' : '停用'}`);
  await shot(page, TC, '03-部署頁鎖定');
  c.check(`步驟 4 有「${SERVICE}」`, i4.count === 1, `${i4.count} 列`);
  c.check('步驟 4 標示「匯入檔控制」與「由 deploy.json 控制（pi01，…，訓練設定「FLOW-結構式」）」',
    i4.lock.includes('匯入檔控制') && /由 deploy\.json 控制（pi01，.+，訓練設定「FLOW-結構式」）/.test(i4.lock), i4.lock);
  c.check('步驟 4 「修改分享對象」停用', !i4.editEnabled);
  c.check('步驟 4 分享對象 pi01、md01', i4.users === 'md01、pi01' || i4.users === 'pi01、md01', i4.users);

  // 5 再套用只更新
  step(TC, 5, '回「建模管理」，allowed_users 改成 ["pi01"] 再套用一次');
  await gotoTraining(page);
  const a5 = await applyDeploy(page, '步驟 5 ', ['pi01']);
  c.check('步驟 5 再套用通過', a5.ok);
  const i5 = await serviceInfo(await gotoDeployments(page));
  note(TC, `「${SERVICE}」${i5.count} 列；分享給 ${i5.users}`);
  await shot(page, TC, '04-再套用只更新不新增');
  c.check('步驟 5 仍只有一個「M2 驗證服務」', i5.count === 1, `${i5.count} 列`);
  c.check('步驟 5 分享對象只剩 pi01', i5.users === 'pi01', i5.users);

  // 6 改回
  step(TC, 6, `回「建模管理」，「改回用介面設定「${ROW.deploy}」」→ 確認`);
  await gotoTraining(page);
  panel = await openFlow(page, SETTING);
  const dlg = await openUnlock(panel, ROW.deploy);
  note(TC, `確認視窗：${flat(await dlg.innerText())}`);
  await dlg.getByRole('button', { name: '刪除匯入檔並改回介面設定', exact: true }).click();
  await expect(statusMsg(panel, `已改回用介面設定「${ROW.deploy}」`)).toBeVisible({ timeout: 30_000 });
  const s6 = await stageStates(panel);
  note(TC, `五環節：${statesText(s6)}`);
  await shot(page, TC, '05-改回部署');
  c.check(`步驟 6 ${ROW.deploy}改回「介面設定」`, s6[ROW.deploy] === '介面設定');

  // 7 服務仍在、標示消失
  step(TC, 7, '「AI 模型部署」');
  const i7 = await serviceInfo(await gotoDeployments(page));
  note(TC, `「${SERVICE}」${i7.count} 列；分享給 ${i7.users}；${i7.lock || '（沒有匯入檔控制標示）'}；修改分享對象 ${i7.editEnabled ? '可按' : '停用'}`);
  await shot(page, TC, '06-服務仍在標示消失');
  c.check('步驟 7 「M2 驗證服務」仍在', i7.count === 1);
  c.check('步驟 7 「匯入檔控制」標示消失', i7.lock === '');
  c.check('步驟 7 「修改分享對象」可以按', i7.editEnabled);
  await ctx.close();
  c.finish();
});
