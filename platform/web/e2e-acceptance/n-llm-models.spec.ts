import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Scenario, REPO, api, contentHash, dc, llmBase, llmTab, okMsg, oneLine, outcome, resetModel, rowOf } from './n-bc-common';

// 新功能情境 B1–B4（docs/05-新增功能使用情境.md）：LLM 真模型的引進、離線預載、量化與資源、新環境預設模型。
// 角色：ca01（P1-lung-ct 的 Coding 權限）、admin01。B1 會真的從 Hugging Face 下載 nomic-embed-text-v1.5 的 Q4_K_M（約 84 MB）。
// 清理：B1、B2 的測試模型卸載、刪除並移出白名單；B3 還原 gemma-3-4b-it 的載入設定並確保已載入。

const HF_SMALL = { repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF', commit: '0188c9bf409793f810680a5a431e7b899c46104c', files: ['*Q4_K_M.gguf'] };
const B1_NAME = 'kit-nomic-small';
const B2_NAME = 'offline-small'; // 資料夾名稱須與白名單名稱相同（platform/deploy/local/llm/preload/offline-small）
const GEMMA = 'gemma-3-4b-it';

async function modelsPage(page: Page) {
  await llmTab(page, '模型管理');
  await expect(page.getByRole('table', { name: '白名單模型' })).toBeVisible();
}

const catalogRow = (page: Page, name: string) => rowOf(page.getByRole('table', { name: '白名單模型' }), name);

/** B1 第 2–5 步（B2 第 3 步共用）：研究員申請 → Admin 核准 → 研究員下載，直到「已下載」 */
async function requestApproveDownload(s: Scenario, ca: Page, adm: Page, name: string, n: (k: number) => string) {
  // 第 2 步：研究員在白名單看到新模型「未下載」，按「申請下載」
  await modelsPage(ca);
  const row = catalogRow(ca, name);
  await expect(row).toContainText('未下載');
  await s.step(ca, n(2), 'ca01-白名單看到新模型（未下載）', { line: oneLine(await row.innerText()), focus: row });
  await row.getByRole('button', { name: '申請下載' }).click();
  // 已知產品問題：申請後（pending）列上仍是「未下載」＋「申請下載」（ModelsPage.tsx 只認 approved／downloading）。
  // 記錄實際畫面，重新進入頁面再確認一次，然後繼續（不再按第二次，會 409）。
  await ca.waitForLoadState('networkidle');
  await s.step(ca, n(2), 'ca01-已按申請下載', { line: oneLine(await row.innerText()), focus: row });
  await s.soft('申請後該列不再顯示「申請下載」（應顯示待審核）', () => expect(row.getByRole('button', { name: '申請下載' })).toHaveCount(0, { timeout: 5000 }));
  if ((await row.getByRole('button', { name: '申請下載' }).count()) > 0) {
    await llmTab(ca, 'Playground');
    await modelsPage(ca);
    await s.step(ca, n(2), 'ca01-重新進入模型管理後的列', { line: oneLine(await row.innerText()), focus: row });
  }

  // 第 3 步：Admin 在「待審核的下載申請」看到「模型名稱（申請人 帳號）」，按「核准」
  await modelsPage(adm);
  const review = adm.getByRole('region', { name: '待審核的下載申請' });
  const item = review.locator('li', { hasText: `${name}（申請人 ca01）` });
  await expect(item).toBeVisible();
  await s.step(adm, n(3), 'admin01-待審核的下載申請', { line: oneLine(await item.innerText()), focus: review });
  await item.getByRole('button', { name: '核准' }).click();
  await expect(item).toHaveCount(0);
  await s.step(adm, n(3), 'admin01-已核准', { focus: adm.getByRole('table', { name: '白名單模型' }) });

  // 第 4 步：研究員回到「模型管理」，狀態「已核准，待下載」，按「下載」
  await llmTab(ca, 'Playground');
  await modelsPage(ca);
  await expect(row).toContainText('已核准，待下載');
  await s.step(ca, n(4), 'ca01-已核准，待下載', { line: oneLine(await row.innerText()), focus: row });
  await row.getByRole('button', { name: '下載', exact: true }).click();

  // 第 5 步：「下載中 NN%（X MB / Y MB）」每 3 秒更新，完成後「已下載」
  let progress = '';
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const t = oneLine(await row.innerText());
    if (/下載中/.test(t) && !progress) {
      progress = t;
      await s.step(ca, n(5), 'ca01-下載中', { line: t, focus: row });
    }
    if (/已下載|已載入|失敗/.test(t)) break;
    await ca.waitForTimeout(1000);
  }
  if (!progress) s.log(`${n(5)}｜沒有看到「下載中 NN%」：下載請求在等候時間內就完成（檔案小），畫面直接顯示「已下載」`);
  await expect(row).toContainText('已下載', { timeout: 30_000 });
  await s.step(ca, n(5), 'ca01-已下載', { line: oneLine(await row.innerText()), focus: row });
  return { row, sawProgress: !!progress };
}

/** 第 6 步：「下載紀錄」最新一筆（依編號由舊到新排列，取最後一列） */
async function downloadRecord(s: Scenario, ca: Page, name: string, label: string) {
  const rec = rowOf(ca.getByRole('table', { name: '下載紀錄' }), name).last();
  const text = oneLine(await rec.innerText());
  await s.step(ca, label, 'ca01-下載紀錄', { line: text, focus: rec });
  return { rec, text };
}

test('B1 從 Hugging Face 引進一個新模型', async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const s = new Scenario('B1', '從 Hugging Face 引進一個新模型');
  await s.run(
    async () => {
      // 第 1 步（維運代為執行，沒有網頁表單）：inspect 取得 sha256 → 登記白名單
      await resetModel(s, B1_NAME);
      const inspectBody = { source: 'huggingface.co', repo: HF_SMALL.repo, revision: HF_SMALL.commit, token: null, files: HF_SMALL.files };
      const seen = await api('admin01', 'POST', '/api/admin/llm/whitelist/inspect', inspectBody);
      s.raw(`POST /api/admin/llm/whitelist/inspect（admin01）\n${JSON.stringify(inspectBody)}\n→ HTTP ${seen.status}\n${JSON.stringify(seen.json, null, 2)}`);
      expect(seen.status, seen.text).toBe(200);
      const entry = {
        name: B1_NAME, source: 'huggingface.co', repo: HF_SMALL.repo, revision: seen.json.commit, sha256: seen.json.sha256,
        files: HF_SMALL.files, license: 'apache-2.0', note: '新功能測試 B1',
      };
      const wl = await api('admin01', 'POST', '/api/admin/llm/whitelist', entry);
      s.raw(`POST /api/admin/llm/whitelist（admin01）\n${JSON.stringify(entry)}\n→ HTTP ${wl.status}\n${wl.text}`);
      expect(wl.status, wl.text).toBe(201);
      s.log(`步驟 1｜以 Admin API 登記白名單：inspect HTTP 200（commit ${String(seen.json.commit).slice(0, 12)}、sha256 ${String(seen.json.sha256).slice(0, 12)}…），whitelist HTTP 201`);

      const ca = await s.open(browser, 'ca01');
      const adm = await s.open(browser, 'admin01');
      const { row, sawProgress } = await requestApproveDownload(s, ca, adm, B1_NAME, (k) => `步驟 ${k}`);

      // 第 6 步：下載紀錄有申請人、審核人、commit、hash
      const { text } = await downloadRecord(s, ca, B1_NAME, '步驟 6');
      await s.soft('下載紀錄顯示申請人 ca01、審核人 admin01、commit 與 hash', () => {
        expect(text).toContain('完成');
        expect(text).toContain('ca01');
        expect(text).toContain('admin01');
        expect(text).toContain(HF_SMALL.commit.slice(0, 8));
        expect(text).toContain(String(seen.json.sha256).slice(0, 12));
      });

      // 第 7 步：「模型名稱 載入與資源」按「載入」，狀態「已載入」
      const sec = ca.getByRole('region', { name: `${B1_NAME} 資源設定` });
      await expect(sec.getByRole('heading', { name: `${B1_NAME} 載入與資源` })).toBeVisible();
      await s.step(ca, '步驟 7', 'ca01-載入與資源區塊', { focus: sec });
      await sec.getByRole('button', { name: '載入', exact: true }).click();
      await expect(okMsg(sec, '已載入')).toBeVisible({ timeout: 180_000 });
      await expect(row).toContainText('已載入');
      const runtime = sec.locator(`[aria-label="${B1_NAME} 執行狀態"]`);
      await s.soft('載入後顯示模型服務回報的執行狀態', () => expect(runtime).toBeVisible({ timeout: 30_000 }));
      await s.step(ca, '步驟 7', 'ca01-已載入', { line: `${oneLine(await row.innerText())}；${(await runtime.textContent().catch(() => '')) ?? ''}`, focus: sec });
      await s.step(ca, '步驟 7', 'ca01-白名單狀態已載入', { line: oneLine(await row.innerText()), focus: row });
      return `inspect＋白名單登記、申請、核准、下載${sawProgress ? '（看到下載中進度）' : '（未看到下載中進度，下載瞬間完成）'}、下載紀錄、載入皆符合文件`;
    },
    async () => {
      await resetModel(s, B1_NAME); // 卸載、刪除模型、移出白名單，不占 GPU
    },
  );
});

test('B2 醫院沒有對外網路時引進模型', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const s = new Scenario('B2', '醫院沒有對外網路時引進模型');
  await s.run(
    async () => {
      await resetModel(s, B2_NAME);
      // 第 1–2 步：預載目錄的結構（模型名稱/manifest.json＋模型檔），compose 掛在 api 的 /opt/llm-preload
      const ls = await dc(
        s,
        `exec -T api sh -c 'echo LLM_PRELOAD_DIR=$LLM_PRELOAD_DIR; ls -la /opt/llm-preload /opt/llm-preload/${B2_NAME}; echo; cat /opt/llm-preload/${B2_NAME}/manifest.json'`,
      );
      await s.soft('api 容器內 /opt/llm-preload/offline-small 有 manifest.json（repo、commit）', () => {
        expect(ls.code).toBe(0);
        expect(ls.out).toContain('"commit"');
      });
      s.log('步驟 1–2｜預載目錄結構見上方指令輸出（offline-small/manifest.json＋config.json）');

      // 白名單：來源登記為連不到的 models.offline.invalid（模擬沒有對外網路），hash 依預載檔案計算
      const sha = contentHash(path.join(REPO, 'platform/deploy/local/llm/preload', B2_NAME));
      const probe = await api('admin01', 'POST', '/api/admin/llm/whitelist/inspect', {
        source: 'models.offline.invalid', repo: 'offline-org/offline-small', revision: '0ff1'.repeat(10), token: null, files: [],
      });
      s.log(`連不到來源的佐證：inspect models.offline.invalid → HTTP ${probe.status} ${probe.text.slice(0, 200)}`);
      const entry = {
        name: B2_NAME, source: 'models.offline.invalid', repo: 'offline-org/offline-small', revision: '0ff1'.repeat(10), sha256: sha,
        license: 'apache-2.0', note: '新功能測試 B2（離線預載）',
      };
      const wl = await api('admin01', 'POST', '/api/admin/llm/whitelist', entry);
      s.raw(`POST /api/admin/llm/whitelist（admin01）\n${JSON.stringify(entry)}\n→ HTTP ${wl.status}\n${wl.text}`);
      expect(wl.status, wl.text).toBe(201);

      // 第 3 步：照 B1 的第 2–7 步（申請、核准、下載）
      const ca = await s.open(browser, 'ca01');
      const adm = await s.open(browser, 'admin01');
      await requestApproveDownload(s, ca, adm, B2_NAME, (k) => `步驟 3（B1 第 ${k} 步）`);

      // 第 4 步：「下載紀錄」狀態「完成（離線預載）」
      const { text } = await downloadRecord(s, ca, B2_NAME, '步驟 4');
      await s.soft('下載紀錄顯示「完成（離線預載）」並記錄 commit 與 hash', () => {
        expect(text).toContain('完成（離線預載）');
        expect(text).toContain('0ff10ff1');
        expect(text).toContain(sha.slice(0, 12));
      });
      s.partialBecause(
        '共用的開發環境不能真的切斷 Hugging Face；改以白名單登記連不到的來源 models.offline.invalid 模擬沒有對外網路。repo 內的 offline-small 只有設定檔、沒有權重，所以不做 B1 第 7 步的「載入」',
      );
      return '預載目錄結構正確；申請、核准、下載後下載紀錄為「完成（離線預載）」，commit 與 hash 相符';
    },
    async () => {
      await resetModel(s, B2_NAME);
    },
  );
});

test('B3 調整模型的量化與資源', async ({ browser }) => {
  test.setTimeout(12 * 60_000);
  const s = new Scenario('B3', '調整模型的量化與資源');
  const base = await llmBase();
  const orig = (await api('ca01', 'GET', `${base}/models/${GEMMA}/load-config`)).json as Record<string, string | number>;
  const KEYS = ['quantization', 'cpu', 'memory_gb', 'gpu_type', 'gpu_count'] as const;
  s.log(`原始載入設定：${JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, orig[k]])))}`);
  await s.run(
    async () => {
      const ca = await s.open(browser, 'ca01');
      // 第 1 步：「模型管理」往下到「gemma-3-4b-it 載入與資源」
      await modelsPage(ca);
      const sec = ca.getByRole('region', { name: `${GEMMA} 資源設定` });
      await expect(sec.getByRole('heading', { name: `${GEMMA} 載入與資源` })).toBeVisible();
      const runtime = sec.locator(`[aria-label="${GEMMA} 執行狀態"]`);
      await expect(runtime).toBeVisible({ timeout: 30_000 });
      await s.step(ca, '步驟 1', '載入與資源（原始設定）', { line: (await runtime.textContent()) ?? '', focus: sec });

      // 第 2 步：修改欄位（量化 8-bit、CPU 4；記憶體、GPU 類型、GPU 張數維持）
      const field = (label: string) => sec.getByLabel(label, { exact: true });
      await field('量化').selectOption({ label: '8-bit' });
      await field('CPU').fill('4');
      const fields = `量化 ${await field('量化').inputValue()}、CPU ${await field('CPU').inputValue()}、記憶體 ${await field('記憶體（GB）').inputValue()} GB、GPU 類型 ${await field('GPU 類型').inputValue()}、GPU 張數 ${await field('GPU 張數').inputValue()}`;
      await s.step(ca, '步驟 2', '改成8-bit與CPU4', { line: fields, focus: sec });

      // 第 3 步：已載入 → 「套用並重新載入」→「已依新設定重新載入」
      // 已知產品問題：表單把 GET 回來的 name、updated_by、updated_at 一起 PUT，API（extra="forbid"）回 422，畫面顯示錯誤。
      await sec.getByRole('button', { name: '套用並重新載入' }).click();
      const applied = await outcome(sec, '已依新設定重新載入', 300_000);
      if (applied.ok) {
        // 第 4 步：模型服務回報的執行狀態
        await expect(runtime).toContainText('Q8_0', { timeout: 60_000 });
        const rt8 = (await runtime.textContent()) ?? '';
        await s.step(ca, '步驟 3–4', '已依新設定重新載入（8-bit）', { line: rt8, focus: sec });
        await s.soft('執行狀態為「量化 Q8_0、CPU 執行緒 4、在 GPU 上執行、顯示記憶體 N MB」', () => {
          expect(rt8).toContain('CPU 執行緒 4');
          expect(rt8).toContain('在 GPU 上執行');
          expect(rt8).toMatch(/顯示記憶體 \d+ MB/);
        });
      } else {
        await s.step(ca, '步驟 3', '套用並重新載入失敗', { line: applied.text, focus: sec });
        await s.soft('按「套用並重新載入」出現「已依新設定重新載入」', () => expect(applied.text).toContain('已依新設定重新載入'));
        s.log(`步驟 4｜未套用，執行狀態仍為：${(await runtime.textContent().catch(() => '')) ?? ''}`);
      }

      // 第 5 步：「卸載」→「已卸載」
      await sec.getByRole('button', { name: '卸載', exact: true }).click();
      await expect(okMsg(sec, '已卸載')).toBeVisible({ timeout: 120_000 });
      await expect(sec.getByRole('button', { name: '載入', exact: true })).toBeVisible();
      await s.step(ca, '步驟 5', '已卸載', { focus: sec });

      // 第 3 步的另一條路：未載入時改回原設定 →「儲存載入設定」→ 再按「載入」
      // （卸載後表單重新掛載、欄位回到資料庫的值；仍依原設定填一次）
      await field('量化').selectOption(String(orig.quantization));
      await field('CPU').fill(String(orig.cpu));
      await field('記憶體（GB）').fill(String(orig.memory_gb));
      await field('GPU 類型').selectOption(String(orig.gpu_type));
      await field('GPU 張數').fill(String(orig.gpu_count));
      await sec.getByRole('button', { name: '儲存載入設定' }).click();
      const saved = await outcome(sec, '已儲存載入設定', 30_000);
      await s.step(ca, '步驟 3（未載入）', saved.ok ? '改回原設定並儲存載入設定' : '儲存載入設定失敗', { line: saved.text, focus: sec });
      await s.soft('按「儲存載入設定」出現「已儲存載入設定」', () => expect(saved.text).toContain('已儲存載入設定'));
      await sec.getByRole('button', { name: '載入', exact: true }).click();
      await expect(okMsg(sec, '已載入')).toBeVisible({ timeout: 300_000 });
      await expect(runtime).toContainText('量化', { timeout: 60_000 });
      const rt4 = (await runtime.textContent()) ?? '';
      await s.step(ca, '步驟 3–4（未載入）', '再按載入（原設定）', { line: rt4, focus: sec });
      await s.soft(`還原後量化為原設定（${orig.quantization}）`, () =>
        expect(rt4).toContain(orig.quantization === '8bit' ? 'Q8_0' : orig.quantization === '4bit' ? 'Q4_K_M' : '量化'),
      );
      return applied.ok && saved.ok
        ? '8-bit＋CPU 4 套用並重新載入後執行狀態為 Q8_0；卸載、儲存載入設定、載入皆出現文件所列訊息；已改回原設定'
        : '卸載、載入正常；套用並重新載入／儲存載入設定在網頁上失敗（見差異）';
    },
    async () => {
      const now = (await api('ca01', 'GET', `${base}/models/${GEMMA}/load-config`)).json as Record<string, unknown>;
      if (KEYS.some((k) => now[k] !== orig[k])) {
        const r = await api('ca01', 'PUT', `${base}/models/${GEMMA}/load-config`, Object.fromEntries(KEYS.map((k) => [k, orig[k]])));
        s.log(`清理：還原 ${GEMMA} 載入設定 → HTTP ${r.status}`);
        const l = await api('ca01', 'POST', `${base}/models/${GEMMA}/load`);
        s.log(`清理：依原設定重新載入 ${GEMMA} → HTTP ${l.status}`);
      }
      const m = ((await api('ca01', 'GET', `${base}/models/catalog`)).json as { name: string; loaded: boolean }[]).find((x) => x.name === GEMMA);
      if (!m?.loaded) s.log(`清理：載入 ${GEMMA} → HTTP ${(await api('ca01', 'POST', `${base}/models/${GEMMA}/load`)).status}`);
      s.log(`清理後 ${GEMMA} 載入設定：${(await api('ca01', 'GET', `${base}/models/${GEMMA}/load-config`)).text}`);
    },
  );
});

test('B4 新環境一次裝好預設模型', async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  const s = new Scenario('B4', '新環境一次裝好預設模型');
  await s.run(async () => {
    // 第 1 步：api 能連到 huggingface.co 與 cas-bridge.xethub.hf.co（回 HTTP 狀態碼即代表連得到）
    const probe = await dc(
      s,
      `exec -T api /app/.venv/bin/python -c "
import urllib.request, urllib.error
for url in ('https://huggingface.co', 'https://cas-bridge.xethub.hf.co'):
    try:
        print(url, 'HTTP', urllib.request.urlopen(url, timeout=15).status)
    except urllib.error.HTTPError as e:
        print(url, 'HTTP', e.code, '(連得到，伺服器回應錯誤碼)')
    except Exception as e:
        print(url, '連不到', e)
"`,
    );
    await s.soft('api 連得到 huggingface.co 與 cas-bridge.xethub.hf.co', () => {
      expect(probe.out).not.toContain('連不到');
      expect(probe.out.match(/HTTP/g)?.length ?? 0).toBe(2);
    });
    s.log(`步驟 1｜對外連線：${oneLine(probe.out)}`);

    // 第 2–3 步：執行 model_setup（可重複執行，已完成的步驟會略過）
    const setup = await dc(s, 'exec -T api /app/.venv/bin/python -m app.llm.model_setup /opt/llm-models.json', { timeoutMs: 12 * 60_000 });
    s.log(`步驟 2–3｜model_setup 結束碼 ${setup.code}：${oneLine(setup.out)}`);
    expect(setup.code).toBe(0);
    await s.soft('model_setup 印出兩個模型「已載入」', () => {
      expect(setup.out).toMatch(/gemma-3-4b-it：已載入/);
      expect(setup.out).toMatch(/embeddinggemma-300m：已載入/);
    });
    // 要注意：每一步以 system-setup 身分寫進稽核
    const audit = await dc(
      s,
      `exec -T postgres psql -U platform -d platform -c "select id, at, actor, action, target, result from audit_log where actor = 'system-setup' order by id desc limit 8"`,
    );
    await s.soft('稽核有 system-setup 的紀錄', () => expect(audit.out).toContain('system-setup'));

    // 第 4 步：網頁確認兩個模型都「已載入」
    const ca = await s.open(browser, 'ca01');
    await modelsPage(ca);
    const table = ca.getByRole('table', { name: '白名單模型' });
    for (const m of [GEMMA, 'embeddinggemma-300m']) await expect(rowOf(table, m)).toContainText('已載入');
    await s.step(ca, '步驟 4', '兩個預設模型已載入', {
      line: `${oneLine(await rowOf(table, GEMMA).innerText())}；${oneLine(await rowOf(table, 'embeddinggemma-300m').innerText())}`,
      focus: table,
    });
    return 'model_setup 結束碼 0、兩個模型已載入，網頁「模型管理」兩列皆為「已載入」';
  });
});
