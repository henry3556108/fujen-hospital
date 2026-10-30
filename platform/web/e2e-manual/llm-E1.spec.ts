import { expect, test } from '@playwright/test';
import { startsWith } from '../e2e-acceptance/helpers';
import { startScenario } from './kit';
import { PROJECT, llmTabLink, prep, rowOf, sideLink } from './llm-common';

// E1 準備大型語言模型（系統管理者）。本機是假模型服務：下載的是只有設定檔的測試模型，畫面流程與正式環境相同。
// 鏡頭外：白名單登記 fake-llm-small（要示範下載）與 fake-llm-old（已下載，示範刪除）。
const MODEL = 'fake-llm-small';
const OLD = 'fake-llm-old';

test('E1 準備大型語言模型', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  prep('e1');
  const s = await startScenario(browser, { id: 'E1', title: '準備大型語言模型', role: 'admin01', manual: '01-系統管理者', project: PROJECT });
  const p = s.page;
  s.section('目的', '讓院內可以使用本地的語言模型，資料不離開醫院。模型要先經系統管理者核准、下載並載入，研究人員才能在對話中使用。');
  s.section(
    '開始前準備',
    [
      '- 要使用的模型已由資訊室登記在模型白名單（白名單由資訊室維護，網頁上沒有登記畫面）。',
      `- 已選好要使用語言模型的專案（本例為「${PROJECT}」）。`,
      '- 模型若需要 Token（例如受限的 Hugging Face 模型），先向資訊室取得。',
    ].join('\n'),
  );

  await s.step('按左側選單的「語言模型」', sideLink(p, '語言模型'), 'click');
  await s.step('按上方分頁「模型」', llmTabLink(p, '模型'), 'click');
  const table = p.getByRole('table', { name: '白名單模型' });
  await expect(rowOf(table, MODEL)).toBeVisible();
  await s.step('「可用模型」列出白名單內的模型', table, undefined, { zoom: false, detail: '狀態欄顯示「可申請」「申請中」「已下載」「已載入」。' });
  const row = rowOf(table, MODEL);
  await s.step(`在 ${MODEL} 這一列按「申請下載」`, row.getByRole('button', { name: '申請下載' }), 'click');
  await expect(row).toContainText('申請中');
  await s.step('狀態變成「申請中」，等待管理者核准', row.getByText('申請中'));

  // 管理者核准
  await s.step('按左側選單的「系統管理」', sideLink(p, '系統管理'), 'click');
  await s.step('按左側選單的「稽核與審核」', sideLink(p, '稽核與審核'), 'click');
  await s.step('按上方分頁「模型下載審核」', p.locator('main').getByRole('link', { name: '模型下載審核', exact: true }), 'click');
  const review = p.getByRole('table', { name: '待審核的下載申請' });
  const item = rowOf(review, MODEL);
  await expect(item).toBeVisible();
  await s.step('確認模型名稱與申請人後按「核准」', item.getByRole('button', { name: '核准', exact: true }), 'click', {
    detail: '不同意下載時按「駁回」。',
  });
  await expect(item).toHaveCount(0);
  await s.note('待審核清單已清空');

  // 回研究區下載
  await s.step('按左側選單的「回研究區」', sideLink(p, '回研究區'), 'click');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  if (/\/projects/.test(p.url())) {
    const main = p.locator('main');
    await s.step(`點選專案「${PROJECT}」`, main.getByRole('button', { name: startsWith(PROJECT) }), 'click');
    await s.step('按「進入專案」', main.getByRole('button', { name: /進入專案/ }), 'click');
  }
  await expect(p.locator('select#project-switcher option:checked')).toHaveText(PROJECT);
  await s.step('按左側選單的「語言模型」', sideLink(p, '語言模型'), 'click');
  await s.step('按上方分頁「模型」', llmTabLink(p, '模型'), 'click');
  await expect(row).toContainText('已核准，待下載');
  await s.step('狀態為「已核准，待下載」，按「下載」', row.getByRole('button', { name: '下載', exact: true }), 'click', {
    detail: '模型需要 Token 時，先在上方「下載 Token（選填）」填入；Token 不會被儲存。',
  });
  await s.wait('等待下載完成，狀態變成「已下載」', () => expect(row).toContainText('已下載', { timeout: 300_000 }));

  // 載入設定：量化與資源
  await s.step('按這一列的「載入設定」', row.getByRole('button', { name: '載入設定', exact: true }), 'click');
  const sec = p.getByRole('region', { name: `${MODEL} 資源設定` });
  await expect(sec).toBeVisible();
  const quant = sec.getByRole('group', { name: '量化設定', exact: true });
  await s.step('「量化設定」選「4-bit」', quant.getByRole('radio', { name: '4-bit', exact: true }), 'click', {
    detail: '4-bit 占用記憶體最少；8-bit 品質較好、占用較多；「不量化」最占資源。',
  });
  await s.step('確認 CPU、記憶體與 GPU 類型', sec.getByRole('group', { name: 'GPU 類型', exact: true }), undefined, {
    detail: '「CPU 核心數」「記憶體（GB）」「GPU 張數」照預設即可；GPU 類型可選「獨占」「共享」「只用 CPU」。',
  });
  await s.step('按「載入」', sec.getByRole('button', { name: '載入', exact: true }), 'click');
  await s.wait('出現「已載入」，模型可以使用了', () => expect(sec.getByRole('status').filter({ hasText: '已載入' }).first()).toBeVisible({ timeout: 180_000 }));
  await expect(row).toContainText('已載入');

  // 刪除不用的模型
  const oldRow = rowOf(table, OLD);
  await s.step(`按 ${OLD} 這一列最右邊的三點按鈕`, oldRow.getByRole('button', { name: `${OLD} 更多操作` }), 'click');
  await s.step('選「刪除模型」', p.getByRole('menuitem', { name: '刪除模型' }), 'click');
  const dialog = p.getByRole('dialog');
  await s.step('確認提示後按「刪除模型」', dialog.getByRole('button', { name: '刪除模型' }), 'click');
  await expect(oldRow.getByRole('button', { name: '載入設定', exact: true })).toHaveCount(0);
  await expect(oldRow).toContainText('可申請');
  await s.note(`${OLD} 已刪除，狀態回到「可申請」`);

  s.section(
    '完成後的樣子',
    `「可用模型」中 ${MODEL} 的狀態為「已載入」，研究人員可以在「對話」使用；刪除的模型狀態回到「可申請」，模型檔案已移除，要再用需重新申請下載。`,
  );
  s.section(
    '常見問題',
    [
      '- 找不到想用的模型：只有白名單內的模型會出現在「可用模型」；要新增模型請聯絡資訊室登記白名單。',
      '- 按「申請下載」後一直是「申請中」：需要系統管理者到「系統管理 › 稽核與審核 › 模型下載審核」按「核准」。',
      '- 下載失敗：「下載申請」分頁的狀態欄會寫出原因；申請會回到「已核准，待下載」，可以再按一次「下載」。',
      '- 調整了量化或資源沒有變化：修改資源後要重新載入才會生效（已載入時按「套用並重新載入」）。',
    ].join('\n'),
  );
  await s.finish();
});
