import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  DOCS_DIR, DOC_FILES, GATEWAY, Scenario, api, ask, deleteKbs, ensureKb, llmBase, llmTab, okMsg, oneLine, rowOf, selectContaining, sh, token,
} from './n-bc-common';

// 新功能情境 B5–B7（docs/05-新增功能使用情境.md）：知識庫（RAG）、Prompt 範本、發布 API，搭配真模型 gemma-3-4b-it。
// 角色：ca01（P1-lung-ct 的 Coding 權限）；B7 以 md01（授權）與 vw01（未授權）呼叫發布的服務。
// 文件：sample-data/M2/documents 的 6 份合成院內文件（N_DOCS_DIR 可改）。
// 每個情境都可單獨執行：B6、B7 缺知識庫時以 API 先建好。全部結束（afterAll）刪除服務、Prompt、知識庫並還原 ca01 的生成參數。

const KB = 'KIT-B5-衛教';
const PROMPT = 'KIT-B6 病人聽得懂';
const SLUG = 'kit-b7-nursing';
const SERVICE = 'KIT-B7 護理部知識問答';

let origParams: Record<string, unknown> | null = null;

test.afterAll(async () => {
  test.setTimeout(120_000);
  const s = new Scenario('B5-B7-清理', '刪除 B5–B7 建立的資料');
  const base = await llmBase();
  for (const svc of ((await api('ca01', 'GET', `${base}/services`)).json ?? []) as { id: number; slug: string }[]) {
    if (svc.slug === SLUG) s.log(`取消發布 ${SLUG} → HTTP ${(await api('ca01', 'DELETE', `${base}/services/${svc.id}`)).status}`);
  }
  for (const p of ((await api('ca01', 'GET', `${base}/prompts`)).json ?? []) as { id: number; title: string }[]) {
    if (p.title.startsWith('KIT-B6')) s.log(`刪除 Prompt「${p.title}」→ HTTP ${(await api('ca01', 'DELETE', `${base}/prompts/${p.id}`)).status}`);
  }
  await deleteKbs(s, KB);
  if (origParams) s.log(`還原 ca01 生成參數 → HTTP ${(await api('ca01', 'PUT', `${base}/generation-params`, origParams)).status}`);
});

// 改版後用語：Playground→對話、知識庫→參考文件、Prompt 範本→問答範本、發布 API→內部服務；
// 對話模式 Free Chat→一般問答、Chat with Knowledge Base→文件問答（改版後是頁內分頁「問答模式」，不再是下拉）。
const MODE_FREE = '一般問答';
const MODE_KB = '文件問答';

const modeTab = (page: Page, name: string) => page.getByRole('tablist', { name: '問答模式' }).getByRole('tab', { name, exact: true });

/** 語言模型 › 對話（原 Playground） */
async function playground(page: Page) {
  await llmTab(page, 'Playground');
  await expect(page.getByRole('tablist', { name: '問答模式' })).toBeVisible();
}

/** 切換對話模式分頁（已是該分頁就不再點，點了會開新對話） */
async function setMode(page: Page, name: string) {
  const t = modeTab(page, name);
  if ((await t.getAttribute('aria-selected')) !== 'true') await t.click();
  await expect(t).toHaveAttribute('aria-selected', 'true');
}

/** 「文件問答」分頁左側的「參考文件」下拉（label 視覺隱藏） */
const kbSelect = (page: Page) => page.getByLabel('參考文件', { exact: true });

/** 「一般問答」分頁左側的「問答範本」清單：切到範圍分頁、點一下套用；輸入框上方出現「使用範本：標題」 */
async function pickPrompt(page: Page, title: string, scope: '個人範本' | '共用範本' = '共用範本') {
  await setMode(page, MODE_FREE);
  await page.getByRole('tablist', { name: '範本範圍' }).getByRole('tab', { name: scope, exact: true }).click();
  const item = page.getByRole('list', { name: '範本清單' }).getByRole('button', { name: title });
  await expect(item).toBeVisible({ timeout: 30_000 });
  if ((await item.getAttribute('aria-pressed')) !== 'true') await item.click();
  await expect(page.getByRole('form', { name: '送出訊息' })).toContainText(`使用範本：${title}`);
}

/** 不使用範本（原下拉選「不使用」）：按輸入框上方的「不使用範本」 */
async function clearPrompt(page: Page) {
  const off = page.getByRole('form', { name: '送出訊息' }).getByRole('button', { name: '不使用範本', exact: true });
  if (await off.isVisible()) await off.click();
  await expect(off).toHaveCount(0);
}

/** 回應下方的「出處：…」與「回應時間 N 秒」 */
function replyLine(r: { text: string; sources: string; seconds: string }) {
  return `回應「${oneLine(r.text).slice(0, 120)}」；${r.sources || '（沒有出處）'}；${r.seconds}`;
}

/** 最新一筆模型呼叫紀錄（佐證 Prompt 範本與知識庫有實際送出） */
async function lastCall() {
  const r = await api('ca01', 'GET', `${await llmBase()}/calls?origin=playground`);
  const c = (r.json ?? [])[0] as { id: number; prompt_id: number | null; context_source: string | null; context_refs: unknown } | undefined;
  return c ? `呼叫紀錄 #${c.id}：prompt_id=${c.prompt_id ?? '無'}、context_source=${c.context_source ?? '無'}` : `（查不到呼叫紀錄 HTTP ${r.status}）`;
}

test('B5 用院內文件建知識問答', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const s = new Scenario('B5', '用院內文件建知識問答');
  await s.run(async () => {
    await deleteKbs(s, KB); // 重跑時先刪掉上次留下的同名知識庫
    const ca = await s.open(browser, 'ca01');

    // 第 1 步：「參考文件」（原知識庫）輸入文件集名稱，按「新增文件集」
    await llmTab(ca, '知識庫');
    await ca.getByLabel('文件集名稱', { exact: true }).fill(KB);
    await s.step(ca, '步驟 1', '輸入參考文件集名稱', { line: KB });
    await ca.getByRole('button', { name: '新增文件集' }).click();

    // 第 2 步：新知識庫自動選取，出現「文件（名稱）」區塊
    const docs = ca.getByRole('heading', { name: `文件（${KB}）` });
    await expect(docs).toBeVisible();
    await expect(rowOf(ca.getByRole('table', { name: '參考文件集' }), KB)).toBeVisible();
    await s.step(ca, '步驟 2', '新文件集自動選取', { focus: docs });

    // 第 3 步：「選擇檔案」選 6 份文件，按「加入文件」（原「上傳並建立向量」）
    const chooser = ca.waitForEvent('filechooser');
    await ca.getByRole('button', { name: '選擇檔案', exact: true }).click();
    await (await chooser).setFiles(DOC_FILES.map((f) => path.join(DOCS_DIR, f)));
    await expect(ca.getByText(DOC_FILES[0])).toBeVisible();
    await s.step(ca, '步驟 3', '已選擇6份文件', { line: DOC_FILES.join('、'), focus: docs });
    await ca.getByRole('button', { name: '加入文件', exact: true }).click();

    // 第 4 步：「可使用 N 份、重複 N 份、未完成 N 份」（原「寫入／重複／失敗」）、每個檔案的結果、文件清單「檔名（格式，N 個片段）：可使用」
    const counts = okMsg(ca, /可使用 \d+ 份、重複 \d+ 份、未完成 \d+ 份/);
    await expect(counts).toBeVisible({ timeout: 180_000 });
    const countText = oneLine(await counts.innerText());
    const results = (await ca.getByRole('list', { name: '上傳結果' }).getByRole('listitem').allInnerTexts()).map(oneLine);
    const listed = ca.getByRole('list', { name: '文件與處理狀態' });
    await expect(listed.getByRole('listitem')).toHaveCount(DOC_FILES.length, { timeout: 30_000 });
    const docsText = (await listed.getByRole('listitem').allInnerTexts()).map(oneLine);
    await s.step(ca, '步驟 4', '上傳結果與文件清單', { line: `${countText}｜${results.join('；')}｜${docsText.join('；')}`, focus: counts, full: true });
    await s.soft('6 份文件全部寫入（可使用 6 份、重複 0 份、未完成 0 份）', () => expect(countText).toContain(`可使用 ${DOC_FILES.length} 份、重複 0 份、未完成 0 份`));
    // 新版清單一列是「檔名 … 大小 · HTML，N 個片段」，仍要同一列看得到檔名、格式與片段數
    await s.soft('文件清單列出檔名、格式與片段數', () => expect(docsText.join('\n')).toMatch(/registration_flow\.html[\s\S]{0,80}?HTML，\d+ 個片段/));

    // 要注意：同一份文件重複上傳會判為重複
    const again = ca.waitForEvent('filechooser');
    await ca.getByRole('button', { name: '選擇檔案', exact: true }).click();
    await (await again).setFiles(path.join(DOCS_DIR, 'registration_flow.html'));
    await ca.getByRole('button', { name: '加入文件', exact: true }).click();
    await expect(okMsg(ca, '可使用 0 份、重複 1 份、未完成 0 份')).toBeVisible({ timeout: 120_000 });
    await s.step(ca, '要注意', '同一份文件重複上傳判為重複', {
      line: (await ca.getByRole('list', { name: '上傳結果' }).innerText()).trim(),
      focus: ca.getByRole('list', { name: '上傳結果' }),
    });

    // 第 5 步：對話（原 Playground），「對話模式」選「根據文件回答」（原 Chat with Knowledge Base），「參考文件」選剛建立的
    await playground(ca);
    await setMode(ca, MODE_KB);
    await selectContaining(kbSelect(ca), KB);
    await s.step(ca, '步驟 5', '選擇對話模式與參考文件', { line: oneLine(await kbSelect(ca).locator('option:checked').innerText()) });

    // 第 6–7 步：輸入問題按「送出」（第二題用 Enter），回應下方「出處：檔名…」「回應時間 N 秒」
    const q1 = '複診病人可以用什麼方式報到？';
    const r1 = await ask(s, ca, q1, '步驟 6');
    await s.step(ca, '步驟 7', '回應與出處（送出按鈕）', { line: replyLine(r1), focus: ca.getByRole('list', { name: '對話內容' }).locator('li').last() });
    await s.soft('回應下方列出出處 registration_flow.html', () => expect(r1.sources).toContain('registration_flow.html'));
    await s.soft('回應下方顯示回應時間', () => expect(r1.seconds).toMatch(/回應時間 [\d.]+ 秒/));
    const q2 = '夜間門診是星期幾？';
    const r2 = await ask(s, ca, q2, '步驟 6（Enter）', 'enter');
    await s.step(ca, '步驟 7', '回應與出處（Enter 送出）', { line: replyLine(r2), focus: ca.getByRole('list', { name: '對話內容' }).locator('li').last() });
    await s.soft('第二題出處為 outpatient_hours.pdf', () => expect(r2.sources).toContain('outpatient_hours.pdf'));
    s.log(`呼叫紀錄佐證：${await lastCall()}`);
    return `建立知識庫、上傳 6 份（${countText}）、重複上傳判為重複；兩題回應皆有出處與回應時間`;
  });
});

test('B6 Prompt 範本與知識庫一起用', async ({ browser }) => {
  test.setTimeout(12 * 60_000);
  const s = new Scenario('B6', 'Prompt 範本與知識庫一起用');
  await s.run(async () => {
    await ensureKb(s, KB);
    const base = await llmBase();
    for (const p of ((await api('ca01', 'GET', `${base}/prompts`)).json ?? []) as { id: number; title: string }[]) {
      if (p.title === PROMPT) s.log(`前置清理：刪除上次留下的 Prompt #${p.id} → HTTP ${(await api('ca01', 'DELETE', `${base}/prompts/${p.id}`)).status}`);
    }
    const ca = await s.open(browser, 'ca01');

    // 第 1 步：「問答範本」（原 Prompt 範本）的「新增問答範本」表單
    await llmTab(ca, 'Prompt 範本');
    const form = ca.getByRole('form', { name: '新增問答範本' });
    await form.getByLabel('標題（必填）', { exact: true }).fill(PROMPT);
    await form.getByLabel('tag（以逗號分隔）', { exact: true }).fill('衛教,KIT');
    await form.getByLabel('可見範圍', { exact: true }).selectOption({ label: '公開（專案成員都看得到）' });
    await form.getByLabel('內容（必填').fill('請用病人聽得懂的話回答：{input}');
    await s.step(ca, '步驟 1', '填寫新增問答範本', { focus: form });

    // 第 2 步：按「新增問答範本」，出現「已新增問答範本「…」」
    await form.getByRole('button', { name: '新增問答範本' }).click();
    await expect(okMsg(ca, `已新增問答範本「${PROMPT}」`)).toBeVisible();
    const row = rowOf(ca.getByRole('table', { name: '問答範本' }), PROMPT);
    await expect(row).toContainText('共用'); // 改版後可見範圍欄顯示「共用」（表單選項仍是「公開（專案成員都看得到）」）
    await s.step(ca, '步驟 2', '已新增問答範本', { line: oneLine(await row.innerText()), full: true });

    // 第 3–4 步：Playground 三種組合
    await playground(ca);
    const q = '洗手時乾洗手要搓揉多久？';
    // (a) 只用範本：自由對話＋範本
    await setMode(ca, MODE_FREE);
    await pickPrompt(ca, PROMPT);
    await s.step(ca, '步驟 3a', '只用範本（自由對話＋範本）');
    const ra = await ask(s, ca, q, '步驟 4a');
    const callA = await lastCall();
    await s.step(ca, '步驟 4a', '只用範本的回應', { line: `${replyLine(ra)}；${callA}`, focus: ca.getByRole('list', { name: '對話內容' }).locator('li').last() });
    await s.soft('只用範本：沒有出處、呼叫紀錄有 prompt_id', () => {
      expect(ra.sources).toBe('');
      expect(callA).toMatch(/prompt_id=\d+/);
    });

    // 第 5 步：「開新對話」清空 → (b) 只用參考文件：根據文件回答＋參考文件、範本「不使用」
    await ca.getByRole('button', { name: '開新對話' }).click();
    await expect(ca.getByRole('list', { name: '對話內容' }).locator('li')).toHaveCount(0);
    await setMode(ca, MODE_KB);
    await selectContaining(kbSelect(ca), KB);
    await clearPrompt(ca);
    await s.step(ca, '步驟 3b', '只用參考文件（範本不使用）');
    const rb = await ask(s, ca, q, '步驟 4b');
    const callB = await lastCall();
    await s.step(ca, '步驟 4b', '只用知識庫的回應', { line: `${replyLine(rb)}；${callB}`, focus: ca.getByRole('list', { name: '對話內容' }).locator('li').last() });
    await s.soft('只用知識庫：出處為 hand_hygiene.txt', () => expect(rb.sources).toContain('hand_hygiene.txt'));

    // (c) 兩者一起：知識庫＋範本
    await ca.getByRole('button', { name: '開新對話' }).click();
    // 範本清單只在「一般問答」分頁：先切過去點範本，再切回「文件問答」（文件集與範本都會保留）
    await pickPrompt(ca, PROMPT);
    await setMode(ca, MODE_KB);
    await expect(kbSelect(ca).locator('option:checked')).toContainText(KB);
    await expect(ca.getByRole('form', { name: '送出訊息' })).toContainText(`使用範本：${PROMPT}`);
    await s.step(ca, '步驟 3c', '參考文件與範本一起用');
    const rc = await ask(s, ca, q, '步驟 4c');
    const callC = await lastCall();
    await s.step(ca, '步驟 4c', '兩者一起的回應', { line: `${replyLine(rc)}；${callC}`, focus: ca.getByRole('list', { name: '對話內容' }).locator('li').last() });
    await s.soft('兩者一起：有出處且呼叫紀錄有 prompt_id', () => {
      expect(rc.sources).toContain('hand_hygiene.txt');
      expect(callC).toMatch(/prompt_id=\d+/);
    });
    return '新增 Prompt 出現「已新增 Prompt」；只用範本、只用知識庫、兩者一起三種組合皆有回應，用到知識庫時列出出處';
  });
});

test('B7 把知識問答發布給其他系統呼叫', async ({ browser }) => {
  test.setTimeout(12 * 60_000);
  const s = new Scenario('B7', '把知識問答發布給其他系統呼叫');
  await s.run(async () => {
    await ensureKb(s, KB);
    const base = await llmBase();
    for (const svc of ((await api('ca01', 'GET', `${base}/services`)).json ?? []) as { id: number; slug: string }[]) {
      if (svc.slug === SLUG) s.log(`前置清理：取消上次留下的服務 #${svc.id} → HTTP ${(await api('ca01', 'DELETE', `${base}/services/${svc.id}`)).status}`);
    }
    origParams ??= (await api('ca01', 'GET', `${base}/generation-params`)).json;
    s.log(`ca01 原本的生成參數：${JSON.stringify(origParams)}`);
    const ca = await s.open(browser, 'ca01');

    // 第 1 步：「對話 →（右上）設定 → 右側『回答設定』面板」調整生成參數並按「儲存設定」（原「儲存生成參數」）
    await playground(ca);
    const open = ca.getByRole('button', { name: '設定', exact: true });
    if ((await open.getAttribute('aria-expanded')) !== 'true') await open.click();
    await expect(ca.getByRole('complementary', { name: '回答設定' })).toBeVisible();
    const params = ca.getByRole('form', { name: '生成參數' });
    await params.getByLabel('Temperature', { exact: true }).fill('0.3');
    await params.getByLabel('Max New Tokens', { exact: true }).fill('256');
    await params.getByRole('button', { name: '儲存設定', exact: true }).click();
    await expect(okMsg(ca, '已儲存生成參數')).toBeVisible();
    await s.step(ca, '步驟 1', '儲存生成參數', { line: 'Temperature 0.3、Max New Tokens 256', focus: params });

    // 第 2 步：「內部服務」（原發布 API）的「發布為內部服務」表單
    await llmTab(ca, '發布 API');
    const form = ca.getByRole('form', { name: '發布為內部服務' });
    await form.getByLabel('服務代號（小寫英數字與 -）', { exact: true }).fill(SLUG);
    await form.getByLabel('名稱', { exact: true }).fill(SERVICE);
    await form.getByLabel('參考文件', { exact: true }).selectOption({ label: KB });
    const grants = form.getByLabel('授權帳號（以逗號分隔）', { exact: true });
    await grants.pressSequentially('md');
    const pick = form.getByRole('list', { name: '符合的帳號' }).getByRole('button', { name: 'md01', exact: true });
    await expect(pick).toBeVisible({ timeout: 10_000 });
    await s.step(ca, '步驟 2', '輸入帳號開頭md列出符合帳號', { focus: form });
    await pick.click();
    await expect(grants).toHaveValue(/md01/);
    await s.step(ca, '步驟 2', '填好發布表單', { line: `服務代號 ${SLUG}、名稱 ${SERVICE}、參考文件 ${KB}、授權帳號「${await grants.inputValue()}」`, focus: form });

    // 第 3 步：按「發布」，出現「已發布「名稱」：POST 端點」，列表「端點」欄
    await form.getByRole('button', { name: '發布', exact: true }).click();
    const endpoint = `/api/llm-services/${SLUG}/invoke`;
    await expect(okMsg(ca, `已發布「${SERVICE}」：POST ${endpoint}`)).toBeVisible({ timeout: 60_000 });
    const row = rowOf(ca.getByRole('table', { name: '已發布的服務' }), SERVICE);
    await expect(row).toContainText(endpoint);
    await s.step(ca, '步驟 3', '已發布', { line: oneLine(await row.innerText()), full: true });

    // 要注意：只有「授權帳號」內的帳號能經 Gateway 呼叫（以 curl 呼叫，token 不寫進紀錄）
    const call = async (who: string | null, label: string) => {
      const auth = who ? `-H "Authorization: Bearer $TOKEN" ` : '';
      const body = `{"question":"複診病人可以用什麼方式報到？"}`;
      const r = await sh(
        s,
        `curl -s -m 180 -w '\\nHTTP %{http_code}\\n' -X POST ${GATEWAY}${endpoint} ${auth}-H 'Content-Type: application/json' -d '${body}'`,
        { env: { TOKEN: who ? await token(who) : '' }, display: `（${label}）curl -X POST ${GATEWAY}${endpoint} ${who ? `-H "Authorization: Bearer <${who} 的 token>" ` : ''}-d '${body}'` },
      );
      const code = /HTTP (\d{3})\s*$/.exec(r.out.trim())?.[1] ?? '?';
      s.log(`${label}：HTTP ${code}｜${oneLine(r.out).slice(0, 300)}`);
      return code;
    };
    const ok = await call('md01', '授權帳號 md01 呼叫');
    const denied = await call('vw01', '未授權帳號 vw01 呼叫');
    const anon = await call(null, '不帶 token 呼叫');
    await s.soft('授權帳號 200、未授權 403、未登入 401', () => expect([ok, denied, anon]).toEqual(['200', '403', '401']));

    // 第 4 步：「停用」→「啟用」→「取消發布」
    await row.getByRole('button', { name: '停用', exact: true }).click();
    await expect(row.getByRole('cell', { name: '停用', exact: true })).toBeVisible();
    await s.step(ca, '步驟 4', '已停用', { line: oneLine(await row.innerText()), focus: row });
    const off = await call('md01', '停用後 md01 呼叫');
    await s.soft('停用後呼叫被拒（非 200）', () => expect(off).not.toBe('200'));
    await row.getByRole('button', { name: '啟用', exact: true }).click();
    await expect(row.getByRole('cell', { name: '啟用', exact: true })).toBeVisible();
    await s.step(ca, '步驟 4', '已恢復啟用', { line: oneLine(await row.innerText()), focus: row });
    const on = await call('md01', '恢復啟用後 md01 呼叫');
    await s.soft('恢復啟用後呼叫成功', () => expect(on).toBe('200'));
    await row.getByRole('button', { name: '取消發布' }).click();
    await expect(row).toHaveCount(0);
    await s.step(ca, '步驟 4', '已取消發布', { focus: ca.getByRole('table', { name: '已發布的服務' }) });
    const gone = await call('md01', '取消發布後 md01 呼叫');
    await s.soft('取消發布後呼叫被拒（非 200）', () => expect(gone).not.toBe('200'));
    s.log(`要注意｜發布表單沒有問答範本欄位：${(await form.getByLabel('問答範本', { exact: true }).count()) === 0 ? '確認沒有' : '有（與文件不同）'}`);
    return `儲存生成參數、發布（授權 md01）後端點 ${endpoint}；md01 HTTP ${ok}、vw01 HTTP ${denied}、未登入 HTTP ${anon}；停用 HTTP ${off}、啟用 HTTP ${on}、取消發布 HTTP ${gone}`;
  });
});
