import { test, type BrowserContext, type Page } from '@playwright/test';
import { clickMenu, useProject } from './helpers';
import { gotoJobs, jobCells, jobRow, jobStatus, schedulingTab, submitJob } from './ops';
import {
  KUBE,
  P1_NAME,
  Scenario,
  api,
  apiOk,
  cancelJob,
  ensureQueueIdle,
  expect,
  ids,
  openAs,
  projectId,
  queue,
  queueCard,
  queueRow,
  queueTableOrder,
  findRunRow,
  openRun,
  refreshQueuePage,
  submitFromSetting,
  submitJobApi,
  trainingTab,
  waitQueue,
} from './n-sched-common';

// 新功能情境 A1～A4：佇列順序、暫存與恢復排隊、另存為訓練設定（docs/05-新增功能使用情境.md）。
// P1-lung-ct 綁定 GPU 群組 gpu-exclusive（kind 上 2 份 GPU：同時 2 件執行，其餘等待）。
// 研究員用 pi01（P1 的 Training／Prediction／Coding），Admin 用 admin01，各自一個視窗。
// 每個情境開始前確認 gpu-exclusive 淨空；結束時取消本情境送出的所有工作與訓練。
// 執行：npx playwright test -c playwright.acceptance.config.ts n-sched-a.spec.ts -g A1 --headed

const Q = 'gpu-exclusive';
const RESEARCHER = 'pi01';
/** 送測試工作（原「專案工作」表單，現為管理區「運算資源 › 測試工作」）的帳號：只有 Admin 看得到 */
const TESTER = 'admin01';

async function p1(): Promise<number> {
  const id = await projectId(P1_NAME);
  if (!id) throw new Error(`找不到專案 ${P1_NAME}`);
  return id;
}

const orderCell = (page: Page, id: number) => queueRow(page, Q, id).locator('td').first();
const notice = (page: Page, text: string | RegExp) => page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: text });
const oneRow = (t: string) => t.replace(/\s+/g, ' ').trim();

async function closeAll(ctxs: BrowserContext[]) {
  for (const c of ctxs) await c.close().catch(() => undefined);
}

async function cancelAll(s: Scenario, pid: number, jobs: { id: number; user: string }[]) {
  for (const j of jobs) {
    const code = await cancelJob(pid, j).catch((e) => String(e));
    s.log(`清理：取消工作 ${j.id} → ${code === 200 ? '已取消' : `HTTP ${code}（已結束或已取消）`}`);
  }
}

async function cancelRuns(s: Scenario, pid: number, runs: number[]) {
  for (const r of runs) {
    const res = await api(RESEARCHER, 'POST', `/api/projects/${pid}/training/runs/${r}/cancel`);
    s.log(`清理：取消訓練 #${r} → ${res.status === 200 ? '已取消' : `HTTP ${res.status}（已結束或已取消）`}`);
  }
}

// ---------------------------------------------------------------- A1

test('A1 緊急工作插隊：Admin 調整 GPU 佇列順序', async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  const s = new Scenario('A1', '緊急工作插隊（Admin 調整佇列順序）');
  const pid = await p1();
  const mine: { id: number; user: string }[] = [];
  const ctxs: BrowserContext[] = [];
  await s.run(
    async () => {
      await ensureQueueIdle(s, Q);
      // 準備：在管理區「運算資源 › 測試工作」（原「專案工作」）送出 5 件「訓練（GPU）」（各 300 秒），2 件執行、3 件等待。
      // 改版後測試工作只有 Admin 看得到（研究者看不到假工作），所以由 TESTER（admin01）送到 P1。
      const pi = await openAs(browser, TESTER);
      ctxs.push(pi.ctx);
      await gotoJobs(pi.page, P1_NAME);
      for (let i = 0; i < 5; i++) {
        const j = await submitJob(pi.page, { seconds: 300 });
        mine.push({ id: j.id, user: TESTER });
        expect.soft(j.queue).toBe(Q);
      }
      await s.step(pi.page, '準備-運算資源-測試工作-送出5件訓練GPU工作', `${TESTER} 送出工作 ${mine.map((j) => j.id).join('、')}，進入佇列 ${Q}`, {
        focus: pi.page.getByRole('table', { name: '工作列表' }),
      });
      const q0 = await waitQueue(Q, (q) => q.running.length === 2 && q.waiting.length === 3, 120_000, '2 件執行、3 件等待');
      const waiting = ids(q0.waiting);
      const target = waiting[waiting.length - 1];
      s.log(`佇列 ${Q}：執行中 ${ids(q0.running).join('、')}；等待中 ${waiting.join('、')}；要插隊的是最後一位的工作 ${target}`);

      // 1. 管理區 › 運算資源 › 佇列排程（原「帳號管理 → 共享排程設定 → 佇列順序」）
      const ad = await openAs(browser, 'admin01');
      ctxs.push(ad.ctx);
      await schedulingTab(ad.page, '佇列順序');
      // 2. 三張卡片
      const card = queueCard(ad.page, Q);
      await expect(ad.page.getByRole('heading', { name: 'GPU 獨占池（gpu-exclusive）' })).toBeVisible();
      for (const h of ['GPU 共享池（gpu-shared）', 'CPU 資料處理（cpu-data）']) await expect.soft(ad.page.getByRole('heading', { name: h })).toBeVisible();
      await s.step(ad.page, '佇列順序頁三張佇列卡片', '「GPU 獨占池（gpu-exclusive）」「GPU 共享池（gpu-shared）」「CPU 資料處理（cpu-data）」', { full: true });
      // 3. 順序欄
      for (const j of q0.running) {
        await expect.soft(orderCell(ad.page, j.id)).toHaveText(/^(執行中|即將開始)$/);
        await expect.soft(queueRow(ad.page, Q, j.id)).toContainText('不可移動');
      }
      for (const [i, id] of waiting.entries()) await expect.soft(orderCell(ad.page, id)).toHaveText(`第 ${i + 1} 位`);
      const t0 = await queueTableOrder(ad.page, Q);
      await s.step(ad.page, '順序欄-執行中不可移動-等待中第N位', t0.map((r) => `${r.id}=${r.order}`).join('，'), { focus: card });

      // 6. 先示範「還原」：上移一次 → 尚未套用 → 還原
      const pending = card.getByText('順序已調整，尚未套用。');
      await ad.page.getByRole('button', { name: `上移工作 ${target}` }).click();
      await expect(pending).toBeVisible();
      await s.step(ad.page, '按上移一次-出現順序已調整尚未套用', `工作 ${target} 變成第 ${waiting.length - 1} 位`, { focus: card });
      await card.getByRole('button', { name: '還原', exact: true }).click();
      await expect(pending).toHaveCount(0);
      await expect(orderCell(ad.page, target)).toHaveText(`第 ${waiting.length} 位`);
      await s.step(ad.page, '按還原-回到原本順序', `工作 ${target} 回到第 ${waiting.length} 位`, { focus: card });

      // 4. 按 ↑ 直到第 1 位
      let expected: number[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const now = ids((await queue(Q)).waiting);
        if (!now.includes(target)) throw new Error(`工作 ${target} 已不在等待中（${now}）`);
        for (let i = now.indexOf(target); i > 0; i--) await ad.page.getByRole('button', { name: `上移工作 ${target}` }).click();
        await expect(orderCell(ad.page, target)).toHaveText('第 1 位');
        await expect(pending).toBeVisible();
        expected = [target, ...now.filter((x) => x !== target)];
        await s.step(ad.page, '按上移直到第1位-尚未套用', `畫面順序 ${expected.join('、')}`, { focus: card });
        // 5. 套用順序
        await card.getByRole('button', { name: `套用 ${Q} 的順序` }).click();
        const done = notice(ad.page, `已套用 ${Q} 的順序：`);
        const conflict = ad.page.getByRole('alert').filter({ hasText: '資料衝突' });
        await expect(done.or(conflict)).toBeVisible({ timeout: 60_000 });
        if (await done.count()) break;
        await s.step(ad.page, '套用時資料衝突', (await conflict.innerText()).trim());
        if (attempt === 2) throw new Error('連續兩次資料衝突，無法完成調整');
        await refreshQueuePage(ad.page);
      }
      const doneText = (await notice(ad.page, `已套用 ${Q} 的順序：`).innerText()).trim();
      await expect.soft(notice(ad.page, `已套用 ${Q} 的順序：`)).toContainText(`已套用 ${Q} 的順序：${expected.join('、')}`);
      await s.step(ad.page, '套用順序-出現已套用訊息', doneText, { focus: card });

      // 確認：重新整理後表格、API、Kueue 的順序
      await refreshQueuePage(ad.page);
      await expect.soft(orderCell(ad.page, target)).toHaveText('第 1 位');
      const q1 = await queue(Q);
      expect.soft(ids(q1.waiting)).toEqual(expected);
      const t1 = await queueTableOrder(ad.page, Q);
      await s.step(ad.page, '重新整理後順序維持', `表格 ${t1.map((r) => `${r.id}=${r.order}`).join('，')}；API 等待順序 ${ids(q1.waiting).join('、')}`, { focus: card });
      s.shell(
        'Kueue：platform-jobs 的工作（依建立時間；平台以重新送出調整 Kueue 的先後）',
        `kubectl --context ${KUBE} -n platform-jobs get jobs -l platform/project-id=${pid} --sort-by=.metadata.creationTimestamp ` +
          `-o custom-columns=JOB_ID:.metadata.labels.platform/job-id,NAME:.metadata.name,QUEUE:.metadata.labels.kueue\\.x-k8s\\.io/queue-name,SUSPEND:.spec.suspend,CREATED:.metadata.creationTimestamp`,
      );
      s.shell(
        'Kueue：Workload（ADMITTED 空白＝等待中）',
        `kubectl --context ${KUBE} -n platform-jobs get workloads --sort-by=.metadata.creationTimestamp ` +
          `-o custom-columns=NAME:.metadata.name,JOB:.metadata.ownerReferences[0].name,QUEUE:.spec.queueName,ADMITTED:.status.admission.clusterQueue,CREATED:.metadata.creationTimestamp`,
      );

      // 實際效果：釋出一份 GPU（取消一件執行中的工作），插隊的工作應該先開始
      const freed = q0.running[0];
      s.log(`為了不必等 5 分鐘，取消執行中的工作 ${freed.id} 釋出 1 份 GPU（API，${freed.user}）：HTTP ${await cancelJob(pid, freed)}`);
      const q2 = await waitQueue(Q, (q) => ids(q.running).includes(target), 120_000, `工作 ${target} 開始`);
      expect.soft(ids(q2.waiting)).toEqual(expected.slice(1));
      await refreshQueuePage(ad.page);
      await s.step(ad.page, '釋出一份GPU後插隊的工作先開始', `執行中 ${ids(q2.running).join('、')}；等待 ${ids(q2.waiting).join('、')}`, { focus: card });

      // 稽核：調整順序寫在「專案」類
      const audit = s.psql(
        '稽核：佇列順序調整（queue.reorder）',
        `select id, actor, category, action, target, result, detail from audit_log where action = 'queue.reorder' order by id desc limit 1`,
      );
      expect.soft(audit.out).toMatch(/project/);
      expect.soft(audit.out).toContain(`queue:${Q}`);
      return `工作 ${target} 由第 ${waiting.length} 位調到第 1 位並套用；API 與 Kueue 順序一致，釋出 GPU 後先開始；稽核記在專案類`;
    },
    async () => {
      await cancelAll(s, pid, mine);
      await closeAll(ctxs);
    },
  );
});

// ---------------------------------------------------------------- A2

test('A2 研究員暫存與恢復排隊（專案工作頁與訓練紀錄）', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const s = new Scenario('A2', '先把自己等待中的訓練收起來，晚點再跑');
  const pid = await p1();
  const jobs: { id: number; user: string }[] = [];
  const runs: number[] = [];
  const ctxs: BrowserContext[] = [];
  await s.run(
    async () => {
      await ensureQueueIdle(s, Q);
      // 要送出的訓練設定：P1 中資料集仍存在的結構式設定（送出時會凍結資料）
      const datasets = ((await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/tabular/datasets`)) as { id: number }[]).map((d) => d.id);
      const settings = (await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/settings`)) as {
        id: number;
        name: string;
        kind: string;
        config: { source: { type: string; dataset_id?: number } };
      }[];
      const setting =
        settings.find((x) => x.name === process.env.A2_SETTING) ??
        settings.find((x) => x.kind === 'tabular_classification' && x.config.source.type === 'tabular' && datasets.includes(x.config.source.dataset_id!)) ??
        settings.find((x) => x.config.source.type === 'tabular' && datasets.includes(x.config.source.dataset_id!));
      if (!setting) throw new Error('P1 沒有資料集仍存在的結構式訓練設定，可用 A2_SETTING 指定設定名稱');
      s.log(`要送出的訓練設定：#${setting.id}「${setting.name}」（${setting.kind}）`);

      // ===== 從管理區「運算資源 › 測試工作」（原「專案工作」頁；改版後只有 Admin 看得到） =====
      const tj = await openAs(browser, TESTER);
      ctxs.push(tj.ctx);
      await gotoJobs(tj.page, P1_NAME);
      // 準備：先送 2 件 300 秒的工作佔滿 2 份 GPU，接著送的工作才會排隊
      for (let i = 0; i < 2; i++) jobs.push({ id: (await submitJob(tj.page, { seconds: 300 })).id, user: TESTER });
      const [b1, b2] = jobs.map((j) => j.id);
      for (const id of [b1, b2]) await expect.poll(() => jobStatus(tj.page, id), { timeout: 120_000 }).toBe('running');
      const j3 = (await submitJob(tj.page, { seconds: 300 })).id;
      jobs.push({ id: j3, user: TESTER });
      await expect.poll(() => jobStatus(tj.page, j3), { timeout: 30_000 }).toBe('queued');
      await s.step(tj.page, '運算資源-測試工作-兩件執行中第三件等待中', `工作 ${b1}、${b2} 執行中，工作 ${j3} 等待中`, { focus: jobRow(tj.page, j3) });
      // 2. 暫存
      await tj.page.getByRole('button', { name: `暫存工作 ${j3}` }).click();
      await expect(notice(tj.page, `已暫存工作 ${j3}，之後按「恢復排隊」會排到佇列最後`)).toBeVisible();
      await expect.poll(() => jobStatus(tj.page, j3), { timeout: 30_000 }).toBe('held');
      expect.soft((await jobCells(tj.page, j3)).status).toBe('已暫存');
      await s.step(tj.page, '運算資源-測試工作-按暫存-已暫存工作', `已暫存工作 ${j3}，之後按「恢復排隊」會排到佇列最後；狀態「已暫存」`, { focus: jobRow(tj.page, j3) });
      // 3. 恢復排隊
      await tj.page.getByRole('button', { name: `恢復排隊工作 ${j3}` }).click();
      await expect(notice(tj.page, `工作 ${j3} 已恢復排隊（排在佇列最後）`)).toBeVisible();
      await expect.poll(() => jobStatus(tj.page, j3), { timeout: 30_000 }).toBe('queued');
      await s.step(tj.page, '運算資源-測試工作-按恢復排隊-回到等待中', `工作 ${j3} 已恢復排隊（排在佇列最後）`, { focus: jobRow(tj.page, j3) });
      // 要注意：已開始的工作不能暫存（畫面上執行中的工作沒有「暫存」按鈕；直接呼叫 API 會得到 409）
      await expect.soft(jobRow(tj.page, b1).getByRole('button', { name: `暫存工作 ${b1}` })).toHaveCount(0);
      const r409 = await api(TESTER, 'POST', `/api/projects/${pid}/jobs/${b1}/hold`);
      s.log(`對執行中的工作 ${b1} 暫存（API POST /jobs/${b1}/hold）：HTTP ${r409.status}「${r409.body?.detail}」`);
      expect.soft(r409.status).toBe(409);
      expect.soft(String(r409.body?.detail)).toContain(`工作 ${b1} 已在執行中，無法暫存（執行中的訓練無法中途保存進度，只能取消）`);
      await s.step(tj.page, '運算資源-測試工作-執行中的工作沒有暫存按鈕', `API 回 ${r409.status}：${r409.body?.detail}`, { focus: jobRow(tj.page, b1) });

      // ===== 從建模管理（研究員：訓練設定 → 精靈送出 → 單次訓練頁） =====
      const pi = await openAs(browser, RESEARCHER);
      ctxs.push(pi.ctx);
      await useProject(pi.page, P1_NAME);
      await clickMenu(pi.page, '建模管理');
      const rid = await submitFromSetting(pi.page, setting.name);
      runs.push(rid);
      const status = pi.page.locator('.run-detail').getByTestId('run-status');
      // 單次訓練頁上方：「已送出訓練 #N（名稱），目前等待中。」（狀態變了會改成「訓練 #N（名稱）訓練中…」）
      const sent = notice(pi.page, `訓練 #${rid}（${setting.name}）`);
      await expect.soft(sent).toBeVisible();
      const sentText = `${(await sent.count()) ? (await sent.first().innerText()).trim() : '（沒有送出訊息）'}；訓練 #${rid}`;
      await s.step(pi.page, '訓練設定套用後送出訓練-進入單次訓練頁', `${sentText}；網址 /training/runs/${rid}`, { focus: status });
      // 1～2. 這次訓練的頁面：等待中
      await expect(status).toContainText('目前狀態：等待中：等待運算資源', { timeout: 30_000 });
      await s.step(pi.page, '單次訓練頁-等待中的訓練', `訓練 #${rid} ${(await status.innerText()).trim()}`, { focus: status });
      // 3. 暫存
      const detail = pi.page.locator('.run-detail');
      await detail.getByRole('button', { name: '暫存', exact: true }).click();
      await expect(status).toContainText('目前狀態：已暫存：移出佇列，按「恢復排隊」後重新排到最後', { timeout: 30_000 });
      const held = await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/runs/${rid}`);
      const qh = await queue(Q);
      s.log(`API：訓練 #${rid} 狀態 ${held.status}、工作 ${held.job_id}；佇列暫存區 ${ids(qh.held).join('、')}`);
      expect.soft(held.status).toBe('held');
      expect.soft(ids(qh.held)).toContain(held.job_id);
      await s.step(pi.page, '單次訓練頁-按暫存-已暫存', '已暫存：移出佇列，按「恢復排隊」後重新排到最後', { focus: status });
      // 4. 恢復排隊（排到最後）
      await detail.getByRole('button', { name: '恢復排隊', exact: true }).click();
      await expect(status).toContainText('目前狀態：等待中：等待運算資源', { timeout: 30_000 });
      const back = await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/runs/${rid}`);
      const qr = await queue(Q);
      s.log(`API：訓練 #${rid} 狀態 ${back.status}；${Q} 等待順序 ${ids(qr.waiting).join('、')}（最後一位應是訓練 #${rid} 的工作 ${back.job_id}）`);
      expect.soft(back.status).toBe('queued');
      expect.soft(ids(qr.waiting).at(-1)).toBe(back.job_id);
      await s.step(pi.page, '單次訓練頁-按恢復排隊-等待中排在最後', `等待順序 ${ids(qr.waiting).join('、')}`, { focus: status });
      // 訓練紀錄清單上的狀態
      await trainingTab(pi.page, '訓練紀錄');
      const row = await findRunRow(pi.page, rid);
      await expect.soft(row).toContainText('等待中');
      await s.step(pi.page, '訓練紀錄-這次訓練等待中', oneRow(await row.innerText()), { focus: row });

      // ===== 要注意：已開始訓練的按暫存會 409 =====
      // 先取消本情境的排隊與佔位工作，再重跑一次「快速測試」訓練（約 60 秒）讓它進入訓練中
      await cancelRuns(s, pid, [rid]);
      await cancelAll(s, pid, [...jobs].reverse());
      jobs.length = 0;
      const page = await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/runs?limit=100&offset=0`);
      const fake = (page.items as { id: number; executor: string; status: string }[]).find((r) => r.executor === 'fake' && r.status === 'succeeded');
      if (!fake) {
        s.partial('P1 沒有「快速測試」的訓練可重跑，未實測訓練中按暫存的 409（訊息見 api/app/training/service.py hold_run）');
        return '專案工作與訓練紀錄的暫存、恢復排隊皆如文件';
      }
      const rr = await apiOk(RESEARCHER, 'POST', `/api/projects/${pid}/training/runs/${fake.id}/rerun`);
      runs.push(rr.id);
      s.log(`以 API 重跑快速測試訓練 #${fake.id} → 訓練 #${rr.id}，等它開始訓練`);
      await expect
        .poll(async () => (await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/runs/${rr.id}`)).status, { timeout: 180_000, intervals: [1000] })
        .toBe('running');
      const h = await api(RESEARCHER, 'POST', `/api/projects/${pid}/training/runs/${rr.id}/hold`);
      s.log(`對訓練中的訓練 #${rr.id} 暫存（API）：HTTP ${h.status}「${h.body?.detail}」`);
      expect.soft(h.status).toBe(409);
      expect.soft(String(h.body?.detail)).toBe(`訓練 ${rr.id} 已開始訓練，無法暫存（訓練中無法中途保存進度，只能取消）`);
      await trainingTab(pi.page, '訓練紀錄');
      await findRunRow(pi.page, rr.id);
      await openRun(pi.page, rr.id);
      await expect.soft(status).toContainText('目前狀態：訓練中');
      await expect.soft(pi.page.locator('.run-detail').getByRole('button', { name: '暫存', exact: true })).toHaveCount(0);
      await s.step(pi.page, '單次訓練頁-訓練中沒有暫存按鈕-API回409', `HTTP ${h.status}：${h.body?.detail}`, { focus: status });
      return `專案工作與訓練紀錄的暫存、恢復排隊（排到最後）皆如文件；執行中工作與訓練中訓練暫存回 409`;
    },
    async () => {
      await cancelRuns(s, pid, runs);
      await cancelAll(s, pid, jobs);
      await closeAll(ctxs);
    },
  );
});

// ---------------------------------------------------------------- A3

test('A3 維護前先清空佇列：Admin 暫存全部等待中的工作再依序恢復', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const s = new Scenario('A3', '維護前先清空佇列');
  const pid = await p1();
  const mine: { id: number; user: string }[] = [];
  const ctxs: BrowserContext[] = [];
  await s.run(
    async () => {
      await ensureQueueIdle(s, Q);
      // 準備：在管理區「運算資源 › 測試工作」送出 2 件 150 秒（會先執行、維護前自然結束）＋ 3 件 300 秒（等待中）
      const pi = await openAs(browser, TESTER);
      ctxs.push(pi.ctx);
      await gotoJobs(pi.page, P1_NAME);
      for (const sec of [150, 150, 300, 300, 300]) mine.push({ id: (await submitJob(pi.page, { seconds: sec })).id, user: TESTER });
      await s.step(pi.page, '準備-運算資源-測試工作-送出5件訓練GPU工作', `工作 ${mine.map((j) => j.id).join('、')}（前 2 件 150 秒、後 3 件 300 秒）`, {
        focus: pi.page.getByRole('table', { name: '工作列表' }),
      });
      const q0 = await waitQueue(Q, (q) => q.running.length === 2 && q.waiting.length === 3, 120_000, '2 件執行、3 件等待');
      const original = ids(q0.waiting);
      s.log(`原本的等待順序：${original.join('、')}；執行中 ${ids(q0.running).join('、')}`);

      // 1. 佇列順序
      const ad = await openAs(browser, 'admin01');
      ctxs.push(ad.ctx);
      await schedulingTab(ad.page, '佇列順序');
      const card = queueCard(ad.page, Q);
      await s.step(ad.page, '佇列順序-維護前', (await queueTableOrder(ad.page, Q)).map((r) => `${r.id}=${r.order}`).join('，'), { focus: card });
      // 2. 對每一列「第 N 位」按暫存
      for (const id of original) {
        await expect(orderCell(ad.page, id)).toHaveText(/^第 \d+ 位$/);
        await card.getByRole('button', { name: `暫存工作 ${id}` }).click();
        await expect(notice(ad.page, `已暫存工作 ${id}`)).toBeVisible({ timeout: 30_000 });
        await expect(orderCell(ad.page, id)).toHaveText(/^暫存（admin01，.+）$/);
        await s.step(ad.page, `暫存工作${id}`, `已暫存工作 ${id}；順序欄「${(await orderCell(ad.page, id).innerText()).trim()}」`, { focus: card });
      }
      // 3. 等執行中的工作全部結束（按重新整理確認）
      await waitQueue(Q, (q) => q.running.length === 0, 6 * 60_000, '執行中的工作全部結束');
      await refreshQueuePage(ad.page);
      const tm = await queueTableOrder(ad.page, Q);
      expect.soft(tm.filter((r) => !r.order.startsWith('暫存'))).toEqual([]);
      await s.step(ad.page, '執行中工作已全部結束-可以維護', tm.map((r) => `${r.id}=${r.order}`).join('，'), { focus: card });
      s.shell(
        'Kueue：維護期間 gpu-exclusive 沒有等待與執行中的工作',
        `kubectl --context ${KUBE} get clusterqueue ${Q}; kubectl --context ${KUBE} -n platform-jobs get jobs -l platform/project-id=${pid} ` +
          `-o custom-columns=JOB_ID:.metadata.labels.platform/job-id,NAME:.metadata.name,SUSPEND:.spec.suspend,DONE:.status.succeeded`,
      );
      const qm = await queue(Q);
      expect.soft(qm.waiting.length + qm.running.length).toBe(0);
      expect.soft(ids(qm.held).sort()).toEqual([...original].sort());
      // 4. 依原本先後恢復排隊
      for (const id of original) {
        await card.getByRole('button', { name: `恢復排隊工作 ${id}` }).click();
        await expect(notice(ad.page, `工作 ${id} 已恢復排隊（排在佇列最後）`)).toBeVisible({ timeout: 30_000 });
        await s.step(ad.page, `恢復排隊工作${id}`, `工作 ${id} 已恢復排隊（排在佇列最後）`, { focus: card });
      }
      // 確認：前兩件先開始、第三件第 1 位等待＝原本的順序
      const q3 = await waitQueue(Q, (q) => q.running.length === 2, 120_000, '恢復後 2 件開始');
      expect.soft(ids(q3.running).sort()).toEqual(original.slice(0, 2).sort());
      expect.soft(ids(q3.waiting)).toEqual(original.slice(2));
      await refreshQueuePage(ad.page);
      await s.step(ad.page, '恢復後維持原本順序', `執行中 ${ids(q3.running).join('、')}；等待 ${ids(q3.waiting).join('、')}`, { focus: card });
      s.shell(
        'Kueue：恢復後的工作（依建立時間）',
        `kubectl --context ${KUBE} -n platform-jobs get workloads --sort-by=.metadata.creationTimestamp ` +
          `-o custom-columns=NAME:.metadata.name,JOB:.metadata.ownerReferences[0].name,ADMITTED:.status.admission.clusterQueue,CREATED:.metadata.creationTimestamp`,
      );
      s.psql(
        '稽核：Admin 暫存與恢復排隊',
        `select id, actor, category, action, target, result from audit_log where action in ('job.hold','job.resume') order by id desc limit 6`,
      );
      return `Admin 暫存 ${original.join('、')} 後佇列淨空，執行中工作結束；依序恢復後仍照原順序開始`;
    },
    async () => {
      await cancelAll(s, pid, mine);
      await closeAll(ctxs);
    },
  );
});

// ---------------------------------------------------------------- A4

test('A4 用上次的訓練設定再跑一次（另存為訓練設定）', async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  const s = new Scenario('A4', '用上次的訓練設定再跑一次');
  const pid = await p1();
  const blockers: { id: number; user: string }[] = [];
  const runs: number[] = [];
  const ctxs: BrowserContext[] = [];
  await s.run(
    async () => {
      // 來源訓練：已完成、平台範本、設定的結構式資料集仍存在（送出時會重新凍結資料）
      const datasets = ((await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/tabular/datasets`)) as { id: number }[]).map((d) => d.id);
      const settings = (await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/settings`)) as {
        id: number;
        name: string;
        config: { source: { type: string; dataset_id?: number } };
      }[];
      const usable = new Set(settings.filter((x) => x.config.source.type === 'tabular' && datasets.includes(x.config.source.dataset_id!)).map((x) => x.id));
      const page = await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/runs?limit=100&offset=0`);
      type Run = { id: number; name: string; kind: string; status: string; executor: string; setting_id: number; seed: number; dataset_version_id: number; config: Record<string, unknown> };
      const items = page.items as Run[];
      const src =
        items.find((r) => String(r.id) === process.env.A4_RUN) ??
        items.find((r) => r.status === 'succeeded' && r.executor === 'template' && usable.has(r.setting_id));
      if (!src) throw new Error('P1 沒有可另存的已完成訓練（資料集仍存在的結構式訓練），可用 A4_RUN 指定訓練編號');
      const newName = `${src.name}（訓練 #${src.id}）`.slice(0, 128);
      s.log(`來源訓練 #${src.id}「${src.name}」（${src.kind}，資料版本 #${src.dataset_version_id}，種子 ${src.seed}）；預設新名稱「${newName}」`);
      for (const old of settings.filter((x) => x.name === newName)) {
        await apiOk(RESEARCHER, 'DELETE', `/api/projects/${pid}/training/settings/${old.id}`);
        s.log(`開始前刪除上次留下的同名訓練設定 #${old.id}`);
      }
      // 準備：佔滿 2 份 GPU，讓之後送出的訓練停在等待中（之後取消，不真的訓練）
      await ensureQueueIdle(s, Q);
      for (let i = 0; i < 2; i++) blockers.push(await submitJobApi(RESEARCHER, pid, 600));
      await waitQueue(Q, (q) => q.running.length === 2, 120_000, '2 件佔位工作執行中');
      s.log(`準備：以 API 送出佔位工作 ${blockers.map((b) => b.id).join('、')}（600 秒）佔滿 2 份 GPU`);

      const pi = await openAs(browser, RESEARCHER);
      ctxs.push(pi.ctx);
      await useProject(pi.page, P1_NAME);
      // 1. 功能目錄「建模管理」→ 建模管理 › 訓練紀錄（列出全專案的訓練），必要時翻頁
      await clickMenu(pi.page, '建模管理');
      await expect(pi.page.getByRole('table', { name: '訓練清單' })).toBeVisible({ timeout: 30_000 });
      const row = await findRunRow(pi.page, src.id);
      await expect(row).toBeVisible();
      await s.step(pi.page, '訓練紀錄-找到要重跑的訓練', `訓練 #${src.id}（已完成）`, { focus: row });
      // 2. 進入這次訓練的頁面 → 另存設定
      const detail = await openRun(pi.page, src.id);
      await detail.getByRole('button', { name: '另存設定', exact: true }).click();
      // 3. 新設定名稱預設「原名稱（訓練 #N）」
      const input = pi.page.locator(`#save-as-${src.id}`);
      await expect(input).toHaveValue(newName);
      await s.step(pi.page, '單次訓練頁-另存設定-預設新設定名稱', `新設定名稱「${await input.inputValue()}」`, { focus: input });
      await pi.page.getByRole('form', { name: `把訓練 #${src.id} 的設定另存為訓練設定` }).getByRole('button', { name: '儲存設定' }).click();
      // 4. 出現已另存訊息
      const saved = notice(pi.page, `已另存為訓練設定「${newName}」`);
      await expect(saved).toBeVisible({ timeout: 30_000 });
      await s.step(pi.page, '按儲存設定-已另存為訓練設定', (await saved.innerText()).trim(), { focus: saved });
      // 5. 訓練設定：新設定那一列按「套用」→ 精靈「確認並送出訓練」
      await trainingTab(pi.page, '訓練設定');
      const settingsTable = pi.page.getByRole('table', { name: '訓練設定清單' });
      const settingRow = settingsTable.locator('tbody tr').filter({ has: pi.page.getByRole('rowheader', { name: newName }) });
      await expect(settingRow).toBeVisible({ timeout: 30_000 });
      await s.step(pi.page, '訓練設定清單出現新設定', newName, { focus: settingRow });
      const rid = await submitFromSetting(pi.page, newName);
      runs.push(rid);
      await expect.soft(notice(pi.page, `訓練 #${rid}（${newName}）`)).toBeVisible();
      await s.step(pi.page, '從新設定送出訓練-單次訓練頁', `訓練 #${rid}：${(await pi.page.locator('.run-detail').getByTestId('run-status').innerText()).trim()}`);
      // 確認：同一套參數；資料重新凍結
      const created = (await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/settings`)) as { id: number; name: string; config: Record<string, unknown> }[];
      const ns = created.find((x) => x.name === newName);
      const nr = await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/runs/${rid}`);
      const strip = (c: Record<string, unknown>) => JSON.stringify({ ...c, executor: undefined, source: undefined });
      s.log(`新設定 #${ns?.id}；新訓練 #${rid}：種類 ${nr.kind}、資料版本 #${nr.dataset_version_id}（原訓練 #${src.dataset_version_id}）、種子 ${nr.seed}（原 ${src.seed}）`);
      s.log(`參數比對（去掉執行方式與資料來源）：${strip(nr.config) === strip(src.config) ? '相同' : `不同\n  原：${strip(src.config)}\n  新：${strip(nr.config)}`}`);
      expect.soft(nr.kind).toBe(src.kind);
      expect.soft(strip(nr.config)).toBe(strip(src.config));
      return `訓練 #${src.id} 另存為「${newName}」並從清單送出訓練 #${rid}（參數相同、資料重新凍結為版本 #${nr.dataset_version_id}）`;
    },
    async () => {
      await cancelRuns(s, pid, runs);
      await cancelAll(s, pid, blockers);
      s.log('另存的訓練設定保留在 P1（下次執行開始前會先刪掉同名設定）');
      await closeAll(ctxs);
    },
  );
});
