import { expect, test } from '@playwright/test';
import { startScenario } from './kit';
import { KB, PROJECT, apiGet, llmBase, llmTabLink, prep, sideLink } from './llm-common';

// E5 工作流程與團隊文件（Wiki）（程式助理）。前提：E2 的文件集。本機語言模型是假服務，回答內容是假的。
// 先在團隊文件建一頁 SOP（編輯、看版本、搜尋、以這頁提問），再建工作流程：查參考文件＋讀團隊文件＋產生回答。
const PAGE = '門診報到 SOP';
const PAGE_PATH = 'sop/checkin';
const V1 = ['# 門診報到 SOP', '', '1. 初診病人攜帶健保卡與身分證，到一樓掛號櫃檯填寫初診資料。', '2. 複診病人可使用自助報到機。'].join('\n');
const V2 = `${V1}\n3. 報到後依診間燈號候診；過號請洽診間護理師。`;
const FLOW = '報到問題自動答覆';

test('E5 工作流程與團隊文件', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  prep('e5');
  const base = await llmBase();
  const kbId = (await apiGet<{ id: number; name: string }[]>('ca01', `${base}/knowledge-bases`)).find((k) => k.name === KB)?.id;
  if (!kbId) throw new Error(`找不到文件集 ${KB}（先跑 E2）`);
  const s = await startScenario(browser, { id: 'E5', title: '工作流程與團隊文件（Wiki）', role: 'ca01', manual: '05-程式助理', project: PROJECT });
  const p = s.page;
  s.section('目的', '在「團隊文件」維護共用的 SOP（可編輯、看版本、搜尋），並建立多步驟的「工作流程」（LangGraph），讓語言模型依參考文件與團隊文件回答。');
  s.section('開始前準備', `- 已建立參考文件集（本例「${KB}」）。\n- 系統管理者已載入語言模型。`);

  // ---- 團隊文件（Wiki）
  await s.step('按左側選單的「語言模型」', sideLink(p, '語言模型'), 'click');
  await s.step('按上方分頁「團隊文件」', llmTabLink(p, '團隊文件'), 'click');
  await s.step('按「＋ 新增頁面」', p.getByRole('button', { name: '＋ 新增頁面' }), 'click');
  const form = p.getByRole('form', { name: '新增頁面' });
  await s.step(`「標題」輸入 ${PAGE}`, form.getByLabel('標題', { exact: true }), { fill: PAGE });
  await s.step(`「頁面路徑」輸入 ${PAGE_PATH}`, form.getByLabel('頁面路徑', { exact: true }), { fill: PAGE_PATH }, {
    detail: '頁面路徑建立後不能修改。',
  });
  await s.step('在內容區用 Markdown 撰寫', form.getByLabel('內容（Markdown）', { exact: true }), { fill: V1 }, {
    detail: '上方工具列可插入標題、清單等格式；切到「預覽」可看排版後的樣子。',
  });
  await s.step('按「儲存文件」', form.getByRole('button', { name: '儲存文件' }), 'click');
  const edit = p.getByRole('form', { name: '編輯頁面' });
  await expect(edit.getByRole('status').filter({ hasText: '已儲存' })).toBeVisible({ timeout: 60_000 });
  await s.step('出現「已儲存」，左側列出這一頁', p.getByRole('list', { name: '頁面' }).getByRole('button', { name: PAGE }));

  await s.step('修改內容，加上第 3 點', edit.getByLabel('內容（Markdown）', { exact: true }), { fill: V2 });
  await s.step('再按「儲存文件」', edit.getByRole('button', { name: '儲存文件' }), 'click');
  const versions = p.getByRole('list', { name: '版本紀錄' });
  await expect(versions).toContainText('第 2 版', { timeout: 60_000 });
  await s.step('右側「版本紀錄」多了一版', versions);
  await s.step('點「第 1 版」查看舊內容', versions.getByRole('button', { name: /第 1 版/ }), 'click');
  await expect(p.getByLabel('舊版內容')).toBeVisible();
  await s.note('舊版本只能查看，不能還原', { detail: '畫面右側滑出「第 1 版（唯讀）」，顯示當時的內容。' });
  await p.waitForTimeout(1500); // 讓影片多停一下再關閉右側面板
  await p.keyboard.press('Escape');
  await expect(p.getByLabel('舊版內容')).toHaveCount(0);

  await s.step('在左上搜尋框輸入 自助報到', p.getByRole('searchbox').or(p.locator('#wiki-q')).first(), { fill: '自助報到' });
  await p.locator('#wiki-q').press('Enter');
  await s.wait('列出檢索結果', () => expect(p.getByRole('list', { name: '檢索結果' }).getByRole('button', { name: PAGE })).toBeVisible({ timeout: 60_000 }));

  await s.step('按「以這頁提問」', edit.getByRole('button', { name: '以這頁提問' }), 'click');
  const ask = p.getByRole('form', { name: '以這頁提問' });
  await s.step('輸入問題', ask.getByLabel('問題', { exact: true }), { fill: '過號了該怎麼辦？' });
  await s.step('按「送出」', ask.getByRole('button', { name: '送出', exact: true }), 'click');
  const answer = ask.getByText(/回答（脈絡來源/);
  await s.wait('模型依這一頁回答', () => expect(answer).toBeVisible({ timeout: 120_000 }), { detail: '回答標題寫出脈絡來源，表示內容取自這一頁團隊文件。' });
  await p.waitForTimeout(1500); // 讓影片多停一下再關閉右側面板
  await p.keyboard.press('Escape');

  // ---- 工作流程
  const pageId = (await apiGet<{ id: number; title: string }[]>('ca01', `${base}/wiki/pages`)).find((x) => x.title === PAGE)!.id;
  const def = JSON.stringify(
    {
      state: { question: '' },
      nodes: [
        { id: 'docs', type: 'retrieve', kb_id: kbId, query: '{question}', output: 'docs' },
        { id: 'sop', type: 'wiki', page_id: pageId, output: 'sop' },
        { id: 'answer', type: 'llm', prompt: '參考院內文件：{docs}\n問題：{question}', context: 'sop', output: 'answer' },
      ],
      edges: [
        ['docs', 'sop'],
        ['sop', 'answer'],
      ],
    },
    null,
    2,
  );
  await s.step('按上方分頁「工作流程」', llmTabLink(p, '工作流程'), 'click');
  await s.step('按「＋ 新增流程」', p.getByRole('button', { name: '＋ 新增流程' }), 'click');
  const wf = p.getByRole('form', { name: '新增工作流' });
  await s.step(`「名稱」輸入 ${FLOW}`, wf.getByLabel('名稱', { exact: true }), { fill: FLOW });
  await s.step('「流程用途」簡單說明', wf.getByLabel('流程用途（選填）', { exact: true }), { fill: '依參考文件與報到 SOP 回答' });
  await s.step('「定義」貼上流程的 JSON', wf.getByLabel(/^定義（JSON/), { fill: def }, {
    detail: `本例三個節點：docs 查參考文件「${KB}」、sop 讀團隊文件「${PAGE}」、answer 交給語言模型產生回答。`,
  });
  await s.step('中間「流程預覽」顯示節點與順序', p.getByRole('list', { name: '節點流程圖' }));
  await s.step('按「新增工作流」', wf.getByRole('button', { name: '新增工作流' }), 'click');
  await expect(p.getByRole('list', { name: '工作流列表' }).getByRole('button', { name: new RegExp(FLOW) })).toBeVisible();
  await s.step('按「執行輸入」分頁', p.getByRole('tablist', { name: '工作流程分頁' }).getByRole('tab', { name: '執行輸入' }), 'click');
  await s.step('輸入問題（JSON 格式）', p.getByLabel('執行輸入（JSON）', { exact: true }), { fill: '{"question": "複診病人怎麼報到？"}' }, {
    detail: '欄位要和定義的 state 相同；按「範例格式」可帶入空白範本。',
  });
  await s.step('按「執行流程」', p.getByRole('button', { name: /執行流程/ }), 'click');
  const result = p.getByRole('region', { name: '上次執行結果' });
  await s.wait('顯示「執行成功」與每個節點的紀錄', () => expect(result).toContainText(/執行成功|執行失敗/, { timeout: 180_000 }));
  const okRun = /執行成功/.test(await result.innerText());
  console.log(`[E5] 執行結果：${(await result.innerText()).replace(/\s+/g, ' ').slice(0, 400)}`);
  expect(okRun, '工作流程執行失敗').toBe(true);
  await s.step('按「執行結果」看逐節點輸出', p.getByRole('tablist', { name: '工作流程分頁' }).getByRole('tab', { name: '執行結果' }), 'click');
  await s.step('每個節點列出狀態與輸出', p.getByRole('list', { name: '逐節點結果' }), undefined, {
    zoom: false,
    detail: '產生回答的節點可展開「模型請求與回應」，查看實際送給模型的內容。',
  });

  s.section(
    '完成後的樣子',
    `「團隊文件」有「${PAGE}」一頁，版本紀錄有 2 版，搜尋「自助報到」找得到，「以這頁提問」能得到回答；「工作流程」有「${FLOW}」，執行後顯示「執行成功」，「執行結果」列出每個節點的輸出。`,
  );
  s.section(
    '常見問題',
    [
      '- 按「新增工作流」出現錯誤：定義 JSON 有誤，例如「定義不是合法的 JSON」，或節點缺少欄位（「節點 … 缺少 page_id」）。依訊息修正後再按一次。',
      '- 按「執行流程」出現「輸入不是合法的 JSON」：執行輸入要是 JSON，例如 {"question": "…"}。',
      '- 「以這頁提問」按不下去：要先儲存這一頁才能提問。',
      '- 想還原舊版本：舊版本只能查看，不能比較或還原；請複製舊內容後重新儲存。',
    ].join('\n'),
  );
  await s.finish();
});
