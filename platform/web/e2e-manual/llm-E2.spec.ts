import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startScenario } from './kit';
import { DOCS_DIR, DOC_FILES, KB, PROJECT, llmTabLink, prep, rowOf, sideLink } from './llm-common';

// E2 建立知識庫（研究助理）。文件用 sample-data/M2/documents 的 6 份合成院內文件。本機向量模型是假服務。
test('E2 建立知識庫', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  prep('e2');
  const s = await startScenario(browser, { id: 'E2', title: '建立知識庫（參考文件）', role: 'ra01', manual: '04-研究助理', project: PROJECT });
  const p = s.page;
  s.section('目的', '把院內文件放進「參考文件」，讓語言模型回答時根據這些文件，並附上出處。');
  s.section(
    '開始前準備',
    [
      '- 帳號在專案中有使用語言模型的權限（專案權限 Coding）。研究助理預設沒有，請系統管理者在專案成員設定中開啟。',
      '- 準備好要放入的文件，格式可為 PDF、DOCX、TXT、CSV、JSON、HTML，可一次選多份。',
      '- 文件內容不要含病人個資。',
    ].join('\n'),
  );

  await s.step('按左側選單的「語言模型」', sideLink(p, '語言模型'), 'click');
  await s.step('按上方分頁「參考文件」', llmTabLink(p, '參考文件'), 'click');
  await s.step(`在「文件集名稱」輸入 ${KB}`, p.getByLabel('文件集名稱', { exact: true }), { fill: KB });
  await s.step('按「新增文件集」', p.getByRole('button', { name: '新增文件集' }), 'click');
  const card = p.getByRole('heading', { name: `文件（${KB}）` });
  await expect(card).toBeVisible();
  await s.note('右側出現這個文件集的文件區');

  const files = DOC_FILES.map((f) => path.join(DOCS_DIR, f));
  await s.step('按「選擇檔案」，選取要放入的文件', p.getByRole('button', { name: '選擇檔案', exact: true }), { upload: files }, {
    detail: `本例選了 ${DOC_FILES.length} 份：${DOC_FILES.join('、')}。`,
  });
  await expect(p.getByText(DOC_FILES[0]).first()).toBeVisible();
  await s.step('按「加入文件」', p.getByRole('button', { name: '加入文件', exact: true }), 'click');
  const counts = p.getByRole('status').filter({ hasText: /可使用 \d+ 份、重複 \d+ 份、未完成 \d+ 份/ });
  await s.wait('等待處理完成，顯示每份文件的結果', () => expect(counts).toBeVisible({ timeout: 300_000 }), {
    detail: '上方顯示「可使用 N 份、重複 N 份、未完成 N 份」，下面逐份列出結果。',
  });
  const countText = (await counts.innerText()).trim();
  console.log(`[E2] ${countText}`);
  const list = p.getByRole('list', { name: '文件與處理狀態' });
  await expect(list.getByRole('listitem')).toHaveCount(DOC_FILES.length, { timeout: 60_000 });
  await s.step('文件清單列出格式、片段數與狀態', list, undefined, {
    zoom: false,
    detail: '每份文件顯示「格式，N 個片段」與狀態徽章；「可使用」表示已切成片段可供查詢，「未完成」的文件請重新加入。',
  });
  const kbRow = rowOf(p.getByRole('table', { name: '參考文件集' }), KB);
  await kbRow.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await s.step('左側文件集顯示文件數與片段數', kbRow);

  s.section(
    '完成後的樣子',
    `「文件集」表格中「${KB}」的文件數為 ${DOC_FILES.length}，右側每份文件都是「可使用」。之後在「對話」選「文件問答」並選這個文件集，就能根據這些文件回答。`,
  );
  s.section(
    '常見問題',
    [
      '- 結果顯示「重複，已略過」：同一份文件已經在這個文件集裡，不會再加入一次。',
      '- 文件顯示「未完成」：文件沒有切出可用的內容（例如掃描成圖片的 PDF），請換成文字版後重新加入。',
      '- 要刪除某份文件：按該文件右側的三點按鈕，選「刪除文件」；刪除後回答不會再引用這份文件。',
      '- 看不到「語言模型」選單：帳號在這個專案沒有語言模型權限，請聯絡系統管理者。',
    ].join('\n'),
  );
  await s.finish();
});
