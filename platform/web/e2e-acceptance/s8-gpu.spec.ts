import { expect, test, type Page } from '@playwright/test';
import { P1, note, shot } from './helpers';
import {
  adminTab,
  gotoJobs,
  jobCells,
  jobRow,
  jobStatus,
  psql,
  q,
  schedulingTab,
  sh,
  submitJob,
  userPage,
  waitIdle,
} from './ops';

// 情境 8：GPU 資源與訓練工作。C-01 的 TC-C01-01～06、08，A-02 的 TC-A02-05～07。
// 不做 TC-C01-07（新增節點）、TC-C01-09（甲方環境）。
// 會建立 GPU 群組 KIT-C-high／KIT-C-low、專案 KIT-C-p1～p3 並加入 ra01／ca01／pi01，最後一個案例全部刪除；
// TC-A02-07 改共享排程設定 3 次，第 3 次即還原為 4 份／60 分鐘（失敗時 finally 仍會還原）。


const GROUPS = [
  { name: 'KIT-C-high', pool: '獨占池（gpu-exclusive）', count: '2' },
  { name: 'KIT-C-low', pool: '共享池（gpu-shared）', count: '1' },
];
const PROJECTS = [
  { name: 'KIT-C-p1', group: 'KIT-C-high', option: 'KIT-C-high（獨占，2 張）', queue: 'gpu-exclusive', user: 'ra01', role: 'Research Assistant' },
  { name: 'KIT-C-p2', group: 'KIT-C-low', option: 'KIT-C-low（共享，1 張）', queue: 'gpu-shared', user: 'ca01', role: 'Coder Assistant' },
  { name: 'KIT-C-p3', group: 'KIT-C-high', option: 'KIT-C-high（獨占，2 張）', queue: 'gpu-exclusive', user: 'pi01', role: 'Principal Investigator' },
];

const ok = (page: Page, text: string) => expect(page.getByRole('status').filter({ hasText: `完成：${text}` })).toBeVisible();

/** 依「驗收後清除」：移除成員 → 刪專案 → 刪 GPU 群組（只處理存在的） */
async function cleanupKitC(page: Page, tc: string) {
  await adminTab(page, '專案成員');
  for (const p of PROJECTS) {
    const sel = page.locator('#member-project');
    if ((await sel.locator('option', { hasText: new RegExp(`^${p.name}$`) }).count()) === 0) continue;
    await sel.selectOption({ label: p.name });
    const btn = page.getByRole('button', { name: `移除 ${p.user}`, exact: true });
    await page.waitForLoadState('networkidle');
    if (await btn.count()) {
      await btn.click();
      await page.getByRole('dialog').getByRole('button', { name: '確認移除' }).click();
      await ok(page, `已將「${p.user}」移出「${p.name}」`);
      note(tc, `已將 ${p.user} 移出 ${p.name}`);
    }
  }
  await adminTab(page, '專案');
  await page.waitForLoadState('networkidle');
  for (const p of PROJECTS) {
    const btn = page.getByRole('button', { name: `刪除 ${p.name}`, exact: true });
    if (await btn.count()) {
      await btn.click();
      await page.getByRole('dialog').getByRole('button', { name: '確認刪除' }).click();
      await ok(page, `已刪除專案「${p.name}」`);
      note(tc, `已刪除專案 ${p.name}`);
    }
  }
  await schedulingTab(page, 'GPU 群組');
  await page.waitForLoadState('networkidle');
  for (const g of GROUPS) {
    const btn = page.getByRole('button', { name: `刪除 ${g.name}`, exact: true });
    if (await btn.count()) {
      await btn.click();
      await page.getByRole('dialog').getByRole('button', { name: '確認刪除' }).click();
      await ok(page, `已刪除 GPU 群組「${g.name}」`);
      note(tc, `已刪除 GPU 群組 ${g.name}`);
    }
  }
}

async function tableRows(page: Page, name: string) {
  const rows = page.getByRole('table', { name }).locator('tbody tr');
  const out: string[][] = [];
  for (const r of await rows.all()) out.push((await r.locator('th, td').allInnerTexts()).map((s) => s.trim()));
  return out;
}

/** 從資料庫讀工作時間（UTC 毫秒），只做順序判斷用；畫面時間另截圖 */
function jobTimes(ids: number[]) {
  const rows = psql(
    `select id, status, extract(epoch from created_at)*1000, coalesce(extract(epoch from started_at)*1000,0), coalesce(extract(epoch from finished_at)*1000,0), message from jobs where id in (${ids.join(',')}) order by id`,
  );
  return Object.fromEntries(
    rows.split('\n').filter(Boolean).map((l) => {
      const [id, status, c, s, f, msg] = l.split('|');
      return [Number(id), { status, created: Number(c), started: Number(s), finished: Number(f), message: msg }];
    }),
  );
}

test('TC-C01-01 節點納管', async ({ browser }) => {
  const tc = 'TC-C01-01';
  const { ctx, page } = await userPage(browser, 'admin01');
  await schedulingTab(page, '叢集節點');
  const tiles = page.getByRole('list', { name: '叢集摘要' }).locator('li');
  await expect(tiles).toHaveCount(4);
  const tileText = (await tiles.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  await shot(page, tc, '01-叢集節點');
  const web = await tableRows(page, '叢集節點列表');
  const cols = String.raw`-o custom-columns='節點:.metadata.name,池:.metadata.labels.platform/pool,就緒:.status.conditions[?(@.type=="Ready")].status,GPU份數:.status.capacity.nvidia\.com/gpu,實體GPU:.metadata.labels.platform/gpu-physical'`;
  let k = sh(tc, 'C01-01-kubectl', `kubectl get nodes -L platform/pool ${cols}`);
  if (k.code !== 0) {
    // 劇本原指令在目前的 kubectl 版本會報「--label-columns option cannot be used with custom-columns」，去掉 -L（池已在自訂欄位內）
    note(tc, `劇本原指令失敗：${k.out.trim().split('\n')[0].slice(0, 90)}…；改用不含 -L 的同一指令`);
    k = sh(tc, 'C01-01-kubectl', `kubectl get nodes ${cols}`);
  }
  const kube = k.out.trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/));
  const num = (s: string) => (s === '<none>' ? 0 : Number(s));
  const lines: string[] = ['節點｜網頁(池/狀態/實體/份數)｜kubectl(池/就緒/實體/份數)｜一致'];
  let diff = Math.abs(web.length - kube.length);
  for (const [name, pool, ready, cap, phys] of kube) {
    const w = web.find((r) => r[0] === name);
    const same =
      !!w &&
      (w[1] === '—' ? pool === '<none>' : w[1] === pool) &&
      (w[3] === '就緒') === (ready === 'True') &&
      Number(w[4]) === num(phys) &&
      Number(w[5]) === num(cap);
    if (!same) diff++;
    lines.push(`${name}｜${w ? `${w[1]}/${w[3]}/${w[4]}/${w[5]}` : '（網頁沒有）'}｜${pool}/${ready}/${phys}/${cap}｜${same ? '一致' : '不一致'}`);
  }
  sh(tc, 'C01-01-比對表', `cat <<'EOF'\n${lines.join('\n')}\nEOF`);
  note(tc, `數字卡：${tileText.join('、')}；表格 ${web.length} 列、kubectl ${kube.length} 個節點，差異 ${diff}`);
  expect(tileText).toEqual(['節點數 5', '就緒節點 5', '實體 GPU 3', '可排程 GPU 份數 6']);
  expect(diff).toBe(0);
  await ctx.close();
});

test('TC-C01-02 GPU 群組（新增 2 個、重新載入一致）', async ({ browser }) => {
  const tc = 'TC-C01-02';
  const { ctx, page } = await userPage(browser, 'admin01');
  await cleanupKitC(page, tc); // 上次中斷的殘留
  await schedulingTab(page, 'GPU 群組');
  const form = page.getByRole('form', { name: '新增 GPU 群組' });
  for (const [i, g] of GROUPS.entries()) {
    await form.getByLabel('群組名稱（必填）').fill(g.name);
    await form.getByLabel('GPU 池').selectOption({ label: g.pool });
    await form.getByLabel('GPU 數量').fill(g.count);
    await form.getByRole('button', { name: '新增群組' }).click();
    await ok(page, `已新增 GPU 群組「${g.name}」`);
    await shot(page, tc, `0${i + 1}-新增${g.name}訊息`);
  }
  await page.reload();
  await expect(page.getByRole('table', { name: 'GPU 群組列表' }).getByRole('rowheader', { name: 'KIT-C-low', exact: true })).toBeVisible();
  const rows = (await tableRows(page, 'GPU 群組列表')).map((r) => r.slice(0, 5).join('｜'));
  await shot(page, tc, '03-重新載入後群組列表');
  const want = [
    'gpu-exclusive｜gpu-exclusive｜獨占｜2｜gpu-exclusive',
    'gpu-shared｜gpu-shared｜共享（時間片）｜1｜gpu-shared',
    'KIT-C-high｜gpu-exclusive｜獨占｜2｜gpu-exclusive',
    'KIT-C-low｜gpu-shared｜共享（時間片）｜1｜gpu-shared',
  ];
  const api = sh(
    tc,
    'C01-02-api',
    String.raw`TOKEN=$(curl -s $KEYCLOAK/realms/ai-platform/protocol/openid-connect/token -d grant_type=password -d client_id=ai-platform-web -d username=admin01 --data-urlencode 'password=Admin01-dev!' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'); curl -s -H "Authorization: Bearer $TOKEN" $GATEWAY/api/admin/gpu-groups | python3 -m json.tool`,
  );
  const json = JSON.parse(api.out) as { name: string; pool: string; gpu_count: number; mode: string; queue: string }[];
  const MODE: Record<string, string> = { exclusive: '獨占', shared: '共享（時間片）' };
  const apiRows = json.map((g) => `${g.name}｜${g.pool}｜${MODE[g.mode]}｜${g.gpu_count}｜${g.queue}`);
  note(tc, `重新載入後列表：${rows.join('；')}`);
  note(tc, `API 與畫面一致：${JSON.stringify(apiRows) === JSON.stringify(rows)}`);
  expect(rows).toEqual(want);
  expect(apiRows).toEqual(rows);
  await ctx.close();
});

test('TC-C01-03 專案綁定群組（3 個專案、工作進入群組佇列）', async ({ browser }) => {
  const tc = 'TC-C01-03';
  test.setTimeout(6 * 60_000);
  const { ctx, page } = await userPage(browser, 'admin01');
  await waitIdle(page);
  await adminTab(page, '專案');
  const form = page.getByRole('form', { name: '新增專案' });
  for (const p of PROJECTS) {
    await form.getByLabel('專案名稱（必填）').fill(p.name);
    await form.getByLabel('說明').fill('M1 驗收：C-01 專案綁定群組');
    await form.getByLabel('GPU 群組').selectOption({ label: p.option });
    await form.getByRole('button', { name: '新增專案' }).click();
    await ok(page, `已新增專案「${p.name}」`);
  }
  await page.reload();
  const list = await tableRows(page, '專案列表');
  await shot(page, tc, '01-專案與GPU群組');
  let bindDiff = 0;
  for (const p of PROJECTS) {
    const r = list.find((x) => x[0] === p.name);
    note(tc, `專案列表 ${p.name} → GPU 群組 ${r?.[2]}`);
    if (r?.[2] !== p.group) bindDiff++;
  }
  const jobs: { p: (typeof PROJECTS)[number]; id: number; queue: string }[] = [];
  for (const [i, p] of PROJECTS.entries()) {
    await gotoJobs(page, p.name);
    const j = await submitJob(page, { seconds: 60 });
    await expect(jobRow(page, j.id)).toBeVisible();
    const c = await jobCells(page, j.id);
    await shot(page, tc, `0${i + 2}-${p.name}-專案工作`);
    note(tc, `${p.name}：「${j.text}」；列表 GPU 群組 ${c.group}、佇列 ${c.queue}`);
    if (j.queue !== p.queue || c.group !== p.group || c.queue !== p.queue) bindDiff++;
    jobs.push({ p, id: j.id, queue: j.queue });
  }
  // 劇本步驟 10：Kubernetes Job 與 Kueue Workload（等 Workload 放行）
  for (let i = 0; i < 10; i++) {
    const admitted = q(String.raw`kubectl -n platform-jobs get workloads -o jsonpath='{range .items[*]}{.status.admission.clusterQueue}{"\n"}{end}' | grep -c .`);
    if (Number(admitted) >= 3) break;
    await page.waitForTimeout(2000);
  }
  sh(tc, 'C01-03-jobs', `kubectl -n platform-jobs get jobs -L kueue.x-k8s.io/queue-name,platform/project-id,platform/job-id,platform/user --sort-by=.metadata.creationTimestamp | tail -3`);
  sh(tc, 'C01-03-workloads', `kubectl -n platform-jobs get workloads -o custom-columns='WORKLOAD:.metadata.name,佇列:.spec.queueName,放行至:.status.admission.clusterQueue,JOB:.metadata.ownerReferences[0].name' | tail -3`);
  for (const j of jobs) {
    const name = q(`kubectl -n platform-jobs get jobs -l platform/job-id=${j.id} -o jsonpath='{.items[0].metadata.name}'`);
    const queue = q(String.raw`kubectl -n platform-jobs get jobs -l platform/job-id=${j.id} -o jsonpath='{.items[0].metadata.labels.kueue\.x-k8s\.io/queue-name}'`);
    const wl = q(
      String.raw`kubectl -n platform-jobs get workloads -o jsonpath='{range .items[*]}{.metadata.ownerReferences[0].name} {.spec.queueName} {.status.admission.clusterQueue}{"\n"}{end}' | grep "^${name} "`,
    ).split(' ');
    const same = queue === j.p.queue && wl[1] === j.p.queue && wl[2] === j.p.queue;
    if (!same) bindDiff++;
    note(tc, `工作 ${j.id}（${j.p.name}）Job ${name} 佇列 ${queue}；Workload 佇列 ${wl[1]}、放行至 ${wl[2]}：${same ? '一致' : '不一致'}`);
  }
  note(tc, `3 次綁定差異 ${bindDiff}`);
  expect(bindDiff).toBe(0);
  await ctx.close();
});

test('TC-C01-04 GPU Dashboard（3 個帳號各送 1 件）', async ({ browser }) => {
  const tc = 'TC-C01-04';
  test.setTimeout(10 * 60_000);
  const admin = await userPage(browser, 'admin01');
  await waitIdle(admin.page);
  // 前置：把 ra01／ca01／pi01 加入 3 個專案
  await adminTab(admin.page, '專案成員');
  for (const p of PROJECTS) {
    await admin.page.locator('#member-project').selectOption({ label: p.name });
    await admin.page.waitForLoadState('networkidle');
    const f = admin.page.getByRole('form', { name: '設定專案成員' });
    await f.getByLabel('帳號').selectOption({ label: p.user });
    await f.getByLabel('角色').selectOption({ label: p.role });
    await f.getByRole('button', { name: '加入專案' }).click();
    await ok(admin.page, `已將「${p.user}」設定為「${p.name}」的 ${p.role}`);
    note(tc, (await admin.page.getByRole('status').filter({ hasText: '已將' }).innerText()).trim());
  }
  await shot(admin.page, tc, '00-加入成員');
  const users = await Promise.all(PROJECTS.map((p) => userPage(browser, p.user)));
  const ids: Record<string, number> = {};
  for (const [i, p] of PROJECTS.entries()) {
    const pg = users[i].page;
    await gotoJobs(pg, p.name);
    const j = await submitJob(pg, { seconds: 150 });
    ids[p.user] = j.id;
    await shot(pg, tc, `00-${p.user}送出工作`);
    note(tc, `${p.user}／${p.name}：${j.text}`);
  }
  await schedulingTab(admin.page, 'GPU Dashboard');
  const table = admin.page.getByRole('table', { name: '執行中的 GPU 工作' });
  await expect(async () => {
    await admin.page.reload();
    await expect(table.locator('tbody tr')).toHaveCount(3, { timeout: 6000 });
  }).toPass({ timeout: 90_000 });
  await admin.page.waitForTimeout(5500); // 等一次自動更新
  const rows = await tableRows(admin.page, '執行中的 GPU 工作');
  const cards = (await admin.page.getByRole('list', { name: 'GPU 使用狀況' }).locator(':scope > li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  await shot(admin.page, tc, '01-GPU-Dashboard-3件');
  const k = sh(
    tc,
    'C01-04-pods',
    `kubectl -n platform-jobs get pods -l platform/user --field-selector=status.phase=Running -o custom-columns='POD:.metadata.name,節點:.spec.nodeName,PROJECT:.metadata.labels.platform/project-id,JOB:.metadata.labels.platform/job-id,TRAINING:.metadata.labels.platform/training-id,使用者:.metadata.labels.platform/user'`,
  );
  const pods = k.out.trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/));
  let diff = 0;
  for (const r of rows) {
    // r: 節點, GPU 編號, 時間片, 專案, Project ID, Job ID, Training ID, 使用者, Kubernetes Job
    const pod = pods.find((x) => x[3] === r[5]);
    const same = !!pod && pod[1] === r[0] && pod[2] === r[4] && pod[4] === r[6] && pod[5] === r[7];
    if (!same) diff++;
    note(tc, `Dashboard：${r.slice(0, 8).join('｜')}；Pod：${pod ? pod.slice(1).join('｜') : '（無）'}；${same ? '一致' : '不一致'}`);
  }
  for (const p of PROJECTS) if (!rows.some((r) => r[3] === p.name && r[7] === p.user && Number(r[5]) === ids[p.user])) diff++;
  note(tc, `GPU 卡：${cards.join('；')}`);
  note(tc, `抽查 3 組，差異 ${diff}`);
  expect(rows.length).toBe(3);
  expect(diff).toBe(0);
  for (const u of users) await u.ctx.close();
  await admin.ctx.close();
});

test('TC-C01-05 佇列排程（同時送 3 件）', async ({ browser }) => {
  const tc = 'TC-C01-05';
  test.setTimeout(10 * 60_000);
  const { ctx, page } = await userPage(browser, 'admin01');
  await waitIdle(page, 300);
  await gotoJobs(page, 'KIT-C-p1');
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push((await submitJob(page, { seconds: 30 })).id);
    await page.waitForTimeout(500);
  }
  // 步驟 4：前 2 件執行中、第 3 件排隊中
  let snap = '';
  for (let i = 0; i < 20; i++) {
    const s = await Promise.all(ids.map((id) => jobStatus(page, id)));
    snap = s.join(',');
    if (snap === 'running,running,queued') break;
    await page.waitForTimeout(500);
  }
  await shot(page, tc, '01-第3件排隊中');
  note(tc, `送出工作 ${ids.join('、')}；立即畫面狀態 ${snap}`);
  await expect(async () => {
    expect(await Promise.all(ids.map((id) => jobStatus(page, id)))).toEqual(['succeeded', 'succeeded', 'succeeded']);
  }).toPass({ timeout: 180_000, intervals: [3000] });
  await page.waitForTimeout(1000);
  await shot(page, tc, '02-3件依序完成');
  for (const id of ids) {
    const c = await jobCells(page, id);
    note(tc, `畫面 ${c.jid}｜${c.status}｜建立 ${c.created}｜開始 ${c.started}｜結束 ${c.finished}｜訊息 ${c.message}`);
  }
  const sel = ids.join(',');
  sh(
    tc,
    'C01-05-order',
    `kubectl -n platform-jobs get pods -l 'platform/job-id in (${sel})' --sort-by=.metadata.creationTimestamp -o custom-columns='JOB:.metadata.labels.platform/job-id,節點:.spec.nodeName,容器開始:.status.containerStatuses[0].state.terminated.startedAt,狀態:.status.phase'; kubectl -n platform-jobs get jobs -l 'platform/job-id in (${sel})' -o custom-columns='JOB:.metadata.name,完成:.status.completionTime'`,
  );
  const t = jobTimes(ids);
  const order = t[ids[0]].started <= t[ids[1]].started && t[ids[1]].started <= t[ids[2]].started;
  const third = t[ids[2]].started >= Math.min(t[ids[0]].finished, t[ids[1]].finished) - 1000;
  const lost = ids.filter((id) => t[id]?.status !== 'succeeded').length;
  note(tc, `開始時間依送出順序：${order}；第 3 件在前面一件結束後才開始：${third}；順序不符 ${order ? 0 : 1}、遺失 ${lost}`);
  expect(snap).toBe('running,running,queued');
  expect(order && third).toBeTruthy();
  expect(lost).toBe(0);
  await ctx.close();
});

test('TC-C01-06 負載平衡（網頁與資料清洗分散）', async ({ browser }) => {
  const tc = 'TC-C01-06';
  test.setTimeout(5 * 60_000);
  const web = sh(
    tc,
    'C01-06-web',
    `for i in 1 2 3 4 5; do p=$(kubectl get --raw /api/v1/namespaces/platform-web/services/web-echo:80/proxy/); echo "$i $p $(kubectl -n platform-web get pod $p -o jsonpath='{.spec.nodeName}')"; done; kubectl get nodes -L platform/pool`,
  );
  const webLines = web.out.split('\n').filter((l) => /^[1-5] /.test(l));
  const webOnWorker = webLines.filter((l) => l.trim().endsWith(' ai-platform-worker')).length;
  const webPods = new Set(webLines.map((l) => l.split(' ')[1])).size;
  const plat = sh(tc, 'C01-06-platform-pods', 'kubectl -n ai-platform get pods -o wide');
  const platNodes = Object.fromEntries(
    plat.out
      .split('\n')
      .filter((l) => /^(web|apisix|api)-/.test(l))
      .map((l) => [l.split(/\s+/)[0], /\b(ai-platform-[a-z0-9-]+)\b/.exec(l)?.[1] ?? '']),
  );
  const { ctx, page } = await userPage(browser, 'admin01');
  await gotoJobs(page, 'KIT-C-p1');
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) ids.push((await submitJob(page, { kind: '資料清洗（CPU）', seconds: 5 })).id);
  await page.waitForTimeout(20_000);
  await expect(async () => {
    await page.getByRole('button', { name: '重新整理' }).click();
    expect(await Promise.all(ids.map((id) => jobStatus(page, id)))).toEqual(Array(5).fill('succeeded'));
  }).toPass({ timeout: 90_000, intervals: [5000] });
  await shot(page, tc, '01-資料清洗5件');
  let rowsOk = 0;
  for (const id of ids) {
    const c = await jobCells(page, id);
    if (c.kind === '資料清洗（CPU）' && c.group === '—' && c.queue === 'cpu-data' && c.status === '已完成') rowsOk++;
  }
  const d = sh(tc, 'C01-06-data', `kubectl -n platform-jobs get pods -l 'platform/job-id in (${ids.join(',')})' -o custom-columns='JOB:.metadata.labels.platform/job-id,節點:.spec.nodeName,狀態:.status.phase'`);
  const dataOk = d.out.split('\n').filter((l) => /ai-platform-worker2\s+Succeeded/.test(l)).length;
  note(tc, `網頁請求 5 次：${webOnWorker} 次在 ai-platform-worker（cpu-web），分散在 ${webPods} 個 web-echo Pod`);
  note(tc, `平台 Pod 所在節點：${Object.entries(platNodes).map(([k, v]) => `${k}→${v}`).join('、')}`);
  note(tc, `資料清洗 ${ids.join('、')}：畫面 GPU 群組 —／佇列 cpu-data／已完成 ${rowsOk}／5；叢集在 ai-platform-worker2 且 Succeeded ${dataOk}／5`);
  expect(webOnWorker).toBe(5);
  expect(Object.values(platNodes).every((n) => n === 'ai-platform-worker')).toBeTruthy();
  expect(rowsOk).toBe(5);
  expect(dataOk).toBe(5);
  await ctx.close();
});

test('TC-C01-08 工作取消與失敗（佇列不卡住）', async ({ browser }) => {
  const tc = 'TC-C01-08';
  test.setTimeout(10 * 60_000);
  const { ctx, page } = await userPage(browser, 'admin01');
  await waitIdle(page, 300);
  await gotoJobs(page, 'KIT-C-p1');
  const A = (await submitJob(page, { seconds: 90 })).id;
  const B = (await submitJob(page, { seconds: 30, fail: true })).id;
  const C = (await submitJob(page, { seconds: 10 })).id;
  const D = (await submitJob(page, { seconds: 10 })).id;
  note(tc, `A=${A}（90 秒）、B=${B}（30 秒、失敗）、C=${C}、D=${D}（10 秒）`);
  await expect.poll(async () => [await jobStatus(page, C), await jobStatus(page, D)].join(','), { timeout: 15_000 }).toBe('queued,queued');
  await page.getByRole('button', { name: `取消工作 ${C}`, exact: true }).click();
  const dlg = page.getByRole('dialog', { name: '取消工作' });
  await expect(dlg).toContainText(`確定要取消工作 ${C}（排隊中）嗎？取消後無法恢復。`);
  await expect(dlg.getByRole('button', { name: '不要取消' })).toBeVisible();
  await shot(page, tc, '01a-取消確認對話框');
  await dlg.getByRole('button', { name: '確定取消工作' }).click();
  await ok(page, `已取消工作 ${C}`);
  await expect.poll(() => jobStatus(page, C)).toBe('cancelled');
  await shot(page, tc, '01-取消確認');
  await expect.poll(() => jobStatus(page, A), { timeout: 200_000, intervals: [3000] }).toBe('succeeded');
  await page.waitForTimeout(2500);
  await shot(page, tc, '02-取消與失敗後下一件完成');
  for (const id of [D, C, B, A]) {
    const c = await jobCells(page, id);
    note(tc, `畫面 ${c.jid}｜${c.status}｜開始 ${c.started}｜結束 ${c.finished}｜訊息 ${c.message}`);
  }
  sh(
    tc,
    'C01-08',
    `kubectl -n platform-jobs get pods -l 'platform/job-id in (${A},${B},${C},${D})' --sort-by=.metadata.creationTimestamp -o custom-columns='JOB:.metadata.labels.platform/job-id,開始:.status.startTime,結束:.status.containerStatuses[0].state.terminated.finishedAt,狀態:.status.phase'`,
  );
  const t = jobTimes([A, B, C, D]);
  const cPods = q(`kubectl -n platform-jobs get pods -l platform/job-id=${C} --no-headers 2>/dev/null | wc -l`);
  const dAfterB = t[D].started >= t[B].finished - 2000 && t[D].started < t[A].finished;
  note(
    tc,
    `A ${t[A].status}、B ${t[B].status}（${t[B].message}）、C ${t[C].status}（Pod ${cPods} 個）、D ${t[D].status}；D 在 B 失敗後接上且早於 A 結束：${dAfterB}`,
  );
  expect([t[A].status, t[B].status, t[C].status, t[D].status]).toEqual(['succeeded', 'failed', 'cancelled', 'succeeded']);
  expect(cPods).toBe('0');
  expect(dAfterB).toBeTruthy();
  const cells = await jobCells(page, A);
  expect(cells.message).toBe('—');
  await ctx.close();
});

test('TC-A02-05 GPU 獨占模式（pi01、P1-lung-ct）', async ({ browser }) => {
  const tc = 'TC-A02-05';
  test.setTimeout(6 * 60_000);
  const admin = await userPage(browser, 'admin01');
  await waitIdle(admin.page, 300);
  await adminTab(admin.page, '專案');
  const p1 = (await tableRows(admin.page, '專案列表')).find((r) => r[0] === P1);
  note(tc, `前置：${P1} GPU 群組 ${p1?.[2]}`);
  expect(p1?.[2]).toBe('gpu-exclusive');
  await schedulingTab(admin.page, 'GPU Dashboard');
  await expect(admin.page.getByText('目前沒有執行中的 GPU 工作')).toBeVisible();
  await shot(admin.page, tc, '01-GPU-Dashboard-送出前');
  const pi = await userPage(browser, 'pi01');
  await gotoJobs(pi.page, P1);
  const form = pi.page.getByRole('form', { name: '送出工作' });
  await expect(form.getByLabel('記憶體（MB，1–256）')).toHaveValue('16');
  const j = await submitJob(pi.page, { seconds: 60 });
  await shot(pi.page, tc, '02-送出工作訊息');
  note(tc, j.text);
  const seen: string[] = [];
  let dash = '';
  for (let i = 0; i < 40; i++) {
    await pi.page.getByRole('button', { name: '重新整理' }).click();
    await pi.page.waitForLoadState('networkidle');
    const c = await jobCells(pi.page, j.id);
    if (seen[seen.length - 1] !== c.status) {
      seen.push(c.status);
      await shot(pi.page, tc, `03-${seen.length}-狀態-${c.status}`);
      note(tc, `狀態：${c.status}（GPU 群組 ${c.group}、佇列 ${c.queue}）`);
    }
    if (c.status === '執行中' && !dash) {
      await admin.page.getByRole('button', { name: '重新整理' }).click();
      const card = admin.page.getByRole('list', { name: 'GPU 使用狀況' }).locator(':scope > li').filter({ hasText: `工作 ${j.id}（pi01）` });
      await expect(card).toHaveCount(1, { timeout: 15_000 });
      dash = (await card.innerText()).replace(/\s+/g, ' ').trim();
      const rows = await tableRows(admin.page, '執行中的 GPU 工作');
      await shot(admin.page, tc, '04-GPU-Dashboard-執行中');
      note(tc, `GPU Dashboard：${dash}；表格 ${rows.map((r) => r.slice(0, 8).join('｜')).join('；')}`);
      expect(dash).toMatch(/^gpu-exclusive · GPU \d .* 使用中 1／1 份 工作 \d+（pi01）$/);
      expect(rows.length).toBe(1);
    }
    if (c.status === '已完成' || c.status === '失敗') break;
    await pi.page.waitForTimeout(5000);
  }
  const c = await jobCells(pi.page, j.id);
  await shot(pi.page, tc, '05-已完成');
  const t = jobTimes([j.id])[j.id];
  const node = q(`kubectl -n platform-jobs get pods -l platform/job-id=${j.id} -o jsonpath='{.items[0].spec.nodeName}'`);
  sh(tc, 'TC-A02-05-pods', `kubectl -n platform-jobs get pods -o wide -l platform/job-id=${j.id}; kubectl get node ${node} -L platform/pool`);
  note(tc, `${c.jid}｜${c.kind}｜${c.status}｜${c.user}｜${c.group}｜${c.queue}｜建立 ${c.created}｜開始 ${c.started}｜結束 ${c.finished}｜訊息 ${c.message}；Pod 節點 ${node}`);
  // 開始時間取自叢集（精確到秒），建立時間精確到毫秒；同一秒內以秒比較
  const queuedEvidence = seen[0] === '排隊中' || Math.floor(t.created / 1000) <= t.started / 1000;
  note(tc, `狀態流轉 ${seen.join('→')}；畫面看到排隊中或建立不晚於開始（同一秒）：${queuedEvidence}`);
  expect(j.queue).toBe('gpu-exclusive');
  expect(c.status).toBe('已完成');
  expect(c.group).toBe('gpu-exclusive');
  expect(c.queue).toBe('gpu-exclusive');
  expect(dash).not.toBe('');
  expect(seen.filter((x) => x !== '排隊中')).toEqual(['執行中', '已完成']);
  expect(queuedEvidence).toBeTruthy();
  await pi.ctx.close();
  await admin.ctx.close();
});

test('TC-A02-06 GPU 共享模式（admin01、P2-tabular 3 件）', async ({ browser }) => {
  const tc = 'TC-A02-06';
  test.setTimeout(8 * 60_000);
  const { ctx, page } = await userPage(browser, 'admin01');
  await waitIdle(page, 300);
  await schedulingTab(page, '共享排程設定');
  const pre = `${await page.getByTestId('current-replicas').innerText()}／${await page.getByTestId('current-timeout').innerText()}`;
  note(tc, `前置：共享排程設定 ${pre}`);
  expect(pre).toBe('4／60');
  await gotoJobs(page, 'P2-tabular');
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    const j = await submitJob(page, { seconds: 90 });
    ids.push(j.id);
    note(tc, j.text);
    expect(j.queue).toBe('gpu-shared');
  }
  await shot(page, tc, '01-送出3件');
  await schedulingTab(page, 'GPU Dashboard');
  const card = page.getByRole('list', { name: 'GPU 使用狀況' }).locator(':scope > li').filter({ hasText: 'gpu-shared · GPU 0' });
  await expect(async () => {
    await page.getByRole('button', { name: '重新整理' }).click();
    await expect(card).toContainText('使用中 3／4 份', { timeout: 4000 });
  }).toPass({ timeout: 60_000 });
  const text = (await card.innerText()).replace(/\s+/g, ' ').trim();
  await shot(page, tc, '02-GPU-Dashboard-共享卡3件');
  note(tc, `GPU Dashboard：${text}`);
  await gotoJobs(page, 'P2-tabular');
  const seen: Record<number, string[]> = Object.fromEntries(ids.map((id) => [id, []]));
  for (let i = 0; i < 30; i++) {
    await page.getByRole('button', { name: '重新整理' }).click();
    await page.waitForLoadState('networkidle');
    let changed = false;
    for (const id of ids) {
      const s = (await jobCells(page, id)).status;
      if (seen[id][seen[id].length - 1] !== s) {
        seen[id].push(s);
        changed = true;
      }
    }
    if (changed) await shot(page, tc, `03-狀態-${i}`);
    if (ids.every((id) => ['已完成', '失敗'].includes(seen[id][seen[id].length - 1]))) break;
    await page.waitForTimeout(10_000);
  }
  await shot(page, tc, '04-3件已完成');
  const t = jobTimes(ids);
  for (const id of ids) {
    const c = await jobCells(page, id);
    note(tc, `${c.jid}｜${c.status}｜${c.queue}｜建立 ${c.created}｜開始 ${c.started}｜結束 ${c.finished}；狀態流轉 ${seen[id].join('→')}`);
  }
  const overlap = Math.max(...ids.map((id) => t[id].started)) < Math.min(...ids.map((id) => t[id].finished));
  note(tc, `3 件執行時間重疊（同時在共享卡上執行）：${overlap}`);
  expect(text).toMatch(/使用中 3／4 份/);
  expect((text.match(/（admin01）/g) ?? []).length).toBe(3);
  expect((text.match(/閒置/g) ?? []).length).toBe(1);
  for (const id of ids) expect(t[id].status).toBe('succeeded');
  expect(overlap).toBeTruthy();
  await ctx.close();
});

test('TC-A02-07 共享排程設定頁（3 次儲存、重新載入一致）', async ({ browser }) => {
  const tc = 'TC-A02-07';
  test.setTimeout(5 * 60_000);
  const { ctx, page } = await userPage(browser, 'admin01');
  await waitIdle(page, 300);
  await schedulingTab(page, '共享排程設定');
  const cur = async () => `${await page.getByTestId('current-replicas').innerText()}／${await page.getByTestId('current-timeout').innerText()}`;
  const original = await cur();
  note(tc, `原設定 ${original}`);
  await shot(page, tc, '00-目前設定');
  const form = page.getByRole('form', { name: '修改共享排程設定' });
  const save = async (r: string, m: string) => {
    await form.getByLabel('時間片份數（1–16）').fill(r);
    await form.getByLabel('工作時限（分鐘，1–1440）').fill(m);
    await form.getByRole('button', { name: '儲存設定' }).click();
    await ok(page, `已儲存：時間片 ${r} 份、工作時限 ${m} 分鐘`);
  };
  let same = 0;
  try {
    for (const [i, [r, m]] of [['2', '30'], ['3', '90'], ['4', '60']].entries()) {
      await save(r, m);
      await shot(page, tc, `0${i + 1}a-第${i + 1}次儲存訊息`);
      await page.reload();
      await expect(page.getByTestId('current-replicas')).toBeVisible();
      const after = await cur();
      const fr = await form.getByLabel('時間片份數（1–16）').inputValue();
      const fm = await form.getByLabel('工作時限（分鐘，1–1440）').inputValue();
      await shot(page, tc, `0${i + 1}b-第${i + 1}次重新載入`);
      const ok1 = after === `${r}／${m}` && fr === r && fm === m;
      if (ok1) same++;
      note(tc, `第 ${i + 1} 次儲存 ${r}／${m}；重新載入後目前設定 ${after}、表單 ${fr}／${fm}：${ok1 ? '一致' : '不一致'}`);
    }
  } finally {
    if ((await cur()) !== '4／60') {
      await save('4', '60');
      note(tc, '已還原為 4／60');
    }
  }
  let cap = '';
  for (let i = 0; i < 12; i++) {
    cap = q(String.raw`kubectl get node -l platform/pool=gpu-shared -o jsonpath='{.items[0].status.capacity.nvidia\.com/gpu}'`);
    if (cap === '4') break;
    await page.waitForTimeout(5000);
  }
  sh(tc, 'TC-A02-07-node', String.raw`kubectl get node -l platform/pool=gpu-shared -o jsonpath='{.items[0].status.capacity.nvidia\.com/gpu}'; echo`);
  note(tc, `一致 ${same}／3；共享 GPU 節點容量 ${cap}`);
  expect(same).toBe(3);
  expect(cap).toBe('4');
  await ctx.close();
});

test('驗收後清除（C-01）：移除成員、刪除 KIT-C 專案與 GPU 群組', async ({ browser }) => {
  const tc = '情境8-清除';
  test.setTimeout(5 * 60_000);
  const { ctx, page } = await userPage(browser, 'admin01');
  await waitIdle(page, 300);
  await cleanupKitC(page, tc);
  await shot(page, tc, '01-GPU群組已還原');
  const rows = (await tableRows(page, 'GPU 群組列表')).map((r) => r[0]);
  note(tc, `GPU 群組：${rows.join('、')}`);
  expect(rows).toEqual(['gpu-exclusive', 'gpu-shared']);
  await ctx.close();
});
