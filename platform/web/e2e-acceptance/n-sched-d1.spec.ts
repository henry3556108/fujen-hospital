import { test, type BrowserContext, type Page } from '@playwright/test';
import { schedulingTab } from './ops';
import { COMPOSE_DIR, KUBE, REPO, Scenario, apiOk, expect, openAs, shellRaw } from './n-sched-common';

// 新功能情境 D1：GPU 共享池扣除常駐服務的份數（docs/05-新增功能使用情境.md）。
// 開發環境（compose＋kind）沒有設定 GPU_SHARED_RESERVED（＝0），所以只能驗證「配額＝實體張數 × 份數 − 0」；
// 正式環境 production overlay 設 GPU_SHARED_RESERVED=2，扣除邏輯由單元測試 test_configure_shared_subtracts_resident_services 驗證
// （本情境會執行該單元測試並存證）。不改 api 環境變數、不重建容器。結束時把共享排程設定改回原值。
// 執行：npx playwright test -c playwright.acceptance.config.ts n-sched-d1.spec.ts -g D1 --headed

const PATH_SETTINGS = '/api/admin/cluster/shared-scheduling';

interface Settings {
  time_slice_replicas: number;
  job_timeout_minutes: number;
}

function quota(): number {
  const out = shellRaw(
    `kubectl --context ${KUBE} get clusterqueue gpu-shared -o jsonpath='{range .spec.resourceGroups[*].flavors[*].resources[?(@.name=="nvidia.com/gpu")]}{.nominalQuota}{end}'`,
  ).out.trim();
  return Number(out);
}

async function save(page: Page, v: Settings) {
  const form = page.getByRole('form', { name: '修改共享排程設定' });
  await form.getByLabel('時間片份數（1–16）').fill(String(v.time_slice_replicas));
  await form.getByLabel('工作時限（分鐘，1–1440）').fill(String(v.job_timeout_minutes));
  await form.getByRole('button', { name: '儲存設定' }).click();
  const msg = page.getByRole('status').filter({ hasText: `已儲存：時間片 ${v.time_slice_replicas} 份、工作時限 ${v.job_timeout_minutes} 分鐘` });
  await expect(msg).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('current-replicas')).toHaveText(String(v.time_slice_replicas));
  await expect(page.getByTestId('current-timeout')).toHaveText(String(v.job_timeout_minutes));
  return (await msg.innerText()).trim();
}

test('D1 GPU 共享池扣除常駐服務的份數（共享排程設定與 Kueue 配額）', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const s = new Scenario('D1', 'GPU 共享池同時跑常駐服務與訓練');
  const ctxs: BrowserContext[] = [];
  let original: Settings | null = null;
  await s.run(
    async () => {
      original = (await apiOk('admin01', 'GET', PATH_SETTINGS)) as Settings;
      s.log(`目前設定（API）：時間片 ${original.time_slice_replicas} 份、工作時限 ${original.job_timeout_minutes} 分鐘`);

      // 1. 維運人員確認 GPU_SHARED_RESERVED：正式環境 overlay 與目前 api 容器
      s.shell('正式環境 production overlay 的 GPU_SHARED_RESERVED', `grep -n -B2 -A2 GPU_SHARED_RESERVED platform/deploy/k8s/overlays/production/kustomization.yaml`);
      const env = s.shell(
        '開發環境 api 容器的 GPU_SHARED_RESERVED（未設定＝0）',
        `docker compose -p ai-platform -f compose.yaml exec -T api printenv GPU_SHARED_RESERVED || echo '（未設定）'`,
        { cwd: COMPOSE_DIR },
      );
      const reserved = Number(/^\s*(\d+)\s*$/m.exec(env.out)?.[1] ?? 0);
      const nodes = s.shell(
        'kind：共享池節點的實體 GPU 張數與宣告份數',
        `kubectl --context ${KUBE} get nodes -l platform/pool=gpu-shared -o jsonpath='{range .items[*]}{.metadata.name} 實體={.metadata.labels.platform/gpu-physical} 宣告={.status.capacity.nvidia\\.com/gpu}{"\\n"}{end}'`,
      );
      const physical = [...nodes.out.matchAll(/實體=(\d*)/g)].reduce((sum, m) => sum + Math.max(1, Number(m[1] || 1)), 0);
      s.shell('kind：ClusterQueue gpu-shared 目前配額', `kubectl --context ${KUBE} get clusterqueue gpu-shared -o jsonpath='{.spec.resourceGroups[0].flavors[0].resources}{"\\n"}'`);
      const q0 = quota();
      s.log(`共享池實體 GPU ${physical} 張；常駐服務扣除 ${reserved} 份；目前配額 nvidia.com/gpu = ${q0}（預期 ${physical}×${original.time_slice_replicas}−${reserved}＝${physical * original.time_slice_replicas - reserved}）`);
      expect.soft(q0).toBe(Math.max(0, physical * original.time_slice_replicas - reserved));

      // 2. 帳號管理 → 共享排程設定：目前設定
      const ad = await openAs(browser, 'admin01');
      ctxs.push(ad.ctx);
      await schedulingTab(ad.page, '共享排程設定');
      await expect(ad.page.getByTestId('current-replicas')).toHaveText(String(original.time_slice_replicas));
      await expect(ad.page.getByTestId('current-timeout')).toHaveText(String(original.job_timeout_minutes));
      await s.step(ad.page, '共享排程設定-目前設定', `時間片份數 ${original.time_slice_replicas}、工作時限 ${original.job_timeout_minutes} 分鐘`, { full: true });

      // 3～4. 修改設定並儲存
      const next: Settings = {
        time_slice_replicas: original.time_slice_replicas === 3 ? 5 : 3,
        job_timeout_minutes: original.job_timeout_minutes === 45 ? 50 : 45,
      };
      const form = ad.page.getByRole('form', { name: '修改共享排程設定' });
      await form.getByLabel('時間片份數（1–16）').fill(String(next.time_slice_replicas));
      await form.getByLabel('工作時限（分鐘，1–1440）').fill(String(next.job_timeout_minutes));
      await s.step(ad.page, '修改設定-填入新值', `時間片 ${next.time_slice_replicas} 份、工作時限 ${next.job_timeout_minutes} 分鐘`, { full: true });
      const msg = await save(ad.page, next);
      await s.step(ad.page, '儲存設定-已儲存', msg, { full: true });

      // 平台同步佇列配額：配額＝實體張數 × 份數 − 常駐份數
      const q1 = quota();
      const want = Math.max(0, physical * next.time_slice_replicas - reserved);
      s.shell('kind：儲存後 ClusterQueue gpu-shared 配額', `kubectl --context ${KUBE} get clusterqueue gpu-shared -o jsonpath='{.spec.resourceGroups[0].flavors[0].resources}{"\\n"}'`);
      s.shell(
        'kind：儲存後共享池節點宣告的份數（實體 × 份數，常駐服務仍在節點上占用）',
        `kubectl --context ${KUBE} get nodes -l platform/pool=gpu-shared -o jsonpath='{range .items[*]}{.metadata.name} 宣告={.status.capacity.nvidia\\.com/gpu}{"\\n"}{end}'`,
      );
      s.log(`儲存後配額 ${q1}（預期 ${physical}×${next.time_slice_replicas}−${reserved}＝${want}）`);
      expect.soft(q1).toBe(want);
      s.psql('稽核：共享排程設定修改', `select id, actor, category, action, result, detail from audit_log where action = 'shared_scheduling.update' order by id desc limit 1`);

      // 正式環境的扣除（GPU_SHARED_RESERVED=2）以單元測試驗證
      const unit = s.shell(
        '單元測試：共享池配額扣除常駐服務（GPU_SHARED_RESERVED）',
        `uv run pytest -q tests/scheduling/test_sched_kube.py -k test_configure_shared_subtracts_resident_services 2>&1 | tail -5`,
        { cwd: `${REPO}/platform/api`, timeout: 300_000 },
      );
      expect.soft(unit.out).toMatch(/1 passed/);

      // 還原原本的設定
      const back = await save(ad.page, original);
      const q2 = quota();
      s.log(`還原後配額 ${q2}（預期 ${physical * original.time_slice_replicas - reserved}）`);
      expect.soft(q2).toBe(Math.max(0, physical * original.time_slice_replicas - reserved));
      await s.step(ad.page, '還原原本設定', back, { full: true });
      original = null;

      s.partial(
        `開發環境沒有常駐服務扣除（GPU_SHARED_RESERVED 未設定＝${reserved}），只驗證配額＝實體 ${physical} 張 × 份數 − ${reserved}；` +
          '正式環境 overlay 設 GPU_SHARED_RESERVED=2，扣除 2 份由單元測試 test_configure_shared_subtracts_resident_services 驗證（見紀錄）',
      );
      return '儲存後 Kueue 配額依份數同步';
    },
    async () => {
      if (original) {
        await apiOk('admin01', 'PUT', PATH_SETTINGS, original);
        s.log(`清理：以 API 還原共享排程設定為時間片 ${original.time_slice_replicas} 份、工作時限 ${original.job_timeout_minutes} 分鐘`);
      }
      for (const c of ctxs) await c.close().catch(() => undefined);
    },
  );
});
