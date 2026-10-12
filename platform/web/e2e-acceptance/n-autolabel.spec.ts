import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { CT_DIR, Scenario, api, clickMenu, dc, oneLine, projectId, selectContaining, sh } from './n-bc-common';

// 新功能情境 C1–C2（docs/05-新增功能使用情境.md）：真實自動標註工具 MONAI Label。
// C1：md01（P1-lung-ct 的 Labeling 權限）對腹部 CT（MSD Spleen，AUTOLABEL_CT_DIR）用 segmentation_spleen 自動標註，
//     到工作台以筆刷修正並儲存，再從「執行紀錄」開回來。結束時刪除這筆分割標註（執行紀錄會留著）。
// C2：以完整 compose 組合加減 compose.monai.yaml 切換 MONAI／假服務；結束時一定換回 MONAI。
// 前提：compose 環境以 compose.monai.yaml 啟動（scratchpad/testall-monai.sh 的組合），影像已建好（platform-*:dev）。

interface CtInstance {
  file: string;
  sop_instance_uid: string;
  instance_number: number;
  spleen_pixels: number;
}
interface CtStudy {
  accession_number: string;
  study_instance_uid: string;
  instances: CtInstance[];
}

const manifest = () => JSON.parse(fs.readFileSync(path.join(CT_DIR, 'manifest.json'), 'utf8')) as { studies: CtStudy[] };

/** 匯入腹部 CT 的第一個研究（已在 P1 就略過），回傳研究與「有脾臟的切面中間那張」的序號（第 N 張） */
async function ensureCt(s: Scenario) {
  const study = manifest().studies[0];
  const pid = await projectId();
  const summary = await api('md01', 'GET', `/api/projects/${pid}/labels/summary`);
  const present = (summary.json.studies as { study_instance_uid: string }[]).some((x) => x.study_instance_uid === study.study_instance_uid);
  if (present) s.log(`前提：腹部 CT ${study.accession_number} 已在 P1-lung-ct`);
  else {
    const files = study.instances.map((i) => path.join(CT_DIR, i.file));
    for (let start = 0; start < files.length; start += 20) {
      const form = new FormData();
      for (const f of files.slice(start, start + 20)) form.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));
      const r = await api('ra01', 'POST', `/api/projects/${pid}/imaging/dicom`, undefined, form);
      expect(r.status, r.text).toBe(201);
    }
    s.log(`前提：以 ra01 經 API 匯入腹部 CT ${study.accession_number}（${files.length} 張）到 P1-lung-ct`);
  }
  const ordered = [...study.instances].sort((a, b) => a.instance_number - b.instance_number);
  const withSpleen = ordered.filter((i) => i.spleen_pixels > 0);
  const middle = withSpleen[Math.floor(withSpleen.length / 2)];
  const position = ordered.findIndex((i) => i.sop_instance_uid === middle.sop_instance_uid) + 1;
  s.log(`選擇切面：第 ${position} 張（instance ${middle.instance_number}，標準答案脾臟 ${middle.spleen_pixels} 像素；有脾臟的切面共 ${withSpleen.length} 張）`);
  return { study, position, pid };
}

const maskCount = async (page: Page) => Number(/已塗 (\d+) 個像素/.exec(await page.getByTestId('mask-info').innerText())?.[1] ?? 0);

async function autolabelPage(page: Page) {
  await clickMenu(page, '自動影像分類標註');
  await expect(page.getByRole('heading', { level: 1, name: '自動影像分類標註' })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

test('C1 用 MONAI Label 自動標出器官再由醫師修正', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const s = new Scenario('C1', '用 MONAI Label 自動標出器官再由醫師修正');
  let annotationId = 0;
  let pid = 0;
  await s.run(
    async () => {
      const ct = await ensureCt(s);
      pid = ct.pid;
      const md = await s.open(browser, 'md01');

      // 第 1 步：左側選單「自動影像分類標註」
      await autolabelPage(md);
      await s.step(md, '步驟 1', '自動影像分類標註頁');

      // 第 2 步：模型 segmentation_spleen、研究（依 Accession）、影像「第 N 張」
      const form = md.getByRole('form', { name: '送出自動標註' });
      await form.getByLabel('模型', { exact: true }).selectOption({ label: 'segmentation_spleen（分割：spleen）' });
      await selectContaining(form.getByLabel('研究', { exact: true }), ct.study.accession_number);
      const image = form.getByLabel('影像', { exact: true });
      await expect(image).toBeEnabled({ timeout: 60_000 });
      await expect(image.locator('option')).toHaveCount(ct.study.instances.length, { timeout: 60_000 });
      await image.selectOption({ label: `第 ${ct.position} 張` });
      const chosen = `模型 ${await form.getByLabel('模型', { exact: true }).locator('option:checked').innerText()}｜研究 ${oneLine(await form.getByLabel('研究', { exact: true }).locator('option:checked').innerText())}｜影像 第 ${ct.position} 張`;
      await s.step(md, '步驟 2', '選擇模型研究影像', { line: chosen, focus: form });

      // 第 3 步：按「送出自動標註」，按鈕顯示「標註中…」
      await form.getByRole('button', { name: '送出自動標註' }).click();
      const busy = form.getByRole('button', { name: '標註中…' });
      if (await busy.isVisible().catch(() => false)) await s.step(md, '步驟 3', '標註中', { focus: form });
      else s.log('步驟 3｜按鈕「標註中…」出現時間太短（同序列已有快取），未能截到');

      // 第 4 步：「自動標註完成：已存為分割標註 #N（耗時 X 毫秒）。」→「在標註工作台開啟編輯」
      const result = md.getByTestId('autolabel-result');
      await expect(result).toContainText(/自動標註完成：已存為分割標註 #\d+（耗時 \d+ 毫秒）/, { timeout: 120_000 });
      const text = oneLine(await result.innerText());
      annotationId = Number(/標註 #(\d+)/.exec(text)![1]);
      await s.step(md, '步驟 4', '自動標註完成', { line: text, focus: result });
      await result.getByRole('link', { name: '在標註工作台開啟編輯' }).click();

      // 第 5 步：「影像標註工作台」提示「正在編輯標註 #N」；用筆刷修正遮罩
      await expect(md.getByRole('heading', { level: 1, name: '影像標註工作台' })).toBeVisible();
      await expect(md.getByText(`正在編輯標註 #${annotationId}`)).toBeVisible({ timeout: 60_000 });
      const vp = md.getByTestId('viewport').first();
      await expect(vp).toHaveAttribute('data-ready', '1', { timeout: 60_000 });
      const before = await maskCount(md);
      await s.step(md, '步驟 5', '工作台開啟自動標註結果', {
        line: `${oneLine(await md.getByTestId('workbench-status').innerText())}；${oneLine(await md.getByTestId('mask-info').innerText())}`,
        focus: vp,
      });
      await s.soft('自動標註結果有脾臟遮罩（已塗像素 > 0）', () => expect(before).toBeGreaterThan(0));
      await expect(md.getByRole('button', { name: '筆刷', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await md.getByLabel('標籤', { exact: true }).fill('spleen');
      await md.getByLabel('筆刷半徑（像素）', { exact: true }).fill('8');
      const canvas = vp.locator('canvas');
      await canvas.scrollIntoViewIfNeeded();
      const box = (await canvas.boundingBox())!;
      const at = (x: number, y: number) => [box.x + box.width * x, box.y + box.height * y] as const;
      await md.mouse.move(...at(0.7, 0.42));
      await md.mouse.down();
      await md.mouse.move(...at(0.74, 0.47), { steps: 6 });
      await md.mouse.move(...at(0.78, 0.52), { steps: 6 });
      await md.mouse.up();
      const after = await maskCount(md);
      await s.step(md, '步驟 5', '筆刷修正後', { line: `已塗像素 ${before} → ${after}`, focus: vp });
      await s.soft('筆刷塗抹後遮罩像素增加', () => expect(after).toBeGreaterThan(before));

      // 第 6 步：「儲存分割標註」→「已儲存分割標註 #N（…，版本 V）」
      await md.getByRole('button', { name: '儲存分割標註' }).click();
      const status = md.getByTestId('workbench-status');
      await expect(status).toContainText(new RegExp(`已儲存分割標註 #${annotationId}（.*，版本 \\d+）`), { timeout: 30_000 });
      await s.step(md, '步驟 6', '已儲存分割標註', { line: oneLine(await status.innerText()), focus: status });

      // 第 7 步：「自動影像分類標註」下方「執行紀錄」點「開啟編輯」
      await autolabelPage(md);
      const runs = md.getByRole('table', { name: '自動標註執行紀錄' });
      // has: 要用相對於列的定位（不能用從 runs 起算的 locator，否則會找「列裡面的表格」）
      const runRow = runs.locator('tbody tr').filter({ has: md.locator(`a[href*="annotation=${annotationId}"]`) }).first();
      const link = runRow.getByRole('link', { name: /開啟自動標註 #\d+ 的結果/ });
      await expect(link).toBeVisible();
      await s.step(md, '步驟 7', '執行紀錄', { line: oneLine(await runRow.innerText()), focus: runRow });
      await link.click();
      await expect(md.getByText(`正在編輯標註 #${annotationId}`)).toBeVisible({ timeout: 60_000 });
      await expect(md.getByTestId('viewport').first()).toHaveAttribute('data-ready', '1', { timeout: 60_000 });
      await s.step(md, '步驟 7', '從執行紀錄開回工作台', {
        line: `${oneLine(await md.getByTestId('workbench-status').innerText())}；${oneLine(await md.getByTestId('mask-info').innerText())}`,
        focus: md.getByTestId('viewport').first(),
      });
      await s.soft('開回來的遮罩包含筆刷修正（像素數與儲存時相同）', async () => expect(await maskCount(md)).toBe(after));
      return `segmentation_spleen 對第 ${ct.position} 張自動標註成功（${text.match(/耗時 \d+ 毫秒/)?.[0]}），筆刷修正後儲存，執行紀錄可開回`;
    },
    async () => {
      if (annotationId) {
        const r = await api('md01', 'DELETE', `/api/projects/${pid}/labels/annotations/${annotationId}`);
        s.log(`清理：刪除分割標註 #${annotationId} → HTTP ${r.status}（自動標註執行紀錄保留）`);
      }
    },
  );
});

test('C2 切換自動標註工具', async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  const s = new Scenario('C2', '切換自動標註工具');
  const pid = await projectId();
  const modelNames = async () => ((await api('md01', 'GET', `/api/projects/${pid}/labels/autolabel/models`)).json ?? []).map((m: { name: string }) => m.name) as string[];
  /** 等 autolabel 模型清單符合預期（服務重建後要幾秒才接得上） */
  const waitModels = async (want: string) => {
    await expect.poll(async () => (await modelNames().catch(() => [])).join(','), { timeout: 180_000, intervals: [3000] }).toContain(want);
  };
  const modelOptions = async (page: Page) => (await page.getByLabel('模型', { exact: true }).locator('option').allInnerTexts()).map((t) => t.trim());
  await s.run(
    async () => {
      // 第 1 步：映像（第一次使用才需要 build.sh）
      const img = await sh(s, `docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' | grep -E '^platform-(autolabel|monailabel):'`);
      if (/platform-autolabel:dev/.test(img.out) && /platform-monailabel:dev/.test(img.out))
        s.log('步驟 1｜platform-autolabel:dev、platform-monailabel:dev 映像已存在，略過 BUILD_NETWORK=host platform/autolabel/build.sh（第一次使用才需要）');
      else s.partialBecause('映像不存在，需先執行 BUILD_NETWORK=host platform/autolabel/build.sh（本腳本不自動建置，約需數十分鐘）');

      // 第 2 步：加上 compose.monai.yaml 啟動（完整組合；文件的三個 -f 是最小組合，這裡沿用目前環境的全部疊加檔，其他服務不變）
      const up1 = await dc(s, 'up -d --no-build --wait --wait-timeout 900', { monai: true, timeoutMs: 20 * 60_000 });
      await s.soft('docker compose up（MONAI）結束碼 0', () => expect(up1.code).toBe(0));
      await dc(s, 'ps autolabel monai-label --format "{{.Service}} {{.Image}} {{.Status}}"');
      await waitModels('segmentation_spleen');

      // 第 3 步：「自動影像分類標註」的「模型」出現脾臟與 25 種器官模型
      const md = await s.open(browser, 'md01');
      await autolabelPage(md);
      const monai = await modelOptions(md);
      await s.step(md, '步驟 3', 'MONAI模型清單', { line: monai.join('；'), focus: md.getByLabel('模型', { exact: true }) });
      await s.soft('模型選單有 segmentation_spleen（分割：spleen）與 segmentation（分割：spleen、kidney_right…）', () => {
        expect(monai).toContain('segmentation_spleen（分割：spleen）');
        expect(monai.some((t) => t.startsWith('segmentation（分割：spleen、kidney_right'))).toBe(true);
      });

      // 第 4 步：換回假服務：拿掉 compose.monai.yaml 再 up -d
      const up2 = await dc(s, 'up -d --wait --wait-timeout 600', { monai: false, timeoutMs: 15 * 60_000 });
      await s.soft('docker compose up（假服務）結束碼 0', () => expect(up2.code).toBe(0));
      await dc(s, 'ps autolabel --format "{{.Service}} {{.Image}} {{.Status}}"', { monai: false });
      await waitModels('fake_');
      await md.reload();
      await autolabelPage(md);
      const fake = await modelOptions(md);
      await s.step(md, '步驟 4', '假服務模型清單', { line: fake.join('；'), focus: md.getByLabel('模型', { exact: true }) });
      await s.soft('換回假服務後模型選單只剩 fake_ 模型', () => {
        expect(fake.length).toBeGreaterThan(0);
        expect(fake.every((t) => t.startsWith('fake_'))).toBe(true);
      });

      // 正式環境（只檢查設定，不部署）：production overlay 已設定 MONAI Label 與 AUTOLABEL_URL
      await sh(s, `ls platform/deploy/k8s/overlays/production/ && grep -rn "AUTOLABEL_URL\\|autolabel-monai" platform/deploy/k8s/overlays/production/ | head -20`);
      s.log('正式環境｜production overlay 的 autolabel-monai.yaml 與 AUTOLABEL_URL 見上方指令輸出（未實際部署）');
      return 'MONAI 疊加檔啟動時模型選單為 segmentation_spleen 與 segmentation；拿掉疊加檔 up -d 後換成假服務；已換回 MONAI';
    },
    async () => {
      // 一定換回 MONAI（C1 與其他情境需要）
      const names = await modelNames().catch(() => [] as string[]);
      if (!names.includes('segmentation_spleen')) {
        const r = await dc(s, 'up -d --no-build --wait --wait-timeout 900', { monai: true, timeoutMs: 20 * 60_000 });
        s.log(`清理：加回 compose.monai.yaml 啟動 → 結束碼 ${r.code}`);
        await waitModels('segmentation_spleen').catch((e) => s.log(`清理：等待 MONAI 模型清單逾時：${String(e).slice(0, 200)}`));
      }
      s.log(`清理後 autolabel 模型：${(await modelNames().catch(() => [])).join('、')}`);
    },
  );
});
