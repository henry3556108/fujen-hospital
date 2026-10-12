import fs from 'node:fs';
import path from 'node:path';
import { test, type BrowserContext, type Page } from '@playwright/test';
import { clickMenu, useProject } from './helpers';
import { adminTab, gotoJobs, jobCells, jobRow } from './ops';
import { GATEWAY, P1_NAME, REPO, Scenario, api, apiOk, expect, openAs, projectId, tokenExpr, userId } from './n-sched-common';

// 新功能情境 E1～E5：功能缺口補齊（docs/05-新增功能使用情境.md）。
// 研究員用 pi01（P1 的 Training／Prediction／Coding，不是 Admin）；Admin 用 admin01。
// E1 只刪除自己建立的拋棄式專案 KIT-E1-結案（不碰種子專案）；E3／E4 結束時停止自己建立的分享。
// 執行：npx playwright test -c playwright.acceptance.config.ts n-sched-e.spec.ts -g E1 --headed

const RESEARCHER = 'pi01';
const SAMPLE: Record<string, number> = { age: 50, bmi: 24.1, glucose: 101, sbp: 128, dbp: 80 };
const notice = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });

interface Model {
  id: number;
  name: string;
  title: string | null;
  kind: string;
}
interface Deployment {
  id: number;
  name: string;
  title: string | null;
  model_id: number;
  endpoint: string;
  allowed_users: string[];
}

async function p1(): Promise<number> {
  const id = await projectId(P1_NAME);
  if (!id) throw new Error(`找不到專案 ${P1_NAME}`);
  return id;
}

const display = (m: Model) => m.title || m.name;

async function closeAll(ctxs: BrowserContext[]) {
  for (const c of ctxs) await c.close().catch(() => undefined);
}

/** 停止 P1 中顯示名稱以 prefix 開頭的分享（上次中斷留下的） */
async function stopShares(s: Scenario, pid: number, prefix: string) {
  const deps = (await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/deployments`)) as Deployment[];
  for (const d of deps.filter((x) => (x.title ?? '').startsWith(prefix))) {
    const r = await api(RESEARCHER, 'DELETE', `/api/projects/${pid}/deployments/${d.id}`);
    s.log(`停止分享「${d.title}」（${d.name}）→ HTTP ${r.status}`);
  }
}

/** 選一個還沒有分享的結構式模型（分享的技術名稱 model-{編號} 不能重複） */
async function freeTabularModel(pid: number, prefer: string[], exclude: number[] = []): Promise<Model> {
  const models = (await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/models`)) as Model[];
  const deps = (await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/deployments`)) as Deployment[];
  const used = new Set([...deps.map((d) => d.model_id), ...exclude]);
  for (const kind of prefer) {
    const m = models.find((x) => x.kind === kind && !used.has(x.id) && !x.name.includes('修改後的原始碼'));
    if (m) return m;
  }
  throw new Error('P1 沒有尚未分享的結構式模型');
}

/** 把試呼叫 JSON 中的 null 換成示範病人的數值 */
function fillRows(text: string): string {
  const body = JSON.parse(text) as { rows: Record<string, unknown>[] };
  body.rows = body.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? (SAMPLE[k] ?? 1) : v])));
  return JSON.stringify(body, null, 2);
}

// ---------------------------------------------------------------- E1

test('E1 研究結案：刪除專案時線上服務一併停止', async ({ browser }) => {
  test.setTimeout(25 * 60_000);
  const s = new Scenario('E1', '研究結案，刪除專案時線上服務一併停止');
  const NAME = 'KIT-E1-結案';
  const ctxs: BrowserContext[] = [];
  let pid: number | null = null;
  await s.run(
    async () => {
      // ===== 準備（API）：拋棄式專案、成員、資料集、訓練、部署 =====
      const stale = await projectId(NAME);
      if (stale) {
        await apiOk('admin01', 'DELETE', `/api/admin/projects/${stale}`);
        s.log(`準備：刪除上次留下的 ${NAME}（#${stale}）`);
      }
      const p = await apiOk('admin01', 'POST', '/api/admin/projects', { name: NAME, description: '情境 E1 用的拋棄式專案（測試後刪除）', gpu_group: 'gpu-shared' });
      pid = p.id as number;
      await apiOk('admin01', 'PUT', `/api/admin/projects/${pid}/members/${await userId(RESEARCHER)}`, { role: 'principal_investigator' });
      s.log(`準備：建立專案 ${NAME}（#${pid}，GPU 群組 gpu-shared），加入 ${RESEARCHER}（Principal Investigator：Training＋Prediction）`);
      const dir = path.join(REPO, 'docs/acceptance-kit/m1/data/tabular');
      const fd = new FormData();
      fd.append('schema', fs.readFileSync(path.join(dir, 'schema.json'), 'utf8'));
      fd.append('name', 'KIT-E1 cohort_01');
      fd.append('file', new Blob([fs.readFileSync(path.join(dir, 'cohort_01.csv'))], { type: 'text/csv' }), 'cohort_01.csv');
      const ds = await apiOk(RESEARCHER, 'POST', `/api/projects/${pid}/tabular/datasets`, fd);
      const datasetId = ds.dataset.id as number;
      const setting = await apiOk(RESEARCHER, 'POST', `/api/projects/${pid}/training/settings`, {
        name: 'KIT-E1 結案模型',
        config: {
          kind: 'tabular_classification',
          source: { type: 'tabular', dataset_id: datasetId },
          split: { train: 0.6, validation: 0.2, test: 0.2 },
          seed: 11,
          tabular: { target: 'diagnosis', features: ['age', 'bmi', 'glucose', 'sbp'], steps: [{ id: 'impute_mean', columns: ['glucose'] }], algorithm: 'random_forest' },
          hyperparameters: { n_estimators: 20 },
        },
      });
      const run = await apiOk(RESEARCHER, 'POST', `/api/projects/${pid}/training/settings/${setting.id}/runs`, { executor: 'template' });
      s.log(`準備：上傳資料集 #${datasetId}、建立訓練設定 #${setting.id}、送出訓練 #${run.id}，等待訓練完成`);
      let done = run;
      await expect
        .poll(
          async () => {
            done = await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/runs/${run.id}`);
            return ['succeeded', 'failed', 'cancelled'].includes(done.status);
          },
          { timeout: 12 * 60_000, intervals: [3000] },
        )
        .toBe(true);
      if (done.status !== 'succeeded' || !done.model_id) throw new Error(`準備用的訓練 #${run.id} 沒有成功：${done.status} ${done.message}`);
      const dep = (await apiOk(RESEARCHER, 'POST', `/api/projects/${pid}/deployments`, {
        model_id: done.model_id,
        title: 'KIT-E1 結案服務',
        allowed_users: [RESEARCHER],
      })) as Deployment;
      s.log(`準備：訓練完成（模型 #${done.model_id}），部署「${dep.title}」（${dep.name}），端點 POST ${dep.endpoint}，授權 ${dep.allowed_users.join('、')}`);

      const call = (label: string) =>
        s.shell(
          label,
          `TOKEN=${tokenExpr(RESEARCHER)}; curl -s -w '\\nHTTP %{http_code}\\n' -X POST ${GATEWAY}${dep.endpoint} ` +
            `-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"rows":[{"age":50,"bmi":24.1,"glucose":101,"sbp":128}]}'`,
        );
      // 刪除前：授權帳號呼叫成功
      const before = call('刪除前：授權帳號 pi01 經 Gateway 呼叫部署端點');
      const code1 = /HTTP (\d+)/.exec(before.out)?.[1];
      s.log(`刪除前呼叫：HTTP ${code1}`);
      expect(code1).toBe('200');

      // ===== 1. 帳號管理 → 專案 =====
      const ad = await openAs(browser, 'admin01');
      ctxs.push(ad.ctx);
      await adminTab(ad.page, '專案');
      const row = ad.page.getByRole('table', { name: '專案列表' }).locator('tbody tr').filter({ has: ad.page.getByRole('rowheader', { name: NAME, exact: true }) });
      await expect(row).toBeVisible();
      await s.step(ad.page, '帳號管理-專案列表', `${NAME}（GPU 群組 gpu-shared）`, { focus: row });
      // 2～3. 刪除 → 確認視窗
      await row.getByRole('button', { name: `刪除 ${NAME}` }).click();
      const dialog = ad.page.getByRole('dialog');
      await expect(dialog).toContainText(`確定要刪除專案「${NAME}」嗎？專案成員資格會一併移除，此動作無法復原。`);
      await s.step(ad.page, '刪除專案確認視窗', (await dialog.innerText()).replace(/\s+/g, ' ').trim());
      await dialog.getByRole('button', { name: '確認刪除' }).click();
      // 4. 已刪除
      const msg = notice(ad.page, `已刪除專案「${NAME}」`);
      await expect(msg).toBeVisible({ timeout: 60_000 });
      await expect(ad.page.getByRole('rowheader', { name: NAME, exact: true })).toHaveCount(0);
      await s.step(ad.page, '已刪除專案', (await msg.innerText()).trim(), { focus: msg });
      const deletedId = pid;
      pid = null;

      // 5. 之後呼叫一律 403
      const after = call('刪除後：同一帳號再呼叫同一端點');
      const code2 = /HTTP (\d+)/.exec(after.out)?.[1];
      s.log(`刪除後呼叫：HTTP ${code2}`);
      expect.soft(code2).toBe('403');

      // 資料庫：部署列已刪、清理稽核記下卸載的模型數、沒有留下待重試的卸載
      s.psql('資料庫：這個專案的部署（應為 0 筆）', `select count(*) as deployments from model_deployments where project_id = ${deletedId}`);
      const audit = s.psql(
        '稽核：專案資料清理（project.data_cleanup）',
        `select id, actor, category, action, target, result, detail from audit_log where action = 'project.data_cleanup' order by id desc limit 1`,
      );
      expect.soft(audit.out).toContain(String(deletedId));
      s.psql('待清理清單（卸載失敗才會留下，之後自動重試）', `select kind, ref, attempts, last_error from storage_cleanup_tasks where project_id = ${deletedId}`);
      return `刪除前授權呼叫 200；刪除 ${NAME} 後同一呼叫 ${code2}`;
    },
    async () => {
      if (pid) {
        const r = await api('admin01', 'DELETE', `/api/admin/projects/${pid}`);
        s.log(`清理：以 API 刪除 ${NAME}（#${pid}）→ HTTP ${r.status}`);
      }
      await closeAll(ctxs);
    },
  );
});

// ---------------------------------------------------------------- E2

test('E2 批次推論跑完，工作狀態即時更新', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const s = new Scenario('E2', '批次推論跑完，工作狀態即時更新');
  const pid = await p1();
  const ctxs: BrowserContext[] = [];
  let pendingRecord: number | null = null;
  await s.run(
    async () => {
      const models = (await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/models`)) as Model[];
      const model =
        models.find((m) => String(m.id) === process.env.E2_MODEL_ID) ??
        models.find((m) => m.kind === 'tabular_classification' && !m.name.includes('修改後的原始碼')) ??
        models.find((m) => m.kind.startsWith('tabular_'));
      if (!model) throw new Error('P1 沒有結構式模型（可用 E2_MODEL_ID 指定）');
      const image = model.kind.startsWith('image_');
      const batchName = image ? '多張影像一起預測' : '多位病人一起預測';
      s.log(`使用模型 #${model.id}「${display(model)}」（${model.kind}）`);

      // 1. 推論服務管理 → 選擇模型
      const pi = await openAs(browser, RESEARCHER);
      ctxs.push(pi.ctx);
      await useProject(pi.page, P1_NAME);
      await clickMenu(pi.page, '推論服務管理');
      const choose = pi.page.getByRole('button', { name: `選擇 ${display(model)}`, exact: true });
      if (await choose.count()) await choose.click();
      await expect(pi.page.getByRole('heading', { name: `預測：${display(model)}` })).toBeVisible({ timeout: 30_000 });
      await s.step(pi.page, '推論服務管理-選擇模型', display(model), { focus: pi.page.getByRole('heading', { name: `預測：${display(model)}` }) });
      // 2. 資料範圍選測試資料，送出
      const form = pi.page.getByRole('form', { name: batchName });
      await form.getByLabel('資料範圍').selectOption({ label: '測試資料' });
      await form.getByRole('button', { name: batchName }).click();
      // 3. 排隊中訊息
      const st = pi.page.getByTestId('batch-status');
      const download = pi.page.getByRole('button', { name: '下載結果' });
      await expect(st.or(download)).toBeVisible({ timeout: 30_000 });
      const head = pi.page.locator('#result-title');
      const rid = Number(/#(\d+)/.exec(await head.innerText())![1]);
      pendingRecord = rid;
      if (await st.count()) {
        const t = (await st.innerText()).trim();
        await expect.soft(st).toContainText('…在背景執行，完成後自動顯示結果；離開此頁也不影響');
        await s.step(pi.page, '送出批次預測-排隊中訊息', t, { focus: head });
      } else {
        s.log('批次預測太快完成，沒拍到排隊中訊息');
      }
      // 4. 完成後自動出現結果
      await expect(download).toBeVisible({ timeout: 12 * 60_000 });
      await expect(st).toHaveCount(0);
      const headText = (await head.innerText()).trim();
      await expect.soft(head).toHaveText(new RegExp(`預測結果 #${rid}（\\d+ 筆）`));
      await s.step(pi.page, '完成後自動顯示預測結果', headText, { focus: head });
      const hist = pi.page.getByRole('table', { name: '預測紀錄' }).locator('tbody tr').filter({ hasText: `#${rid}` }).first();
      await expect.soft(hist).toContainText('成功', { timeout: 30_000 });
      await s.step(pi.page, '預測紀錄-結果欄', (await hist.innerText()).replace(/\s+/g, ' ').trim(), { focus: hist });
      const rec = await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/inference/${rid}`);
      pendingRecord = null;
      s.log(`API：推論 #${rid} 狀態 ${rec.status}、${rec.count} 筆、排程工作 ${rec.job_id}`);

      // 資料庫：推論程式回報時 jobs 表同時定案（在任何人打開工作列表之前查）
      const db = s.psql(
        '資料庫：jobs 表（打開專案工作頁之前）',
        `select id, kind, status, queue, started_at, finished_at from jobs where id = ${rec.job_id}`,
      );
      expect.soft(db.out).toContain('succeeded');

      // 5. 建模管理 → 專案工作：種類與狀態（不按重新整理）
      await gotoJobs(pi.page, P1_NAME);
      const cells = await jobCells(pi.page, rec.job_id);
      s.log(`專案工作 ${rec.job_id}：種類「${cells.kind}」、狀態「${cells.status}」、佇列 ${cells.queue}、結束 ${cells.finished}`);
      expect.soft(cells.kind).toMatch(/^批次推論（(GPU|CPU)）$/);
      expect.soft(cells.status).toBe('已完成');
      await s.step(pi.page, '專案工作-批次推論已完成', `${cells.kind}／${cells.status}`, { focus: jobRow(pi.page, rec.job_id) });
      return `批次預測 #${rid} 自動顯示結果（${rec.count} 筆），工作 ${rec.job_id} 為「${cells.kind}」「${cells.status}」，資料庫同為 succeeded`;
    },
    async () => {
      if (pendingRecord) {
        const r = await api(RESEARCHER, 'POST', `/api/projects/${pid}/inference/${pendingRecord}/cancel`);
        s.log(`清理：取消未完成的批次推論 #${pendingRecord} → HTTP ${r.status}`);
      }
      await closeAll(ctxs);
    },
  );
});

// ---------------------------------------------------------------- E3

test('E3 分享模型給同事時直接挑帳號', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const s = new Scenario('E3', '分享模型給同事時直接挑帳號（非 Admin）');
  const pid = await p1();
  const TITLE = 'KIT-E3 分享測試';
  const ctxs: BrowserContext[] = [];
  await s.run(
    async () => {
      await stopShares(s, pid, 'KIT-E3');
      const model = await freeTabularModel(pid, ['tabular_classification', 'tabular_regression']);
      s.log(`要分享的模型 #${model.id}「${display(model)}」；分享者 ${RESEARCHER}（帳號類型 User）`);
      const lookup = await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/user-lookup?q=md`);
      s.log(`API：${RESEARCHER} 查詢帳號開頭「md」→ ${JSON.stringify(lookup)}（只回帳號與是否為本專案成員）`);

      // 1. AI 模型部署 → 分享給同事使用
      const pi = await openAs(browser, RESEARCHER);
      ctxs.push(pi.ctx);
      await useProject(pi.page, P1_NAME);
      await clickMenu(pi.page, 'AI 模型部署');
      const form = pi.page.getByRole('form', { name: '分享給同事使用' });
      await expect(form).toBeVisible({ timeout: 30_000 });
      // 2. 模型、顯示名稱
      await form.getByLabel('模型').selectOption(String(model.id));
      await form.getByLabel('顯示名稱（同事看到的名稱，可用中文）').fill(TITLE);
      // 3～4. 輸入帳號開頭，點選建議
      const users = pi.page.locator('#dep-users');
      const suggest = form.getByRole('list', { name: '符合的帳號' });
      await users.fill('md');
      await expect(suggest.getByRole('button', { name: 'md01', exact: true })).toBeVisible({ timeout: 15_000 });
      await s.step(pi.page, '輸入md-列出符合的帳號', (await suggest.innerText()).replace(/\s+/g, ' ').trim(), { focus: form });
      await suggest.getByRole('button', { name: 'md01', exact: true }).click();
      await expect(users).toHaveValue('md01, ');
      // 非成員：輸入 u → user01（不是本專案成員）
      await users.fill('md01, u');
      const outsider = suggest.getByRole('button', { name: /（不是本專案成員）$/ }).first();
      await expect(outsider).toBeVisible({ timeout: 15_000 });
      const outsiderText = (await outsider.innerText()).trim();
      const outsiderName = outsiderText.replace('（不是本專案成員）', '');
      await s.step(pi.page, '輸入u-非成員顯示不是本專案成員', (await suggest.innerText()).replace(/\s+/g, ' ').trim(), { focus: form });
      await outsider.click();
      await expect(users).toHaveValue(`md01, ${outsiderName}, `);
      await s.step(pi.page, '點選後加入欄位', await users.inputValue(), { focus: form });
      // 5. 分享
      await form.getByRole('button', { name: '分享給同事使用', exact: true }).click();
      const shared = notice(pi.page, `已把「${TITLE}」分享給 md01、${outsiderName}。他們登入後點左側「推論服務管理」，選模型「${TITLE}」就能預測。`);
      await expect(shared).toBeVisible({ timeout: 30_000 });
      await expect.soft(shared).toContainText(`注意：${outsiderName} 不是本專案有推論權限的成員`);
      await s.step(pi.page, '分享給同事使用-已分享', (await shared.innerText()).trim(), { focus: shared });
      // 6. 修改分享對象：拿掉非成員、加入 ra01（同樣輸入開頭點選）
      const list = pi.page.getByRole('table', { name: '已分享的模型' });
      const row = list.locator('tbody tr').filter({ has: pi.page.getByRole('rowheader', { name: TITLE, exact: true }) });
      await expect.soft(row).toContainText(model.name);
      await row.getByRole('button', { name: `修改分享對象「${TITLE}」` }).click();
      const access = pi.page.locator('#dep-access');
      await expect(access).toHaveValue(`md01, ${outsiderName}`);
      await access.fill('md01, ra');
      const editSuggest = pi.page.getByRole('form', { name: '修改分享對象' }).getByRole('list', { name: '符合的帳號' });
      await expect(editSuggest.getByRole('button', { name: 'ra01', exact: true })).toBeVisible({ timeout: 15_000 });
      await s.step(pi.page, '修改分享對象-輸入ra列出帳號', (await editSuggest.innerText()).replace(/\s+/g, ' ').trim(), { focus: access });
      await editSuggest.getByRole('button', { name: 'ra01', exact: true }).click();
      await pi.page.getByRole('button', { name: '儲存分享對象' }).click();
      const updated = notice(pi.page, `已更新「${TITLE}」的分享對象：md01、ra01。`);
      await expect(updated).toBeVisible({ timeout: 30_000 });
      await expect.soft(row).toContainText('md01、ra01');
      await s.step(pi.page, '儲存分享對象-已更新', (await updated.innerText()).trim(), { focus: row });
      // 結束：停止分享
      await row.getByRole('button', { name: `停止分享「${TITLE}」` }).click();
      await pi.page.getByRole('dialog').getByRole('button', { name: '停止分享' }).click();
      const stopped = notice(pi.page, `已停止分享「${TITLE}」`);
      await expect(stopped).toBeVisible({ timeout: 30_000 });
      await s.step(pi.page, '停止分享', (await stopped.innerText()).trim(), { focus: stopped });
      return `非 Admin 的 ${RESEARCHER} 輸入「md」「u」「ra」點選帳號完成分享與修改；非成員標示「（不是本專案成員）」並提醒`;
    },
    async () => {
      await stopShares(s, pid, 'KIT-E3');
      await closeAll(ctxs);
    },
  );
});

// ---------------------------------------------------------------- E4

test('E4 分享後先在網頁上試呼叫', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const s = new Scenario('E4', '分享後先在網頁上試呼叫');
  const pid = await p1();
  const TITLE = 'KIT-E4 試呼叫';
  const ctxs: BrowserContext[] = [];
  await s.run(
    async () => {
      await stopShares(s, pid, 'KIT-E4');
      // 準備（API）：分享一個結構式模型給 md01（不含自己）
      const model = await freeTabularModel(pid, ['tabular_regression', 'tabular_classification']);
      const dep = (await apiOk(RESEARCHER, 'POST', `/api/projects/${pid}/deployments`, { model_id: model.id, title: TITLE, allowed_users: ['md01'] })) as Deployment;
      s.log(`準備：以 API 分享模型 #${model.id}「${display(model)}」為「${TITLE}」（${dep.name}），分享給 md01；端點 POST ${dep.endpoint}`);

      // 1. AI 模型部署 → 已分享的模型（「模型」欄顯示實際的模型）
      const pi = await openAs(browser, RESEARCHER);
      ctxs.push(pi.ctx);
      await useProject(pi.page, P1_NAME);
      await clickMenu(pi.page, 'AI 模型部署');
      const list = pi.page.getByRole('table', { name: '已分享的模型' });
      const row = list.locator('tbody tr').filter({ has: pi.page.getByRole('rowheader', { name: TITLE, exact: true }) });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect.soft(row).toContainText(model.name);
      await s.step(pi.page, '已分享的模型-模型欄', (await row.innerText()).replace(/\s+/g, ' ').trim(), { focus: list });
      // 2～3. 自己不在分享對象：先試一次（預期提醒＋403）
      const tryForm = pi.page.getByRole('form', { name: '試呼叫' });
      await tryForm.getByLabel('要呼叫的分享').selectOption(String(dep.id));
      const warn = tryForm.getByRole('status').filter({ hasText: `你（${RESEARCHER}）不在「${TITLE}」的分享對象中，呼叫會被拒絕（403）` });
      await expect(warn).toBeVisible();
      // 4. 結構式模型：把 null 換成病人的數值
      const body = tryForm.getByLabel('送出的 JSON');
      const prefilled = await body.inputValue();
      s.log(`預填的 JSON：${prefilled.replace(/\s+/g, ' ')}`);
      await body.fill(fillRows(prefilled));
      await s.step(pi.page, '試呼叫-不在分享對象中的提醒', (await warn.innerText()).trim(), { focus: tryForm });
      const submit = tryForm.getByRole('button', { name: `送出試呼叫（POST ${dep.endpoint}）` });
      await submit.click();
      const denied = tryForm.getByRole('alert');
      await expect(denied).toBeVisible({ timeout: 30_000 });
      await expect.soft(denied).toContainText('沒有權限');
      await s.step(pi.page, '試呼叫-不在分享對象-403', (await denied.innerText()).replace(/\s+/g, ' ').trim(), { focus: tryForm });
      // 把自己加入分享對象（輸入開頭點選）
      await row.getByRole('button', { name: `修改分享對象「${TITLE}」` }).click();
      const access = pi.page.locator('#dep-access');
      await access.fill(`${await access.inputValue()}, pi`);
      const suggest = pi.page.getByRole('form', { name: '修改分享對象' }).getByRole('list', { name: '符合的帳號' });
      await suggest.getByRole('button', { name: RESEARCHER, exact: true }).click();
      await pi.page.getByRole('button', { name: '儲存分享對象' }).click();
      const updated = notice(pi.page, `已更新「${TITLE}」的分享對象：md01、${RESEARCHER}。`);
      await expect(updated).toBeVisible({ timeout: 30_000 });
      await s.step(pi.page, '修改分享對象-把自己加入', (await updated.innerText()).trim(), { focus: row });
      // 5～6. 再試呼叫：成功
      await tryForm.getByLabel('要呼叫的分享').selectOption(String(dep.id));
      await expect(warn).toHaveCount(0);
      if ((await body.inputValue()).includes('null')) await body.fill(fillRows(await body.inputValue()));
      await submit.click();
      const ok = tryForm.getByRole('status').filter({ hasText: /呼叫成功（推論紀錄 #\d+）。/ });
      await expect(ok).toBeVisible({ timeout: 60_000 });
      const reply = tryForm.getByLabel('試呼叫的回應');
      await expect(reply).toBeVisible();
      const replyText = (await reply.innerText()).trim();
      s.log(`試呼叫回應：${replyText.replace(/\s+/g, ' ').slice(0, 600)}`);
      await s.step(pi.page, '試呼叫成功-推論紀錄與回應', (await ok.innerText()).trim(), { focus: tryForm });
      // 要注意：給資訊人員的串接方式
      const it = pi.page.getByTestId('it-details');
      await it.locator('summary').click();
      await expect(it.getByRole('table', { name: '程式呼叫端點' })).toContainText(dep.endpoint);
      await s.step(pi.page, '給資訊人員-程式呼叫方式', `POST ${dep.endpoint}`, { focus: it });
      s.psql(
        '稽核：試呼叫與一般程式呼叫相同（inference.online：先 denied 後 success）',
        `select id, actor, action, result, target from audit_log where action = 'inference.online' and actor = '${RESEARCHER}' order by id desc limit 2`,
      );
      return `不在分享對象時提醒並得到 403；加入自己後試呼叫成功（${(await ok.innerText()).trim()}）`;
    },
    async () => {
      await stopShares(s, pid, 'KIT-E4');
      await closeAll(ctxs);
    },
  );
});

// ---------------------------------------------------------------- E5

test('E5 訓練紀錄翻頁查詢', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const s = new Scenario('E5', '訓練紀錄多了以後翻頁查詢');
  const pid = await p1();
  const ctxs: BrowserContext[] = [];
  await s.run(
    async () => {
      const all = await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/runs?limit=20&offset=0`);
      const mine = await apiOk(RESEARCHER, 'GET', `/api/projects/${pid}/training/runs?limit=20&offset=0&mine=true`);
      s.log(`API：P1 訓練共 ${all.total} 筆，${RESEARCHER} 送出的 ${mine.total} 筆`);

      const pi = await openAs(browser, RESEARCHER);
      ctxs.push(pi.ctx);
      await useProject(pi.page, P1_NAME);
      await clickMenu(pi.page, '建模管理');
      const box = pi.page.getByRole('checkbox', { name: '只看我送出的' });
      const range = pi.page.getByTestId('runs-range');
      const pager = pi.page.getByRole('navigation', { name: '訓練紀錄分頁' });
      const table = pi.page.getByRole('table', { name: '訓練清單' });
      // 1. 預設勾選「只看我送出的」
      await expect(box).toBeChecked({ timeout: 30_000 });
      await expect(range).toContainText(`共 ${mine.total} 筆（只列你送出的）`);
      await s.step(pi.page, '預設只看我送出的', (await range.innerText()).trim(), { focus: range });
      // 2. 取消勾選，看全專案
      await box.uncheck();
      const first = Math.min(20, all.total);
      await expect(range).toHaveText(`共 ${all.total} 筆，這一頁是第 1–${first} 筆（每頁 20 筆，由新到舊；依分數排序只排這一頁）。`);
      await s.step(pi.page, '取消勾選-全專案範圍文字', (await range.innerText()).trim(), { focus: range });
      // 3. 超過 20 筆才有分頁
      const pages = Math.max(1, Math.ceil(all.total / 20));
      if (all.total <= 20) {
        await expect(pager).toHaveCount(0);
        s.partial(`P1 目前只有 ${all.total} 筆訓練（≤ 20），不會出現「上一頁／下一頁」；為了不灌爆佇列沒有另外送訓練，翻頁只驗證了不出現分頁列與範圍文字`);
      } else {
        await expect(pager).toContainText(`第 1 / ${pages} 頁`);
        await expect(pager.getByRole('button', { name: '上一頁' })).toBeDisabled();
        await s.step(pi.page, '分頁列-第1頁', (await pager.innerText()).replace(/\s+/g, ' '), { focus: pager });
        await pager.getByRole('button', { name: '下一頁' }).click();
        await expect(pager).toContainText(`第 2 / ${pages} 頁`);
        await expect(range).toContainText(`這一頁是第 21–${Math.min(40, all.total)} 筆`);
        await s.step(pi.page, '按下一頁-第2頁', (await range.innerText()).trim(), { focus: range });
        await pager.getByRole('button', { name: '上一頁' }).click();
        await expect(pager).toContainText(`第 1 / ${pages} 頁`);
      }
      // 4. 依分數排序（只排這一頁）、再點反向、點編號回到依時間
      const ids = async () => (await table.locator('tbody tr:not(.run-expanded) td:first-child').allInnerTexts()).map((t) => t.trim()).join(' ');
      const scoreHead = pi.page.getByRole('columnheader', { name: '主要分數（依分數排序）' });
      const idHead = pi.page.getByRole('columnheader', { name: '編號（依時間排序）' });
      await expect(idHead).toHaveAttribute('aria-sort', 'descending');
      const byTime = await ids();
      await scoreHead.getByRole('button').click();
      await expect(scoreHead).toHaveAttribute('aria-sort', 'descending');
      await s.step(pi.page, '依分數排序-高到低', await ids(), { focus: table });
      await scoreHead.getByRole('button').click();
      await expect(scoreHead).toHaveAttribute('aria-sort', 'ascending');
      await s.step(pi.page, '再點一次-低到高', await ids(), { focus: table });
      await idHead.getByRole('button').click();
      await expect(idHead).toHaveAttribute('aria-sort', 'descending');
      expect.soft(await ids()).toBe(byTime);
      await s.step(pi.page, '點編號-回到依時間', await ids(), { focus: table });
      // 5. 展開訓練
      const open = table.getByRole('button', { name: /^展開訓練 #\d+$/ }).first();
      const label = (await open.innerText()).trim();
      await open.click();
      await expect(pi.page.getByTestId('run-status')).toBeVisible();
      await s.step(pi.page, '展開訓練查看細節', label, { focus: pi.page.locator('.run-detail') });
      return all.total > 20 ? `共 ${all.total} 筆分 ${pages} 頁可翻頁；排序與展開正常` : '範圍文字、排序與展開正常';
    },
    async () => {
      await closeAll(ctxs);
    },
  );
});
