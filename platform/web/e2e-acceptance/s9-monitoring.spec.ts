import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { note, shot } from './helpers';
import { KIT, REPO, q, schedulingTab, sh, userPage } from './ops';

// 情境 9：系統監控（C-02 的 TC-C02-01～03）。不做 TC-C02-04（節點失聯、CPU 滿載告警，會動到叢集節點）。
// 網頁部分：管理區「系統監控」頁 → 開 Prometheus／Grafana，在瀏覽器裡操作；終端機部分照劇本執行並存檔。
// TC-C02-03 匯入的測試儀表板最後在 Grafana 介面刪除。

const PROM = process.env.PROMETHEUS_URL || 'http://127.0.0.1:39090';
const GRAFANA = process.env.GRAFANA_URL || 'http://127.0.0.1:33000';
const GRAFANA_PW = process.env.GRAFANA_PASSWORD || 'Grafana-dev-01!';
const DASH_UID = 'tc-c02-03-kit';
const DASH_TITLE = 'TC-C02-03 驗收儀表板';

/** 管理區「系統監控」頁點卡片，開出監控工具的新分頁 */
async function openTool(browserPage: Page, name: string) {
  await schedulingTab(browserPage, '監控儀表板');
  const [popup] = await Promise.all([
    browserPage.waitForEvent('popup'),
    browserPage.getByRole('link', { name: new RegExp(`^${name}（開新分頁）`) }).click(),
  ]);
  await popup.waitForLoadState();
  return popup;
}

/** Prometheus HTTP API（與畫面同一個資料來源）取查詢結果 */
function promQuery(expr: string): { metric: Record<string, string>; value: [number, string] }[] {
  const out = q(`curl -s -G '${PROM}/api/v1/query' --data-urlencode 'query=${expr.replace(/'/g, `'\\''`)}'`);
  return JSON.parse(out).data.result;
}

/** 在 Prometheus「Query」頁輸入查詢、按 Execute */
async function runQuery(prom: Page, expr: string) {
  await prom.goto(`${PROM}/query`);
  const editor = prom.locator('.cm-content').first();
  await editor.click();
  await prom.keyboard.press('Control+A');
  await prom.keyboard.press('Delete');
  await prom.keyboard.insertText(expr);
  await prom.keyboard.press('Escape'); // 關掉自動完成
  await prom.getByRole('button', { name: /^Execute$/ }).click();
  await prom.waitForTimeout(1500); // Prometheus 頁面持續輪詢，不會進入 networkidle
  await prom.waitForTimeout(1000);
}

test('TC-C02-01 監控目標', async ({ browser }) => {
  const tc = 'TC-C02-01';
  test.setTimeout(6 * 60_000);
  const { ctx, page } = await userPage(browser, 'admin01');
  const prom = await openTool(page, 'Prometheus');
  await shot(page, tc, '00-系統監控入口');
  // 上方「Status」→「Target health」
  await prom.getByRole('button', { name: /^Status/ }).first().click();
  await prom.getByRole('menuitem', { name: /Target health/ }).click();
  await expect(prom).toHaveURL(/\/targets/);
  await prom.waitForTimeout(1500); // Prometheus 頁面持續輪詢，不會進入 networkidle
  await prom.waitForTimeout(2000);
  const body = await prom.locator('body').innerText();
  const pools = [...body.matchAll(/(\d+)\s*\/\s*(\d+)\s*up/gi)].map((m) => [Number(m[1]), Number(m[2])]);
  const notUp = pools.filter(([a, b]) => a !== b).length;
  await prom.screenshot({ path: path.join(process.env.EVIDENCE_DIR || 'acceptance-evidence', tc, '01-Prometheus目標.png'), fullPage: true });
  note(tc, `Target health 畫面：${pools.length} 個抓取工作，未全部 UP 的 ${notUp} 個；畫面出現 DOWN ${/\bDOWN\b/.test(body) ? '有' : '無'}`);
  const t = sh(
    tc,
    'C02-01-targets',
    `curl -s 'http://127.0.0.1:39090/api/v1/targets?state=active' | python3 -c 'import sys,json;from collections import Counter
c=Counter((t["labels"]["job"],t["health"]) for t in json.load(sys.stdin)["data"]["activeTargets"])
[print(j,h,n) for (j,h),n in sorted(c.items())]'`,
  );
  sh(tc, 'C02-01-workloads', 'kubectl get deploy,statefulset,daemonset -A');
  const cov = sh(tc, 'C02-01-coverage', 'uv run python -m compliance monitoring', path.join(REPO, 'platform/compliance'));
  const last = cov.out.trim().split('\n').filter((l) => /TC-DAILY-02/.test(l)).pop() ?? cov.out.trim().split('\n').pop();
  const down = t.out.split('\n').filter((l) => / (down|unknown) /.test(l));
  note(tc, `抓取目標（job 健康 數量）：${t.out.trim().split('\n').join('；')}`);
  note(tc, `覆蓋檢查：${last}`);
  expect(down).toEqual([]);
  expect(notUp).toBe(0);
  expect(last).toMatch(/^PASS\s+TC-DAILY-02.*未覆蓋 0；目標異常 0；節點缺口 0/);
  await prom.close();
  await ctx.close();
});

const kubeNum = (s: string) => Number(s.trim());
const memBytes = (s: string) => {
  const m = /^(\d+)(Ki|Mi|Gi)?$/.exec(s.trim());
  if (!m) return NaN;
  return Number(m[1]) * ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 }[m[2] ?? ''] ?? 1);
};
const cpuCores = (s: string) => (s.endsWith('m') ? Number(s.slice(0, -1)) / 1000 : Number(s));

test('TC-C02-02 5 類指標（抽查 3 次）', async ({ browser }) => {
  const tc = 'TC-C02-02';
  test.setTimeout(10 * 60_000);
  const { ctx, page } = await userPage(browser, 'admin01');
  const prom = await openTool(page, 'Prometheus');
  const rows: string[] = ['次｜類別｜Prometheus｜kubectl｜差異'];
  let totalDiff = 0;
  for (let round = 1; round <= 3; round++) {
    const file = `C02-02-第${round}次`;
    const add = (cat: string, p: string, k: string, same: boolean) => {
      rows.push(`${round}｜${cat}｜${p}｜${k}｜${same ? 0 : 1}`);
      if (!same) totalDiff++;
    };
    // 1–2 節點
    await runQuery(prom, 'count(kube_node_info)');
    await shot(prom, tc, `${round}-01-節點數`);
    const pn = promQuery('count(kube_node_info)')[0].value[1];
    const kn = sh(tc, file, 'kubectl get nodes --no-headers | wc -l').out.trim();
    add('節點', pn, kn, kubeNum(pn) === kubeNum(kn));
    // 3 Pod（劇本：差 1 多半是查詢之間有 Pod 建立／刪除，重查一次並註明）
    let pp = '';
    let kp = '';
    for (let tries = 0; tries < 2; tries++) {
      await runQuery(prom, 'count(kube_pod_info{namespace="ai-platform"})');
      pp = promQuery('count(kube_pod_info{namespace="ai-platform"})')[0].value[1];
      kp = sh(tc, file, 'kubectl -n ai-platform get pods --no-headers | wc -l').out.trim();
      if (kubeNum(pp) === kubeNum(kp)) break;
      rows.push(`${round}｜Pod（重查前）｜${pp}｜${kp}｜重查`);
      await prom.waitForTimeout(5000);
    }
    await shot(prom, tc, `${round}-02-Pod數`);
    add('Pod', pp, kp, kubeNum(pp) === kubeNum(kp));
    // 4 CPU、記憶體（api 容器）
    const q4 =
      'kube_pod_container_resource_requests{namespace="ai-platform",pod=~"api-.*",resource="cpu"} or kube_pod_container_resource_limits{namespace="ai-platform",pod=~"api-.*",resource="memory"}';
    await runQuery(prom, q4);
    await shot(prom, tc, `${round}-03-CPU與記憶體`);
    const r4 = promQuery(q4);
    const pc = r4.find((r) => r.metric.resource === 'cpu')?.value[1] ?? '';
    const pm = r4.find((r) => r.metric.resource === 'memory')?.value[1] ?? '';
    const res = JSON.parse(
      sh(tc, file, `kubectl -n ai-platform get pod -l app=api -o jsonpath='{.items[0].spec.containers[0].resources}{"\\n"}'`).out.trim(),
    ) as { requests: { cpu: string }; limits: { memory: string } };
    add('CPU（api requests）', pc, res.requests.cpu, Number(pc) === cpuCores(res.requests.cpu));
    add('記憶體（api limits）', pm, res.limits.memory, Number(pm) === memBytes(res.limits.memory));
    // 5 節點 CPU 核數與記憶體
    const q5 = 'kube_node_status_capacity{resource=~"cpu|memory"}';
    await runQuery(prom, q5);
    await shot(prom, tc, `${round}-04-節點CPU與記憶體`);
    const r5 = promQuery(q5);
    const kc = sh(tc, file, `kubectl get nodes -o custom-columns='節點:.metadata.name,CPU:.status.capacity.cpu,記憶體:.status.capacity.memory'`)
      .out.trim()
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/));
    let nodeDiff = 0;
    for (const [n, cpu, mem] of kc) {
      const c = r5.find((r) => r.metric.node === n && r.metric.resource === 'cpu')?.value[1];
      const m = r5.find((r) => r.metric.node === n && r.metric.resource === 'memory')?.value[1];
      if (Number(c) !== cpuCores(cpu) || Number(m) !== memBytes(mem)) nodeDiff++;
    }
    add('節點 CPU／記憶體', `${r5.length / 2} 節點 cpu ${r5.find((r) => r.metric.resource === 'cpu')?.value[1]}、memory ${r5.find((r) => r.metric.resource === 'memory')?.value[1]}`, `${kc.length} 節點 ${kc[0]?.[1]}、${kc[0]?.[2]}`, nodeDiff === 0);
    // 6 實際使用量（第 1 次切到 Graph 看曲線）
    if (round === 1) {
      const q6 = 'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="ai-platform",container!=""}[1m]))';
      await runQuery(prom, q6);
      const graphTab = prom.getByRole('tab', { name: /^Graph$/ });
      if (await graphTab.count()) await graphTab.click();
      await prom.waitForTimeout(2000);
      await shot(prom, tc, '1-05-CPU使用量曲線');
      const series = promQuery(q6).length;
      const running = sh(tc, file, 'kubectl -n ai-platform get pods --no-headers --field-selector=status.phase=Running | wc -l').out.trim();
      rows.push(`1｜CPU 使用量（曲線數／執行中 Pod）｜${series}｜${running}｜${series >= kubeNum(running) ? 0 : 1}`);
      if (series < kubeNum(running)) totalDiff++;
    }
    // 7 GPU 份數
    const q7 = 'kube_node_status_capacity{resource="nvidia_com_gpu"}';
    await runQuery(prom, q7);
    await shot(prom, tc, `${round}-06-GPU份數`);
    const r7 = promQuery(q7);
    const kg = sh(tc, file, String.raw`kubectl get nodes -o custom-columns='節點:.metadata.name,GPU:.status.capacity.nvidia\.com/gpu'`)
      .out.trim()
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter(([, g]) => g !== '<none>');
    const pg = r7.map((r) => `${r.metric.node}=${r.value[1]}`).sort().join('、');
    const kgs = kg.map(([n, g]) => `${n}=${g}`).sort().join('、');
    add('GPU（份數）', pg, kgs, pg === kgs);
    if (round < 3) await prom.waitForTimeout(10_000);
  }
  sh(tc, 'C02-02-比對表', `cat <<'EOF'\n${rows.join('\n')}\nEOF`);
  note(tc, `3 次 × 5 類比對完成，差異 ${totalDiff}（GPU 使用率、顯存、溫度需甲方 DCGM，開發環境不驗）`);
  // 劇本步驟 9（選做）：Grafana「平台叢集總覽」截圖放在 TC-C02-03 一起做（同一個 Grafana 登入）
  expect(totalDiff).toBe(0);
  await prom.close();
  await ctx.close();
});

async function grafanaLogin(g: Page) {
  if (/\/login/.test(g.url())) {
    await g.locator('input[name="user"]').fill('admin');
    await g.locator('input[name="password"]').fill(GRAFANA_PW);
    await g.getByRole('button', { name: /^Log in$/ }).click();
    const skip = g.getByRole('button', { name: /^Skip$/ });
    await skip.click({ timeout: 3000 }).catch(() => undefined);
  }
  await expect(g).not.toHaveURL(/\/login/);
}

test('TC-C02-03 客製儀表板（匯入、改更新頻率、重新載入一致）', async ({ browser }) => {
  const tc = 'TC-C02-03';
  test.setTimeout(8 * 60_000);
  // 上次中斷留下的測試儀表板先刪除（劇本：uid 已存在時先刪除）
  const left = q(`curl -s -o /dev/null -w '%{http_code}' -u 'admin:${GRAFANA_PW}' ${GRAFANA}/api/dashboards/uid/${DASH_UID}`);
  if (left === '200') {
    q(`curl -s -X DELETE -u 'admin:${GRAFANA_PW}' ${GRAFANA}/api/dashboards/uid/${DASH_UID}`);
    note(tc, '刪除上次演練留下的測試儀表板');
  }
  const { ctx, page } = await userPage(browser, 'admin01');
  const g = await openTool(page, 'Grafana');
  await shot(page, tc, '00-系統監控入口');
  await grafanaLogin(g);
  // 選做（TC-C02-02 步驟 9）：Dashboards → 資料夾「平台」→「平台叢集總覽」
  await g.goto(`${GRAFANA}/dashboards`);
  await g.getByRole('link', { name: '平台', exact: true }).first().click();
  await g.getByRole('link', { name: '平台叢集總覽' }).first().click();
  await g.waitForTimeout(1500);
  await g.waitForTimeout(3000);
  await shot(g, 'TC-C02-02', '05-Grafana平台叢集總覽');
  // 1–4：Dashboards → New → Import dashboard，上傳 JSON
  await g.goto(`${GRAFANA}/dashboards`);
  await g.getByRole('button', { name: 'New', exact: true }).last().click();
  await g.getByRole('menuitem', { name: 'Import dashboard' }).click();
  await expect(g).toHaveURL(/\/dashboard\/import/);
  await g.locator('input[type="file"]').first().setInputFiles(path.join(KIT, 'files/TC-C02-03-驗收儀表板.json'));
  await expect(g.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(DASH_TITLE);
  await expect(g.getByRole('button', { name: /^Select folder: Dashboards/ })).toBeVisible();
  await shot(g, tc, '01-匯入JSON');
  await g.getByRole('button', { name: 'Import', exact: true }).last().click();
  await expect(g).toHaveURL(new RegExp(`/d/${DASH_UID}`));
  // 5：2 個面板、更新頻率 10s
  await expect(g.getByText('各命名空間 Pod 記憶體使用').first()).toBeVisible();
  await expect(g.getByText('GPU 可分配份數').first()).toBeVisible();
  await g.waitForTimeout(4000);
  await shot(g, tc, '02-匯入後2個面板');
  const refreshBefore = new URL(g.url()).searchParams.get('refresh');
  note(tc, `匯入後網址 refresh=${refreshBefore}`);
  // 6–7：Edit → 更新頻率選 1m → Save（勾 Update default refresh value）→ Exit edit
  const picker = g.getByRole('button', { name: /^Choose refresh time interval/ });
  await expect(picker).toHaveText('10s');
  await g.getByRole('button', { name: 'Enter edit mode' }).click(); // 畫面文字「Edit」
  await picker.click();
  await g.getByRole('menuitemradio', { name: '1 minute' }).click(); // 畫面文字「1m」
  await expect(picker).toHaveText('1m');
  await g.getByRole('button', { name: 'Save', exact: true }).click();
  const dlg = g.getByRole('dialog', { name: 'Save dashboard' });
  await dlg.getByRole('checkbox', { name: /Update default refresh value/ }).check({ force: true });
  await expect(dlg.getByRole('checkbox', { name: /Update default refresh value/ })).toBeChecked();
  await shot(g, tc, '03-更新頻率改1m後儲存');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dlg).toBeHidden();
  await g.getByRole('button', { name: 'Exit edit mode' }).click(); // 畫面文字「Exit edit」
  // 8：回 Dashboards 列表重新點開
  await g.goto(`${GRAFANA}/dashboards`);
  await g.getByRole('link', { name: DASH_TITLE }).first().click();
  await expect(g).toHaveURL(new RegExp(`/d/${DASH_UID}`));
  await g.waitForTimeout(3000);
  await shot(g, tc, '04-重新載入後');
  const refreshAfter = new URL(g.url()).searchParams.get('refresh');
  const panelsOk = (await g.getByText('各命名空間 Pod 記憶體使用').count()) > 0 && (await g.getByText('GPU 可分配份數').count()) > 0;
  // 9：比對後端
  const api = sh(
    tc,
    'C02-03',
    `curl -s -u 'admin:${GRAFANA_PW}' ${GRAFANA}/api/dashboards/uid/${DASH_UID} | python3 -c 'import sys,json;d=json.load(sys.stdin)["dashboard"];print(d["refresh"],[(p["type"],p["title"]) for p in d["panels"]])'`,
  );
  note(tc, `重新載入後網址 refresh=${refreshAfter}、2 個面板 ${panelsOk}；後端：${api.out.trim()}`);
  // 10：驗收後刪除（劇本：Edit → Settings → Delete dashboard；Grafana 13 編輯模式沒有「Settings」按鈕，改走設定頁網址 editview=settings）
  let deleted = false;
  try {
    await g.getByRole('button', { name: 'Enter edit mode' }).click();
    const settings = g.getByRole('button', { name: 'Settings', exact: true });
    if (await settings.count()) await settings.click();
    else {
      note(tc, 'Grafana 13 編輯模式沒有「Settings」按鈕，改開 ?editview=settings（設定頁 General 分頁）');
      await g.goto(`${GRAFANA}/d/${DASH_UID}?editview=settings`);
    }
    await g.getByRole('button', { name: 'Delete dashboard' }).click();
    const del = g.getByRole('dialog', { name: 'Delete' });
    await del.getByRole('textbox', { name: 'Type "Delete" to confirm' }).fill('Delete');
    await shot(g, tc, '05-刪除確認');
    await del.getByRole('button', { name: 'Delete', exact: true }).click();
    await g.waitForTimeout(2000);
    deleted = q(`curl -s -o /dev/null -w '%{http_code}' -u 'admin:${GRAFANA_PW}' ${GRAFANA}/api/dashboards/uid/${DASH_UID}`) === '404';
  } catch (e) {
    note(tc, `介面刪除失敗，改用劇本的 curl 刪除：${String(e).slice(0, 120)}`);
  }
  if (!deleted) {
    sh(tc, 'C02-03-刪除', `curl -s -X DELETE -u 'admin:${GRAFANA_PW}' ${GRAFANA}/api/dashboards/uid/${DASH_UID}`);
  }
  note(tc, `測試儀表板已刪除（${deleted ? '介面' : 'curl'}）`);
  expect(refreshBefore).toBe('10s');
  expect(refreshAfter).toBe('1m');
  expect(panelsOk).toBeTruthy();
  expect(api.out.trim()).toBe("1m [('timeseries', '各命名空間 Pod 記憶體使用'), ('gauge', 'GPU 可分配份數')]");
  await g.close();
  await ctx.close();
});
