import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { P1, note, shot } from './helpers';
import { KIT, REPO, adminTab, psql, sh, userPage } from './ops';
import { labelGroupsOf } from './r-common';

// 情境 10：稽核與安全。A-03 的 TC-A03-09、10；通用條件的 TC-SS-02～07。
// 終端機步驟照劇本執行並存檔；網頁步驟以 admin01 操作。
// 會建立後刪除：專案 KIT-A-audit（TC-SS-06）、P1 標註群組 KIT-A-g1（TC-A03-10）；
// TC-SS-07 的資料庫檢查會留下 1 筆 actor = tc-ss-07 的標記稽核（劇本說明屬正常）。
// TC-SS-03 的過期 token 需先執行 save-expired 並等 6 分鐘以上（SS03_SAVED 指定存檔位置）。

const T = (s: string) => path.join(KIT, 'tools', s);
const ok = (page: Page, text: string) => expect(page.getByRole('status').filter({ hasText: `完成：${text}` })).toBeVisible();

test('TC-SS-02 未登入不可存取（API）', async () => {
  const tc = 'TC-SS-02';
  const p1 = psql(`select id from projects where name='P1-lung-ct'`);
  const p2 = psql(`select id from projects where name='P2-tabular'`);
  const paths = `/api/me /api/admin/users /api/admin/projects /api/admin/projects/${p1}/members /api/admin/gpu-groups /api/admin/cluster/nodes /api/admin/cluster/shared-scheduling /api/projects/${p1}/imaging/studies /api/projects/${p2}/tabular/datasets /api/projects/${p1}/jobs`;
  const r = sh(tc, 'TC-SS-02', `for p in ${paths}; do echo "$(curl -s -o /dev/null -w '%{http_code}' $GATEWAY$p) $p"; done; echo; curl -s $GATEWAY/api/admin/users; echo`);
  const codes = r.out.split('\n').filter((l) => / \/api\//.test(l)).map((l) => l.split(' ')[0]);
  // 對照：同樣 10 個網址帶 admin01 的 token 都回 200
  const c = sh(
    tc,
    'TC-SS-02-對照組',
    `ADM=$(curl -s -X POST $KEYCLOAK/realms/ai-platform/protocol/openid-connect/token -d grant_type=password -d client_id=ai-platform-web -d username=admin01 --data-urlencode password='Admin01-dev!' | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p'); for p in ${paths}; do echo "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ADM" $GATEWAY$p) $p"; done`,
  );
  const ctl = c.out.split('\n').filter((l) => / \/api\//.test(l)).map((l) => l.split(' ')[0]);
  note(tc, `不帶 token 10 次：${codes.join(' ')}；未登入訊息 ${r.out.trim().split('\n').pop()}；對照組（admin01 token）：${ctl.join(' ')}`);
  expect(codes).toEqual(Array(10).fill('401'));
  expect(r.out).toContain('{"detail":"未登入"}');
  expect(ctl).toEqual(Array(10).fill('200'));
});

test('TC-SS-03 偽造與過期 token', async () => {
  const tc = 'TC-SS-03';
  const saved = process.env.SS03_SAVED || '';
  const env = `SAVED=${saved} `;
  const f = sh(tc, 'TC-SS-03', `${env}bash ${T('tc-ss-03-forged-tokens.sh')} forge`);
  const age = saved && fs.existsSync(saved) ? (Date.now() - fs.statSync(saved).mtimeMs) / 60000 : 0;
  note(tc, `過期 token 存檔距今 ${age.toFixed(1)} 分鐘`);
  expect(age).toBeGreaterThan(6);
  const e = sh(tc, 'TC-SS-03', `${env}bash ${T('tc-ss-03-forged-tokens.sh')} expired`);
  const out = `${f.out}\n${e.out}`;
  const control = /對照組.*HTTP (\d+)/.exec(out)?.[1];
  const tries = [...out.matchAll(/(錯誤簽章|別的 issuer|過期 token) 第 \d 次：HTTP (\d+)/g)];
  const success = tries.filter((m) => m[2] !== '401').length;
  note(tc, `對照組 HTTP ${control}；偽造／過期共 ${tries.length} 次，成功 ${success} 次（${tries.map((m) => `${m[1]}${m[2]}`).join('、')}）`);
  expect(control).toBe('200');
  expect(tries.length).toBe(9);
  expect(success).toBe(0);
});

test('TC-SS-04 金鑰不外洩', async ({ browser }) => {
  const tc = 'TC-SS-04';
  test.setTimeout(8 * 60_000);
  const { ctx, page } = await userPage(browser, 'admin01');
  // A-1：檢視網頁原始碼（Ctrl+U）
  const src = await ctx.newPage();
  await src.goto('view-source:http://localhost:38982/').catch(() => undefined);
  await shot(src, tc, 'A1-檢視網頁原始碼');
  const html = (await page.request.get('/')).text();
  const refs = [...(await html).matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((r) => /config\.js|\/assets\//.test(r));
  // A-2：config.js 內容
  await src.goto('http://localhost:38982/config.js');
  const cfgText = (await src.locator('body').innerText()).trim();
  await shot(src, tc, 'A2-config.js');
  const cfg = JSON.parse(cfgText.replace(/^window\.__PLATFORM_CONFIG__\s*=\s*/, '').replace(/;\s*$/, '')) as Record<string, string>;
  // A-3：全文搜尋關鍵字（DevTools 的 Ctrl+Shift+F 無法自動化，改為對頁面載入的每個檔案逐一搜尋同樣的關鍵字）
  const words = ['client_secret', 'POSTGRES_PASSWORD', 'MINIO', 'minioadmin', 'password":"'];
  const hits: string[] = [];
  for (const r of refs) {
    const body = await (await page.request.get(r)).text();
    for (const w of words) if (body.includes(w)) hits.push(`${r}:${w}`);
  }
  note(tc, `原始碼引用：${refs.join('、')}；config.js 鍵：${Object.keys(cfg).join('、')}（client ${cfg.VITE_OIDC_CLIENT_ID}）；關鍵字搜尋命中 ${hits.length} 筆`);
  await src.close();
  // B：完整比對（劇本指令）
  const b = sh(
    tc,
    'TC-SS-04',
    `mkdir -p /tmp/web-dist/assets && cd /tmp/web-dist && curl -s http://localhost:38982/ -o index.html && curl -s http://localhost:38982/config.js -o config.js && for f in $(grep -o '/assets/[^"]*' index.html); do curl -s http://localhost:38982$f -o .$f; done && cd ${REPO}/platform/compliance && uv run python -m compliance secrets --kube-namespace ai-platform --gateway $GATEWAY --keycloak $KEYCLOAK --web-dist /tmp/web-dist`,
  );
  const last = b.out.trim().split('\n').filter((l) => /TC-SS-04/.test(l)).pop() ?? '';
  note(tc, `完整比對：${last}`);
  expect(refs.length).toBe(3);
  expect(Object.keys(cfg).sort()).toEqual(['VITE_API_BASE', 'VITE_OHIF_BASE', 'VITE_OIDC_AUTHORITY', 'VITE_OIDC_CLIENT_ID']);
  expect(cfg.VITE_OIDC_CLIENT_ID).toBe('ai-platform-web');
  expect(hits).toEqual([]);
  expect(last).toMatch(/^PASS\s+TC-SS-04.*明文出現 0 次/);
  await ctx.close();
});

test('TC-SS-05 繞過 Gateway', async () => {
  const tc = 'TC-SS-05';
  test.setTimeout(10 * 60_000);
  const r = sh(tc, 'TC-SS-05', `bash ${T('tc-ss-05-bypass-gateway.sh')}`);
  const total = /合計成功 (\d+) 次/.exec(r.out)?.[1];
  const lines = r.out.split('\n').filter((l) => /次，成功/.test(l));
  const p = sh(
    tc,
    'TC-SS-05',
    `cd ${REPO}/platform/acceptance && K8S_NAMESPACE=ai-platform GATEWAY_URL=$GATEWAY KEYCLOAK_URL=$KEYCLOAK uv run pytest -q test_k8s_deploy.py -k tc_ss_05 2>&1 | tail -5`,
  );
  const summary = p.out.trim().split('\n').pop() ?? '';
  note(tc, `${lines.length} 個內部位址各 10 次，合計成功 ${total} 次；叢集內測試：${summary}`);
  expect(lines.length).toBeGreaterThanOrEqual(6);
  expect(total).toBe('0');
  expect(summary).toMatch(/3 passed/);
  expect(summary).not.toMatch(/failed|error/);
});

test('TC-SS-06 稽核紀錄格式', async ({ browser }) => {
  const tc = 'TC-SS-06';
  const { ctx, page } = await userPage(browser, 'admin01');
  await adminTab(page, '專案');
  const form = page.getByRole('form', { name: '新增專案' });
  await form.getByLabel('專案名稱（必填）').fill('KIT-A-audit');
  await form.getByRole('button', { name: '新增專案' }).click();
  await ok(page, '已新增專案「KIT-A-audit」');
  const when = new Date();
  await shot(page, tc, '01-新增專案訊息');
  const r = sh(tc, 'TC-SS-06', `kubectl -n ai-platform exec postgres-0 -- psql -U platform -d platform -x -c "select id, actor, at, category, action, target, result, source_ip from audit_log order by id desc limit 1;"`);
  const f = Object.fromEntries(
    r.out
      .split('\n')
      .filter((l) => l.includes('|'))
      .map((l) => l.split('|').map((s) => s.trim())),
  ) as Record<string, string>;
  const pid = psql(`select id from projects where name='KIT-A-audit'`);
  const at = new Date(f.at.replace(' ', 'T').replace(/\+00$/, 'Z'));
  const skew = Math.abs(at.getTime() - when.getTime()) / 1000;
  note(tc, `最新稽核：id ${f.id}、actor ${f.actor}、at ${f.at}（與操作時間差 ${skew.toFixed(1)} 秒）、category ${f.category}、action ${f.action}、target ${f.target}、result ${f.result}、source_ip ${f.source_ip}`);
  // 清理
  await page.getByRole('button', { name: '刪除 KIT-A-audit', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '確認刪除' }).click();
  await ok(page, '已刪除專案「KIT-A-audit」');
  await shot(page, tc, '02-已刪除KIT-A-audit');
  expect(f.actor).toBe('admin01');
  expect(f.category).toBe('project');
  expect(f.action).toBe('create');
  expect(f.target).toBe(`project:${pid}`);
  expect(f.result).toBe('success');
  expect(f.source_ip).toBeTruthy();
  expect(skew).toBeLessThan(10);
  await ctx.close();
});

test('TC-SS-07 稽核不可被使用者修改', async ({ browser }) => {
  const tc = 'TC-SS-07';
  const { ctx, page } = await userPage(browser, 'admin01');
  await adminTab(page, '稽核紀錄');
  await expect(page.getByText('帳號、角色、權限、專案、資料集等操作的紀錄，只能查詢，不能修改或刪除。時間以瀏覽器所在時區顯示。')).toBeVisible();
  const table = page.getByRole('table', { name: '稽核紀錄' });
  await expect(table.locator('tbody tr').first()).toBeVisible();
  const buttons = await table.getByRole('button').count();
  const editLinks = await table.getByText(/^(編輯|刪除|修改)$/).count();
  const views = await table.locator('summary', { hasText: '查看' }).count();
  await shot(page, tc, '01-稽核紀錄只有查看');
  note(tc, `稽核紀錄表格：按鈕 ${buttons} 個、編輯／刪除字樣 ${editLinks} 個、「查看」${views} 個`);
  const before = psql('select id, actor, action, target from audit_log order by id desc limit 1');
  const a = sh(
    tc,
    'TC-SS-07-api',
    `G=$GATEWAY
ADM=$(curl -s -X POST $KEYCLOAK/realms/ai-platform/protocol/openid-connect/token -d grant_type=password -d client_id=ai-platform-web -d username=admin01 --data-urlencode password='Admin01-dev!' | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')
ID=$(curl -s -H "Authorization: Bearer $ADM" "$G/api/admin/audit?page_size=1" | sed -n 's/.*"items":\\[{"id":\\([0-9]*\\).*/\\1/p')
echo "最新稽核編號 $ID"
for m in PUT PATCH DELETE; do for p in /api/admin/audit/$ID /api/admin/audit; do
  echo "$m $p $(curl -s -o /dev/null -w '%{http_code}' -X $m -H "Authorization: Bearer $ADM" -H 'Content-Type: application/json' -d '{"actor":"x"}' $G$p)"
done; done
curl -s -H "Authorization: Bearer $ADM" "$G/api/admin/audit?page_size=1" | head -c 200; echo`,
  );
  const codes = [...a.out.matchAll(/^(PUT|PATCH|DELETE) (\S+) (\d+)$/gm)].map((m) => ({ single: /\/\d+$/.test(m[2]), code: m[3] }));
  const after = psql(`select id, actor, action, target from audit_log where id = ${before.split('|')[0]}`);
  const d = sh(tc, 'TC-SS-07-db', `CTX=kind-ai-platform bash ${T('tc-ss-07-audit-db-rights.sh')}`);
  const denied = (d.out.match(/permission denied for table audit_log/g) ?? []).length;
  const account = /平台 API 的資料庫帳號：(\S+)/.exec(d.out)?.[1];
  const attrs = new RegExp(`^${account}\\|f\\|f\\|f$`, 'm').test(d.out);
  const grant = new RegExp(`${account}=ar/platform`).test(d.out);
  const tampered = d.out.trim().split('\n').pop()?.trim();
  const p = sh(
    tc,
    'TC-SS-07-pytest',
    `cd ${REPO}/platform/acceptance && K8S_NAMESPACE=ai-platform GATEWAY_URL=$GATEWAY KEYCLOAK_URL=$KEYCLOAK uv run pytest -q test_tc_ss.py -k tc_ss_07 2>&1 | tail -3`,
  );
  note(tc, `API：${codes.map((c) => c.code).join(' ')}；最後一筆稽核前後 ${before === after ? '相同' : '不同'}`);
  note(tc, `資料庫：帳號 ${account}，屬性皆 f ${attrs}，audit_log 權限 ar ${grant}，UPDATE／DELETE／TRUNCATE 被拒 ${denied}／3，竄改筆數 ${tampered}；自動化對照 ${p.out.trim().split('\n').pop()}`);
  expect(buttons).toBe(0);
  expect(editLinks).toBe(0);
  expect(codes.length).toBe(6);
  for (const c of codes) expect(c.code).toBe(c.single ? '404' : '405');
  expect(after).toBe(before);
  expect(account).not.toBe('platform');
  expect(attrs && grant).toBeTruthy();
  expect(denied).toBe(3);
  expect(tampered).toBe('0');
  await ctx.close();
});

test('TC-A03-10 Admin 標註群組與 Dashboard', async ({ browser }) => {
  const tc = 'TC-A03-10';
  const { ctx, page } = await userPage(browser, 'admin01');
  await labelGroupsOf(page, P1);
  const table = page.getByRole('table', { name: '標註群組列表' });
  await page.waitForLoadState('networkidle');
  expect(await table.getByRole('rowheader', { name: 'KIT-A-g1', exact: true }).count()).toBe(0);
  const form = page.getByRole('form', { name: '新增標註群組' });
  await form.getByLabel('群組名稱（必填）').fill('KIT-A-g1');
  await form.getByLabel('說明').fill('驗收示範標註群組');
  await form.getByRole('checkbox', { name: 'md01（Medical Doctor）', exact: true }).check();
  await form.getByRole('checkbox', { name: 'ra01（Research Assistant）', exact: true }).check();
  await shot(page, tc, '01-專案頁標註群組-新增表單');
  await form.getByRole('button', { name: '新增群組' }).click();
  await ok(page, '已新增標註群組「KIT-A-g1」');
  const row = (await table.locator('tbody tr').filter({ has: page.getByRole('rowheader', { name: 'KIT-A-g1', exact: true }) }).locator('th, td').allInnerTexts()).map((s) => s.trim());
  await shot(page, tc, '02-專案頁標註群組-已建立');
  note(tc, `標註群組列：${row.slice(0, 3).join('｜')}`);
  // Dashboard 總覽
  await adminTab(page, 'Dashboard 總覽');
  await page.getByRole('button', { name: '重新整理' }).click();
  await page.waitForLoadState('networkidle');
  const tiles = async (name: string) =>
    Object.fromEntries(
      await Promise.all(
        (await page.getByRole('list', { name }).locator(':scope > li').all()).map(async (li) => [
          (await li.locator('.stat-tile__label').innerText()).trim(),
          `${(await li.locator('.stat-tile__value').innerText()).trim()}${(await li.locator('.text-muted').count()) ? `（${(await li.locator('.text-muted').innerText()).trim()}）` : ''}`,
        ]),
      ),
    ) as Record<string, string>;
  const web = await tiles('平台總覽');
  const status = await tiles('排程工作狀態');
  await shot(page, tc, '03-管理區總覽');
  const db = sh(
    tc,
    'TC-A03-10-db',
    `kubectl -n ai-platform exec postgres-0 -- psql -U platform -d platform -c "select (select count(*) from users) as 帳號, (select count(*) from users where account_type='admin') as admin, (select count(*) from projects) as 專案, (select count(*) from memberships) as 專案成員, (select count(*) from label_groups) as 標註群組, (select count(*) from label_group_members) as 群組成員, (select count(*) from tabular_datasets) as 結構式資料集, (select count(*) from imaging_studies) as 影像研究, (select count(*) from gpu_groups) as gpu群組, (select count(*) from jobs) as 排程工作;" -c "select status, count(*) from jobs group by status order by 1;"`,
  );
  const n = psql(
    `select (select count(*) from users), (select count(*) from users where account_type='admin'), (select count(*) from projects), (select count(*) from memberships), (select count(*) from label_groups), (select count(*) from label_group_members), (select count(*) from tabular_datasets), (select count(*) from imaging_studies), (select count(*) from gpu_groups), (select count(*) from jobs)`,
  ).split('|');
  const byStatus = Object.fromEntries(psql('select status, count(*) from jobs group by status').split('\n').map((l) => l.split('|')));
  const LABEL: Record<string, string> = { queued: '排隊中', running: '執行中', succeeded: '已完成', failed: '失敗', cancelled: '已取消' };
  const pairs: [string, string, string][] = [
    ['帳號', web['帳號'], `${n[0]}（Admin ${n[1]}、User ${Number(n[0]) - Number(n[1])}）`],
    ['專案', web['專案'], n[2]],
    ['專案成員', web['專案成員'], `${n[3]}（帳號加入專案的次數）`],
    ['標註群組', web['標註群組'], `${n[4]}（群組成員 ${n[5]}）`],
    ['結構式資料集', web['結構式資料集'], n[6]],
    ['影像研究', web['影像研究'], n[7]],
    ['GPU 群組', web['GPU 群組'], n[8]],
    ['排程工作', web['排程工作'], n[9]],
    ...Object.entries(LABEL).map(([k, v]) => [v, status[v] ?? '0', byStatus[k] ?? '0'] as [string, string, string]),
  ];
  const diff = pairs.filter(([, a, b]) => a !== b);
  sh(tc, 'TC-A03-10-對照表', `cat <<'EOF'\n項目｜Dashboard｜資料庫\n${pairs.map((p) => p.join('｜')).join('\n')}\nEOF`);
  note(tc, `Dashboard 與資料庫 ${pairs.length} 項，差異 ${diff.length}${diff.length ? `：${JSON.stringify(diff)}` : ''}；資料庫輸出存於 TC-A03-10-db.txt（${db.code === 0 ? '成功' : '失敗'}）`);
  // Account 帳號
  await adminTab(page, 'Account 帳號');
  await expect(page.getByRole('table', { name: '帳號列表' }).getByRole('rowheader', { name: 'admin01', exact: true })).toBeVisible();
  const accounts = (await page.getByRole('table', { name: '帳號列表' }).locator('tbody tr').all()).length;
  await shot(page, tc, '04-管理區帳號');
  note(tc, `Account 帳號頁列出 ${accounts} 個帳號`);
  // 清理
  await labelGroupsOf(page, P1);
  await page.getByRole('button', { name: '刪除 KIT-A-g1', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('確定要刪除標註群組「KIT-A-g1」嗎？成員仍留在專案中，只是不再屬於這個群組。');
  await dlg.getByRole('button', { name: '確認刪除' }).click();
  await ok(page, '已刪除標註群組「KIT-A-g1」');
  await shot(page, tc, '05-已刪除KIT-A-g1');
  expect(row.slice(0, 3)).toEqual(['KIT-A-g1', '驗收示範標註群組', 'md01、ra01']);
  expect(diff).toEqual([]);
  expect(accounts).toBe(Number(n[0]));
  await ctx.close();
});

test('TC-A03-09 稽核抽查（4 類各 5 筆與資料庫逐欄比對）', async ({ browser }) => {
  const tc = 'TC-A03-09';
  const { ctx, page } = await userPage(browser, 'admin01');
  await adminTab(page, '稽核紀錄');
  await expect(page.getByText('帳號、角色、權限、專案、資料集等操作的紀錄，只能查詢，不能修改或刪除。時間以瀏覽器所在時區顯示。')).toBeVisible();
  // 開始時間：本輪驗收（情境 1 起）第一筆稽核的當天 00:00（瀏覽器時區 Asia/Taipei）
  const first = psql(`select to_char(min(at) at time zone 'Asia/Taipei', 'YYYY-MM-DD') from audit_log where actor='admin01'`);
  const since = `${first}T00:00`;
  note(tc, `篩選：操作者 admin01，開始時間 ${since}（本輪驗收第一筆稽核的當天）`);
  const form = page.getByRole('form', { name: '篩選稽核紀錄' });
  const CATS: [string, string][] = [
    ['account', '帳號（account）'],
    ['role', '角色（role）'],
    ['permission', '權限（permission）'],
    ['project', '專案（project）'],
  ];
  const RESULT: Record<string, string> = { success: '成功', failed: '失敗', failure: '失敗', denied: '拒絕存取' };
  const LABEL: Record<string, string> = { account: '帳號', role: '角色', permission: '權限', project: '專案', dataset: '資料集' };
  const picked: string[][] = [];
  const totals: string[] = [];
  for (const [i, [cat, label]] of [...CATS, ['dataset', '資料集（dataset）'] as [string, string]].entries()) {
    await form.getByLabel('類別').selectOption({ label });
    await form.getByLabel('操作者').fill(cat === 'dataset' ? '' : 'admin01');
    await form.getByLabel('開始時間').fill(since);
    await form.getByRole('button', { name: '查詢' }).click();
    await page.waitForLoadState('networkidle');
    const st = page.getByRole('status').filter({ hasText: /^共 \d+ 筆/ });
    await expect(st).toBeVisible();
    totals.push(`${LABEL[cat]} ${(await st.innerText()).trim()}`);
    await shot(page, tc, `0${i + 1}-篩選-${LABEL[cat]}`);
    const rows = await page.getByRole('table', { name: '稽核紀錄' }).locator('tbody tr').all();
    for (const r of rows.slice(0, 5)) picked.push((await r.locator('th, td').allInnerTexts()).map((s) => s.trim()));
  }
  // 任選 1 筆按「查看」展開內容
  await form.getByLabel('類別').selectOption({ label: '專案（project）' });
  await form.getByLabel('操作者').fill('admin01');
  await form.getByRole('button', { name: '查詢' }).click();
  await page.waitForLoadState('networkidle');
  const sum = page.getByRole('table', { name: '稽核紀錄' }).locator('summary', { hasText: '查看' }).first();
  await sum.click();
  const detail = (await sum.locator('xpath=..').locator('pre').innerText()).trim();
  await shot(page, tc, '06-查看內容');
  note(tc, `「查看」內容：${detail.replace(/\s+/g, ' ').slice(0, 160)}`);
  // 對照資料庫
  const ids = picked.map((r) => r[0]);
  const out = sh(
    tc,
    'TC-A03-09-audit',
    `kubectl -n ai-platform exec postgres-0 -- psql -U platform -d platform -tA -F'|' -c "select id, actor, at, category, action, target, result, source_ip from audit_log where id in (${ids.join(',')}) order by category, id desc;"`,
  ).out;
  const dbRows = Object.fromEntries(out.trim().split('\n').filter(Boolean).map((l) => [l.split('|')[0], l.split('|')]));
  // 頁面時間＝瀏覽器時區（Asia/Taipei，UTC+8）顯示到秒；換回 UTC 與資料庫比對到秒
  const uiMs = (t: string) => {
    const m = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)$/.exec(t);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]) : NaN;
  };
  const dbMs = (at: string) => Math.floor(new Date(at.replace(' ', 'T').replace(/\+00$/, 'Z')).getTime() / 1000) * 1000;
  const lines = ['編號｜時間｜操作者｜類別｜動作｜對象｜結果｜來源｜一致'];
  let missing = 0;
  let mismatch = 0;
  for (const r of picked) {
    const d = dbRows[r[0]];
    if (!d) {
      missing++;
      lines.push(`${r.slice(0, 8).join('｜')}｜資料庫查無`);
      continue;
    }
    const [, actor, at, cat, action, target, result, ip] = d;
    const src = ip.startsWith('local:') ? r[7].includes(ip) : r[7] === ip;
    const same = uiMs(r[1]) === dbMs(at) && r[2] === actor && r[3] === LABEL[cat] && r[4] === action && r[5] === target && r[6] === (RESULT[result] ?? result) && src;
    if (!same) mismatch++;
    lines.push(`${r.slice(0, 8).join('｜')}｜${same ? '一致' : `不一致（資料庫 ${d.join('|')}）`}`);
  }
  sh(tc, 'TC-A03-09-紀錄表', `cat <<'EOF'\n${lines.join('\n')}\nEOF`);
  const main = picked.filter((r) => ['帳號', '角色', '權限', '專案'].includes(r[3]));
  const empty = picked.filter((r) => r.slice(0, 8).some((c) => !c)).length;
  note(tc, `${totals.join('；')}`);
  note(tc, `抽查 ${picked.length} 筆（4 類 ${main.length} 筆＋資料集 ${picked.length - main.length} 筆），缺漏 ${missing}、不一致 ${mismatch}、空白欄 ${empty}`);
  expect(main.length).toBe(20);
  expect(missing).toBe(0);
  expect(mismatch).toBe(0);
  expect(empty).toBe(0);
  await ctx.close();
});
