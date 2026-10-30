import { expect, test } from '@playwright/test';
import { SIDE, sideNav } from '../e2e-acceptance/helpers';
import { psql } from '../e2e-acceptance/ops';
import { IMG_PROJECT } from './img-common';
import { startScenario } from './kit';

// B2（pi01）：在影像清單用「檢查描述」篩選胸部檢查，存成資料範圍「胸部 CT」；再看專案的影像存取清單（研究區唯讀）。
export const SCOPE = '胸部 CT';

test('B2 圈定這個研究要用的影像', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'B2', title: '圈定研究要用的影像', role: 'pi01', manual: '02-計畫主持人', project: IMG_PROJECT });
  const p = s.page;
  // 鏡頭外：重跑時先刪掉上次存的同名資料範圍
  psql(`DELETE FROM imaging_scopes WHERE name='${SCOPE}' AND project_id=(SELECT id FROM projects WHERE name='${IMG_PROJECT}')`);
  s.section('目的', '從專案影像中挑出符合研究條件的影像，存成「資料範圍」，標註時直接用這個範圍；並確認專案能存取哪些影像。');
  s.section('開始前準備', '專案裡已經有匯入的影像（見研究助理手冊「把影像帶進專案」）。想好篩選條件，例如影像種類、性別、檢查描述、檢查日期、序列描述。');

  await s.step('按左側選單的「研究資料」', sideNav(p).getByRole('link', { name: SIDE.data, exact: true }), 'click');
  const filter = p.getByRole('form', { name: '篩選影像' });
  await expect(filter).toBeVisible();
  const toggle = filter.getByRole('button', { name: /展開/ });
  if (await toggle.count()) await s.step('按篩選條件右邊的「展開」', toggle, 'click');
  const summary = p.getByText(/^共 \d+ 筆影像/);
  await expect(summary).toContainText('共 20 筆影像');
  await s.step('篩選前共 20 筆影像', summary, undefined);
  await s.step('在「檢查描述」輸入 CHEST', filter.getByLabel(/檢查描述/), { fill: 'CHEST' }, {
    detail: '輸入部分文字即可，不分大小寫。',
  });
  await s.step('按「套用篩選」', filter.getByRole('button', { name: '套用篩選' }), 'click');
  await expect(summary).toContainText('共 5 筆影像');
  await s.step('篩選後剩 5 筆胸部檢查', summary, undefined);
  await s.note('清單只列出檢查描述含 CHEST 的影像');

  await s.step('按「儲存資料範圍」', filter.getByRole('button', { name: '儲存資料範圍' }), 'click');
  const save = p.getByRole('form', { name: '儲存資料範圍' });
  await s.step(`在「資料範圍名稱」輸入 ${SCOPE}`, save.getByLabel('資料範圍名稱'), { fill: SCOPE });
  await s.step('按「儲存」', save.getByRole('button', { name: '儲存', exact: true }), 'click');
  const ok = p.getByText(`已儲存資料範圍「${SCOPE}」`);
  await expect(ok).toBeVisible();
  await s.step('顯示「已儲存資料範圍」與筆數', ok, undefined);

  await s.step('點「影像存取清單」分頁', p.getByRole('navigation', { name: '影像分頁' }).getByRole('link', { name: '影像存取清單' }), 'click');
  await expect(p.getByRole('heading', { name: '影像存取清單' })).toBeVisible();
  await s.note('存取清單由系統管理者設定');

  await s.step('按左側選單的「影像標註」', sideNav(p).getByRole('link', { name: SIDE.labeling, exact: true }), 'click');
  const scopeSel = p.locator('#pending-scope');
  await expect(scopeSel).toBeVisible();
  await s.step(`在「資料範圍」選 ${SCOPE}`, scopeSel, { select: { label: `${SCOPE}（5 筆）` } });
  await expect(p.getByRole('table', { name: '研究清單' }).locator('tbody tr')).toHaveCount(5);
  await s.note('待處理清單只剩範圍內的 5 筆');

  s.section('完成後的樣子', `影像清單上方的篩選條件多一個「資料範圍」可選；在「影像標註」的待處理清單選「${SCOPE}」，只會列出範圍內的影像。`);
  s.section('常見問題', [
    '- 存了資料範圍，專案裡其他影像還在嗎？在。畫面說明「儲存資料範圍只是研究選取，不會改變專案的影像存取清單。」',
    '- 要限制專案只能看清單內的影像（Accession Number 清單）：研究區的「影像存取清單」只能查看，畫面顯示「清單由系統管理者設定，需要調整請聯絡系統管理者。」',
    '- 建立訓練時不能直接選資料範圍，只能選「全部研究」或「指定研究」逐筆勾選。',
  ].join('\n'));
  await s.finish();
});
