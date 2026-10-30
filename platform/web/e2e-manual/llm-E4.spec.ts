import { expect, test } from '@playwright/test';
import { startScenario } from './kit';
import { KB, PROJECT, llmTabLink, prep, rowOf, sideLink } from './llm-common';

// E4 發布成內部服務（程式助理）。前提：E2 的文件集、E3 存好的回答設定（回答設定是每個帳號各自一組，發布時用 ca01 自己的）。
// 畫面上沒有呼叫範例與試呼叫按鈕：鏡頭外以 md01（授權）與 vw01（未授權）的 token 實際呼叫一次，結果寫進終端機紀錄。
const SLUG = 'sop-qa';
const NAME = '院內作業規範問答';
const WEB = process.env.WEB_URL || 'http://localhost:38982';
const KC = process.env.KEYCLOAK || 'http://localhost:38180';

async function token(user: string) {
  const res = await fetch(`${KC}/realms/ai-platform/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'ai-platform-web', username: user, password: 'Dev-Passw0rd!' }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function invoke(user: string | null, question: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (user) headers.Authorization = `Bearer ${await token(user)}`;
  const res = await fetch(`${WEB}/api/llm-services/${SLUG}/invoke`, { method: 'POST', headers, body: JSON.stringify({ question }) });
  const text = await res.text();
  console.log(`[E4] ${user ?? '未登入'} 呼叫 → HTTP ${res.status} ${text.slice(0, 400)}`);
  return res.status;
}

test('E4 發布成內部服務', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  prep('e4');
  const s = await startScenario(browser, { id: 'E4', title: '發布成內部服務', role: 'ca01', manual: '05-程式助理', project: PROJECT });
  const p = s.page;
  s.section('目的', '把調好的問答（模型、參考文件、回答設定）發布成院內服務，讓其他系統用 RESTful API 呼叫，不需要寫程式。');
  s.section(
    '開始前準備',
    [
      `- 已建立參考文件集（本例「${KB}」），並在「對話 › 設定」儲存好回答設定；發布時使用你自己帳號目前的回答設定。`,
      '- 決定哪些帳號可以呼叫這個服務（授權帳號）。',
    ].join('\n'),
  );

  await s.step('按左側選單的「語言模型」', sideLink(p, '語言模型'), 'click');
  await s.step('按上方分頁「內部服務」', llmTabLink(p, '內部服務'), 'click');
  const form = p.getByRole('form', { name: '發布為內部服務' });
  await s.step(`「服務代號」輸入 ${SLUG}`, form.getByLabel('服務代號（小寫英數字與 -）', { exact: true }), { fill: SLUG }, {
    detail: '服務代號會成為呼叫網址的一部分，只能用小寫英文、數字與「-」。',
  });
  await s.step(`「名稱」輸入 ${NAME}`, form.getByLabel('名稱', { exact: true }), { fill: NAME });
  await s.step(`「參考文件」選 ${KB}`, form.getByLabel('參考文件', { exact: true }), { select: { label: KB } });
  const grants = form.getByLabel('授權帳號（以逗號分隔）', { exact: true });
  await s.step('「授權帳號」輸入帳號開頭 md', grants, { fill: 'md' });
  const pick = form.getByRole('list', { name: '符合的帳號' }).getByRole('button', { name: 'md01', exact: true });
  await expect(pick).toBeVisible({ timeout: 10_000 });
  await s.step('從清單點選 md01', pick, 'click');
  await expect(grants).toHaveValue(/md01/);
  await s.step('確認「發布內容摘要」', form.getByRole('group', { name: '發布內容摘要' }), undefined, {
    detail: '摘要列出這次會用的模型、參考文件、回答規則（System Prompt）、生成參數與授權對象。',
  });
  await s.step('按「發布」', form.getByRole('button', { name: '發布', exact: true }), 'click');
  const endpoint = `/api/llm-services/${SLUG}/invoke`;
  const ok = form.getByRole('status').filter({ hasText: `已發布「${NAME}」：POST ${endpoint}` });
  await expect(ok).toBeVisible({ timeout: 60_000 });
  await s.step('出現「已發布」與呼叫網址', ok);
  const row = rowOf(p.getByRole('table', { name: '已發布的服務' }), NAME);
  await expect(row).toContainText(endpoint);
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' })); // 避免被上方固定的頂端列擋住
  await s.step('「已發布的服務」列出端點與授權帳號', row);

  // 鏡頭外試呼叫（畫面上沒有試呼叫功能）
  const granted = await invoke('md01', '複診病人可以用什麼方式報到？');
  const denied = await invoke('vw01', '複診病人可以用什麼方式報到？');
  const anon = await invoke(null, '複診病人可以用什麼方式報到？');
  console.log(`[E4] 試呼叫結果：md01 ${granted}、vw01 ${denied}、未登入 ${anon}`);

  await s.step('不開放時按「停用」', row.getByRole('button', { name: '停用', exact: true }), 'click', {
    detail: '停用後呼叫會被拒絕；按「啟用」恢復。不再需要時按「取消發布」。',
  });
  await expect(row.getByRole('cell', { name: '停用', exact: true })).toBeVisible();
  await s.step('狀態變成「停用」', row.getByRole('cell', { name: '停用', exact: true }));
  const off = await invoke('md01', '停用後再呼叫');
  console.log(`[E4] 停用後 md01 → ${off}`);
  await s.step('要恢復時按「啟用」', row.getByRole('button', { name: '啟用', exact: true }), 'click');
  await expect(row.getByRole('cell', { name: '啟用', exact: true })).toBeVisible();
  await s.note('服務恢復「啟用」');

  s.section(
    '完成後的樣子',
    `「已發布的服務」出現「${NAME}」，端點為 POST ${endpoint}，狀態「啟用」。授權帳號可以用自己的登入憑證（Bearer token）呼叫；未授權帳號會被拒絕。`,
  );
  s.section(
    '呼叫範例（Python）',
    [
      '畫面上沒有呼叫範例，以下範例依實際端點撰寫，並已用授權帳號呼叫成功。平台網址與帳號請換成貴院環境。',
      '',
      '```python',
      'import requests',
      '',
      'PLATFORM = "https://<平台網址>"',
      'TOKEN = "<授權帳號的登入憑證（Bearer token）>"',
      '',
      'r = requests.post(',
      `    f"{PLATFORM}${endpoint}",`,
      '    headers={"Authorization": f"Bearer {TOKEN}"},',
      '    json={"question": "複診病人可以用什麼方式報到？"},',
      '    timeout=60,',
      ')',
      'r.raise_for_status()',
      'data = r.json()',
      'print(data["answer"])                         # 回答',
      'print([s["filename"] for s in data["sources"]])  # 出處文件',
      '```',
      '',
      '回應是 JSON，包含 service（服務代號）、model（模型）、answer（回答）與 sources（出處文件與段落）。',
    ].join('\n'),
  );
  s.section(
    '常見問題',
    [
      '- 呼叫回 401：沒有帶登入憑證，或憑證已過期。',
      '- 呼叫回 403「你沒有呼叫這個服務的授權」：呼叫的帳號不在「授權帳號」內。',
      '- 呼叫回 409「這個服務已停用」：服務被停用，請按「啟用」。',
      '- 發布後才改回答設定：已發布的服務不會跟著變，請「取消發布」後重新發布。',
    ].join('\n'),
  );
  await s.finish();
});
