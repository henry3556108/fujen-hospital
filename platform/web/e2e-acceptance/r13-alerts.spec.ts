import { expect, test, type Page } from '@playwright/test';
import { P1, login, note, shot } from './helpers';
import { gotoJobs, q, sh, submitJob } from './ops';

// M1 補拍 13：異常告警（TC-C02-04）。3 類事件（工作失敗、CPU 過高、節點失聯）→ 3 條路由 → Mailpit 3 封，等候後不重複。
// 會暫停 ai-platform-worker4 約 3 分鐘、cpu-data 節點跑忙迴圈；無論成功失敗，最後一定恢復（unpause、刪 kit-cpu-burner、等節點 Ready）。
// 事件 1 的失敗工作送在 P1-lung-ct（不另建 KIT-C-p1 專案）。
const TC = 'TC-C02-04';
const PROM = 'http://127.0.0.1:39090';
const AM = 'http://127.0.0.1:39093';
const MAILPIT = 'http://127.0.0.1:38025';
const NAMES = ['PlatformJobFailed', 'HighPodCpu', 'NodeNotReady'];

type Group = { labels: Record<string, string>; receiver: { name: string }; alerts: { labels: Record<string, string> }[] };
const groups = (): Group[] => {
  try {
    return JSON.parse(q(`curl -s ${AM}/api/v2/alerts/groups`)) as Group[];
  } catch {
    return [];
  }
};
const firing = () => new Set(groups().flatMap((g) => g.alerts.map((a) => a.labels.alertname)));
type Mail = { Subject: string; From: { Address: string }; To: { Address: string }[]; Created: string };
const mails = (): Mail[] => {
  try {
    return (JSON.parse(q(`curl -s '${MAILPIT}/api/v1/messages?limit=50'`)) as { messages: Mail[] }).messages ?? [];
  } catch {
    return [];
  }
};

async function waitFor(page: Page, what: string, cond: () => boolean, maxSec: number) {
  const t0 = Date.now();
  while (!cond()) {
    if ((Date.now() - t0) / 1000 > maxSec) throw new Error(`等候逾時：${what}`);
    await page.waitForTimeout(5000);
  }
  return (Date.now() - t0) / 1000;
}

test('M1 補拍 13 異常告警（TC-C02-04）', async ({ browser }) => {
  test.setTimeout(25 * 60_000);
  // 前置：叢集閒置、沒有上一輪告警
  const before = [...firing()];
  note(TC, `開始前 Alertmanager 告警：${before.length ? before.join('、') : '無'}；platform-jobs 執行中 Pod ${q('kubectl -n platform-jobs get pods --no-headers --field-selector=status.phase=Running 2>/dev/null | wc -l')} 個`);
  expect(before.filter((n) => n === 'NodeNotReady' || n === 'HighPodCpu')).toEqual([]);

  const ctx = await browser.newContext();
  const tool = await ctx.newPage();
  const admin = await (await browser.newContext()).newPage();
  try {
    // 1 Prometheus 告警規則
    await tool.goto(`${PROM}/alerts`);
    await tool.waitForLoadState('load'); await tool.waitForTimeout(2000);
    for (const n of NAMES) await expect(tool.getByText(n).first()).toBeVisible();
    await shot(tool, TC, '01-Prometheus告警規則');
    note(TC, `Prometheus Alerts 頁有 3 條規則：${NAMES.join('、')}`);

    // 2 Alertmanager Status 的 route
    await tool.goto(`${AM}/#/status`);
    await tool.waitForLoadState('load'); await tool.waitForTimeout(2000);
    const cfg = tool.locator('pre').filter({ hasText: 'routes:' }).first();
    await expect(cfg).toBeVisible();
    const cfgText = await cfg.innerText();
    const routeLines = cfgText.split('\n').filter((l) => /category/.test(l)).map((l) => l.trim());
    // 捲到 route: 那一段
    await tool.evaluate(() => {
      const pre = Array.from(document.querySelectorAll('pre')).find((p) => p.textContent?.includes('routes:'));
      if (!pre) return;
      const idx = pre.textContent!.indexOf('\nroute:');
      const lineH = parseFloat(getComputedStyle(pre).lineHeight) || 18;
      const lines = pre.textContent!.slice(0, idx).split('\n').length;
      window.scrollTo(0, pre.getBoundingClientRect().top + window.scrollY + lines * lineH - 40);
    });
    await shot(tool, TC, '02-Alertmanager三條發送路由');
    note(TC, `Alertmanager route 的 matchers：${routeLines.join('；')}`);
    expect(routeLines.join(' ')).toMatch(/job-failure/);
    expect(routeLines.join(' ')).toMatch(/resource/);
    expect(routeLines.join(' ')).toMatch(/node/);

    // 3 清空 Mailpit
    await tool.goto(MAILPIT);
    await tool.waitForLoadState('load'); await tool.waitForTimeout(2000);
    const delAll = tool.getByRole('button', { name: /Delete all/i }).first();
    let uiDeleted = false;
    if (await delAll.isVisible().catch(() => false)) {
      try {
        await delAll.click();
        const confirm = tool.locator('.modal.show, [role=dialog]').getByRole('button', { name: /^Delete$/ }).first();
        await confirm.click({ timeout: 5000 });
        uiDeleted = true;
        note(TC, 'Mailpit 按「Delete all」→ 對話框按「Delete」清空');
      } catch {
        uiDeleted = false;
      }
    }
    if (!uiDeleted) {
      sh(TC, 'TC-C02-04-terminal', `curl -s -X DELETE ${MAILPIT}/api/v1/messages`);
      note(TC, 'Mailpit 畫面的「Delete all」操作失敗或找不到，改用 API 清空');
    }
    await waitFor(tool, 'Mailpit 清空', () => mails().length === 0, 30);
    await tool.reload();
    await tool.waitForLoadState('load'); await tool.waitForTimeout(2000);
    await shot(tool, TC, '03-清空收件匣');
    note(TC, `Mailpit 已清空（${mails().length} 封）`);

    // 4 事件 1：送失敗工作
    await login(admin, 'admin01');
    await gotoJobs(admin, P1);
    const job = await submitJob(admin, { seconds: 5, fail: true });
    const tEvents = Date.now();
    await shot(admin, TC, '04-送出失敗工作');
    note(TC, `事件 1：在 ${P1} 送出 5 秒、勾「讓這件工作以失敗結束」的工作：${job.text}`);

    // 5、6 事件 2、3
    const e2 = sh(TC, 'TC-C02-04-terminal', 'kubectl apply -f docs/acceptance-kit/m1/files/TC-C02-04-cpu-burner.yaml');
    note(TC, `事件 2：${e2.out.trim()}`);
    const e3 = sh(TC, 'TC-C02-04-terminal', 'docker pause ai-platform-worker4 && date "+%F %T 已暫停 ai-platform-worker4"');
    note(TC, `事件 3：${e3.out.trim()}`);

    // 7 等 3 組告警出現在 Alertmanager（劇本：等 2 分鐘）
    await admin.waitForTimeout(120_000);
    const waited = await waitFor(tool, 'Alertmanager 3 類告警', () => NAMES.every((n) => firing().has(n)), 300);
    const g = groups().filter((x) => x.alerts.some((a) => NAMES.includes(a.labels.alertname)));
    await tool.goto(`${AM}/#/alerts`);
    await tool.waitForLoadState('load'); await tool.waitForTimeout(2000);
    await expect(tool.getByText('NodeNotReady').first()).toBeVisible();
    await shot(tool, TC, '05-Alertmanager三類告警');
    note(TC, `事件後 ${((Date.now() - tEvents) / 1000).toFixed(0)} 秒（等 2 分鐘後再等 ${waited.toFixed(0)} 秒）Alertmanager 告警群組 ${g.length} 組：${g.map((x) => `${JSON.stringify(x.labels)}→${x.receiver.name}`).join('；')}`);

    // 8 Mailpit 收到 3 封
    await waitFor(tool, 'Mailpit 3 封', () => mails().length >= 3, 180);
    await tool.goto(MAILPIT);
    await tool.waitForLoadState('load'); await tool.waitForTimeout(2000);
    const m1 = mails();
    await shot(tool, TC, '06-Mailpit收到3封');
    note(TC, `Mailpit 收到 ${m1.length} 封：${m1.map((m) => `${m.Created} ${m.Subject}`).join('；')}`);

    // 9 再等 2 分鐘，仍 3 封
    await tool.waitForTimeout(120_000);
    await tool.reload();
    await tool.waitForLoadState('load'); await tool.waitForTimeout(2000);
    const m2 = mails();
    await shot(tool, TC, '07-等候2分鐘後仍3封');
    sh(
      TC,
      'TC-C02-04-mails',
      `curl -s '${MAILPIT}/api/v1/messages?limit=50' | python3 -c 'import sys,json;[print(m["Created"], "|", m["From"]["Address"], "->", ",".join(t["Address"] for t in m["To"]), "|", m["Subject"]) for m in json.load(sys.stdin)["messages"]]'`,
    );
    const subj = m2.map((m) => m.Subject);
    const has = (re: RegExp) => subj.filter((s) => re.test(s)).length;
    const c1 = has(/PlatformJobFailed .*\(job-failure /);
    const c2 = has(/HighPodCpu platform-web .*kit-cpu-burner \(resource warning\)/);
    const c3 = has(/NodeNotReady ai-platform-worker4 \(node /);
    const senders = new Set(m2.map((m) => `${m.From.Address}->${m.To.map((t) => t.Address).join(',')}`));
    note(TC, `等候 2 分鐘後 Mailpit ${m2.length} 封；工作失敗 ${c1}、CPU 過高 ${c2}、節點失聯 ${c3}；寄件／收件 ${[...senders].join('、')}；送出 ${[c1, c2, c3].filter((c) => c >= 1).length}/3，重複 ${m2.length - 3}`);
    expect(m2.length).toBe(3);
    expect([c1, c2, c3]).toEqual([1, 1, 1]);
    expect([...senders]).toEqual(['alertmanager@ai-platform.local->ops@ai-platform.local']);
  } finally {
    // 10 恢復（失敗時也一定執行）
    const r = sh(
      TC,
      'TC-C02-04-terminal',
      'docker unpause ai-platform-worker4; kubectl -n platform-web delete pod kit-cpu-burner --grace-period=0 --ignore-not-found; kubectl wait --for=condition=Ready node --all --timeout=180s; kubectl get nodes',
    );
    note(TC, `恢復：${r.out.trim().split('\n').filter((l) => /condition met|deleted|ai-platform-/.test(l)).length} 行輸出，結束碼 ${r.code}`);
    await admin.goto('/admin/scheduling/nodes').catch(() => undefined);
    if (/\/login$/.test(admin.url())) await login(admin, 'admin01').then(() => admin.goto('/admin/scheduling/nodes'));
    await admin.waitForLoadState('networkidle');
    const ready = (await admin.getByRole('table', { name: '叢集節點列表' }).getByText('就緒', { exact: true }).count()) as number;
    await shot(admin, TC, '08-節點恢復');
    const burner = q('kubectl -n platform-web get pod kit-cpu-burner --no-headers 2>&1');
    note(TC, `叢集節點頁就緒 ${ready} 個；kit-cpu-burner：${burner || '已刪除'}`);
    await ctx.close();
    expect(r.code).toBe(0);
    expect(ready).toBe(5);
  }
});
