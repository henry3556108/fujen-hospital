import { expect, test } from '@playwright/test';
import { startScenario } from './kit';
import { KB, PROJECT, assistantCount, llmTabLink, prep, rowOf, sideLink, waitReply } from './llm-common';

// E3 試對話、調整到滿意（研究助理）。前提：E2 已建立文件集「院內作業規範」。本機語言模型是假服務，回答內容是假的。
const PROMPT = '衛教-病人聽得懂';

test('E3 試對話、調整到滿意', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  prep('e3');
  const s = await startScenario(browser, { id: 'E3', title: '試對話、調整到滿意', role: 'ra01', manual: '04-研究助理', project: PROJECT });
  const p = s.page;
  s.section('目的', '找出適合用途的提問方式與回答設定：存一個問答範本、調整生成參數，再分別用一般問答與文件問答試問，確認回答附上出處。');
  s.section(
    '開始前準備',
    [
      `- 已建立參考文件集（本例為「${KB}」，見「建立知識庫」）。`,
      '- 系統管理者已在「模型」分頁載入語言模型。對話頁不能切換模型，模型的量化與資源在「模型」分頁設定。',
    ].join('\n'),
  );

  // 1. 問答範本
  await s.step('按左側選單的「語言模型」', sideLink(p, '語言模型'), 'click');
  await s.step('按上方分頁「問答範本」', llmTabLink(p, '問答範本'), 'click');
  const form = p.getByRole('form', { name: '新增問答範本' });
  await s.step(`「標題」輸入 ${PROMPT}`, form.getByLabel('標題（必填）', { exact: true }), { fill: PROMPT });
  await s.step('「內容」寫提問方式，{input} 代表問題', form.getByLabel(/^內容（必填/), { fill: '請用病人聽得懂的話回答，最後列出要注意的事項：{input}' });
  await s.step('「tag」輸入 衛教,門診', form.getByLabel('tag（以逗號分隔）', { exact: true }), { fill: '衛教,門診' });
  await s.step('「可見範圍」選「公開」', form.getByLabel('可見範圍', { exact: true }), { select: 'public' }, {
    detail: '「個人」只有自己看得到；「公開（專案成員都看得到）」會出現在其他成員的「共用範本」。',
  });
  await s.step('按「新增問答範本」', form.getByRole('button', { name: '新增問答範本' }), 'click');
  await expect(form.getByRole('status').filter({ hasText: `已新增問答範本「${PROMPT}」` })).toBeVisible();
  await s.step('出現「已新增問答範本」', form.getByRole('status').first());

  await s.step('在「搜尋」輸入 衛教', p.getByLabel('搜尋（標題、內容、tag）', { exact: true }), { fill: '衛教' });
  await s.step('按「搜尋」，找回剛存的範本', p.getByRole('button', { name: '搜尋', exact: true }), 'click');
  const prow = rowOf(p.getByRole('table', { name: '問答範本' }), PROMPT);
  await expect(prow).toBeVisible();
  await s.step('表格列出範本、tag 與可見範圍', prow);

  // 2. 回答設定（生成參數）
  await s.step('按上方分頁「對話」', llmTabLink(p, '對話'), 'click');
  await s.step('按右上角「設定」', p.getByRole('button', { name: '設定', exact: true }), 'click');
  const params = p.getByRole('form', { name: '生成參數' });
  await expect(params).toBeVisible();
  // 數字欄位：kit 的 fill 會先清空再逐字輸入，React 會把空白顯示成 0（變成 00.3），所以直接 fill
  const temp = params.getByLabel('Temperature', { exact: true });
  await s.step('「Temperature」改成 0.3，回答較穩定', temp, undefined, {
    detail: '其他參數：Max New Tokens（回答長度上限）、Repetition Penalty、Length Penalty、Top K、Top P，每欄下方有說明。',
  });
  await temp.fill('0.3');
  const maxTok = params.getByLabel('Max New Tokens', { exact: true });
  await s.step('「Max New Tokens」改成 400', maxTok);
  await maxTok.fill('400');
  await expect(temp).toHaveValue('0.3');
  await s.step('「System Prompt」寫模型的角色', params.getByLabel('System Prompt', { exact: true }), {
    fill: '你是醫院的衛教人員，回答要簡短，並依院內文件說明。',
  });
  await s.step('按「儲存設定」', params.getByRole('button', { name: '儲存設定', exact: true }), 'click');
  await expect(params.getByRole('status').filter({ hasText: '已儲存生成參數' })).toBeVisible();
  await s.step('出現「已儲存生成參數」', params.getByRole('status').first());
  await p.getByRole('button', { name: '設定', exact: true }).click(); // 收起面板，讓對話區寬一點

  // 3. 一般問答＋範本
  await s.step('左側「問答範本」按「共用範本」', p.getByRole('tablist', { name: '範本範圍' }).getByRole('tab', { name: '共用範本', exact: true }), 'click');
  await s.step(`點選「${PROMPT}」套用`, p.getByRole('list', { name: '範本清單' }).getByRole('button', { name: PROMPT }), 'click');
  const composer = p.getByRole('form', { name: '送出訊息' });
  await expect(composer).toContainText(`使用範本：${PROMPT}`);
  const input = p.getByLabel('訊息', { exact: true });
  await s.step('輸入框上方顯示「使用範本」，輸入問題', input, { fill: '抽血前需要空腹嗎？' });
  let before = await assistantCount(p);
  await s.step('按「送出」', p.getByRole('button', { name: '送出', exact: true }), 'click');
  await s.wait('模型回覆，下方顯示回應時間', () => waitReply(p, before));

  // 4. 文件問答（RAG）
  await s.step('上方切到「文件問答」', p.getByRole('tablist', { name: '問答模式' }).getByRole('tab', { name: '文件問答', exact: true }), 'click');
  const kbSel = p.getByLabel('參考文件', { exact: true });
  const opt = (await kbSel.locator('option', { hasText: KB }).first().getAttribute('value')) ?? '';
  await s.step(`左側「參考文件」選 ${KB}`, kbSel, { select: opt }, { detail: '選好後下方列出這個文件集的文件與狀態。' });
  await s.step('輸入要查證的問題', input, { fill: '複診病人可以用什麼方式報到？' });
  before = await assistantCount(p);
  await s.step('按「送出」', p.getByRole('button', { name: '送出', exact: true }), 'click');
  const reply = await (async () => {
    let r: Awaited<ReturnType<typeof waitReply>> | null = null;
    await s.wait('回答下方列出「參考來源」', async () => {
      r = await waitReply(p, before);
    });
    return r!;
  })();
  const src = reply.getByRole('list', { name: '參考來源' });
  const hasSources = (await src.count()) > 0;
  console.log(`[E3] 參考來源：${hasSources ? (await src.innerText()).replace(/\s+/g, ' ') : '（沒有）'}`);
  if (hasSources) await s.step('來源卡片顯示檔名與段落', src);
  await s.step('換題目或設定前，按「開新對話」', p.getByRole('button', { name: '開新對話', exact: true }), 'click', {
    detail: '切換「一般問答／文件問答」或換文件集，也會開始新的對話。',
  });

  s.section(
    '完成後的樣子',
    `「問答範本」有一個公開範本「${PROMPT}」，搜尋 tag 找得到；「設定」裡的生成參數與 System Prompt 已儲存（之後發布內部服務會沿用）；文件問答的回答下方列出「參考來源：檔名 · 段落 N」。`,
  );
  s.section(
    '常見問題',
    [
      '- 回答一直沒出來，出現「模型沒有回應」：訊息還沒送出，按「重試」再送一次；若一直失敗，請系統管理者確認模型已載入。',
      '- 文件問答的「送出」按不下去：輸入框上方顯示「請先選擇參考文件。」，先在左側選一個文件集。',
      '- 改了設定沒有生效：要按「儲存設定」並看到「已儲存生成參數」；離開頁面前沒儲存會跳出提醒。',
      '- 不想套用範本：按輸入框上方的「不使用範本」。',
    ].join('\n'),
  );
  await s.finish();
});
