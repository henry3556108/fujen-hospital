import { expect, test } from '@playwright/test';
import { sideNav } from '../e2e-acceptance/helpers';
import { IMG_PROJECT, status } from './img-common';
import { startScenario } from './kit';

// A1（admin01）：建立示範專案「手冊-胸部影像研究」，加入 pi01（PI）、md01（MD）、ra01（RA）、ca01（Coder）、vw01（Viewer）。
// 專案已存在時先在鏡頭外刪除重建（影像主線從這裡重新開始）。
const MEMBERS: [string, string][] = [
  ['pi01', 'Principal Investigator'],
  ['md01', 'Medical Doctor'],
  ['ra01', 'Research Assistant'],
  ['ca01', 'Coder Assistant'],
  ['vw01', 'Viewer'],
];

test('A1 開專案並找人進來', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'A1', title: '開專案並加入成員', role: 'admin01', manual: '01-系統管理者' });
  const p = s.page;

  // 鏡頭外：舊的示範專案先刪除
  await p.goto('/admin/projects');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  const del = p.getByRole('button', { name: `刪除 ${IMG_PROJECT}`, exact: true });
  if (await del.count()) {
    await del.click();
    await p.getByRole('dialog').getByRole('button', { name: '確認刪除' }).click();
    await expect(status(p, `已刪除專案「${IMG_PROJECT}」`)).toBeVisible();
  }
  await p.goto('/admin');
  await p.waitForLoadState('networkidle').catch(() => undefined);

  s.section('目的', '為一個研究建立獨立的專案，資料、成員與算力都只屬於這個研究，不會和其他研究混在一起。');
  s.section('開始前準備', '確認研究名稱、要使用的 GPU 群組，以及每位成員的帳號與角色（PI、MD、RA、Coder、Viewer）。成員的帳號要先在「帳號」頁建立好。');

  await s.step('按左側選單的「專案」', sideNav(p).getByRole('link', { name: '專案', exact: true }), 'click');
  const form = p.getByRole('form', { name: '新增專案' });
  await s.step(`在「專案名稱」輸入 ${IMG_PROJECT}`, form.getByLabel('專案名稱（必填）'), { fill: IMG_PROJECT });
  await s.step('在「說明」輸入研究內容', form.getByLabel('說明', { exact: true }), { fill: '胸部 CT 影像分類（正常／異常）示範研究' });
  const group = form.getByLabel('GPU 群組');
  const option = (await group.locator('option').allInnerTexts()).find((t) => t.startsWith('gpu-shared'));
  await s.step('在「GPU 群組」選共享群組', group, { select: { label: option! } }, {
    detail: '共享群組的 GPU 由多個專案排隊輪流使用；獨占群組只給這個專案用。',
  });
  await s.step('按「新增專案」', form.getByRole('button', { name: '新增專案' }), 'click');
  await expect(status(p, `已新增專案「${IMG_PROJECT}」`)).toBeVisible();
  await s.note('上方顯示「已新增專案」');

  const table = p.getByRole('table', { name: '專案列表' });
  await s.step(`在專案列表點「${IMG_PROJECT}」`, table.getByRole('link', { name: IMG_PROJECT, exact: true }), 'click');
  await expect(p).toHaveURL(/\/admin\/projects\/\d+/);
  await s.step('點「成員與權限」分頁', p.locator('main').getByRole('link', { name: '成員與權限', exact: true }), 'click');
  await p.waitForLoadState('networkidle').catch(() => undefined);

  const f = p.getByRole('form', { name: '設定專案成員' });
  for (const [user, role] of MEMBERS) {
    await s.step(`在「帳號」選 ${user}`, f.getByLabel('帳號'), { select: { label: user } });
    await s.step(`在「角色」選 ${role}`, f.getByLabel('角色'), { select: { label: role } }, user === 'pi01'
      ? { detail: '選好角色後，下方「功能權限」會帶入這個角色的預設權限，可逐項調整。' }
      : {});
    await s.step('按「加入專案」', f.getByRole('button', { name: '加入專案' }), 'click');
    await expect(status(p, `已將「${user}」設定為`)).toBeVisible();
  }
  const list = p.getByRole('table', { name: '目前的專案成員' });
  for (const [user] of MEMBERS) await expect(list).toContainText(user);
  await s.step('「目前的專案成員」列出 5 位成員', list, undefined, { zoom: false });

  s.section('完成後的樣子', `「目前的專案成員」表格列出 pi01、md01、ra01、ca01、vw01 與各自的角色。成員下次登入後，在「選擇專案」頁就看得到「${IMG_PROJECT}」，看到的功能依角色不同。`);
  s.section('常見問題', [
    '- 按「新增專案」後出現錯誤、專案沒有建立：專案名稱是必填，且不能和既有專案重複。',
    '- 「帳號」下拉選單找不到某位成員：帳號還沒建立，請先到左側選單「帳號」新增。名稱後面有「（已是成員）」表示他已經在這個專案裡，選他會改成編輯。',
    '- 改了已是成員者的角色：按「儲存變更」會先跳出確認，並在「變更摘要」列出新增與移除的權限。',
  ].join('\n'));
  await s.finish();
});
