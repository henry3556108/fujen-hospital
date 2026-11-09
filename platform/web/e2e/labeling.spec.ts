// 影像標註工作台與自動標註（模擬 API、合成影像）。
// TC-B02-01～04、06，TC-B03-03。次數與判準照 docs/test-cases/acceptance-test-cases.md。
import type { Page } from '@playwright/test';
import { expect, loginAs, snap, test } from './fixtures';

const ROOT = '1.2.826.0.1.3680043.10.9999.42';
const studyUid = (no: number) => `${ROOT}.1.${no}`;
const STUDIES = Array.from({ length: 10 }, (_, i) => i + 1);

interface Saved {
  id: number;
  kind: string;
  source: string;
  rating: number | null;
  version: number;
  study_instance_uid: string;
  sop_instance_uid: string | null;
  payload: Record<string, unknown>;
}

async function openWorkbench(page: Page, no: number, query = '') {
  await page.goto(`/labeling/studies/${studyUid(no)}${query}`);
  await expect(page.getByRole('heading', { level: 1, name: '影像標註工作台' })).toBeVisible();
  await expect(viewport(page)).toHaveAttribute('data-ready', '1');
}

const viewport = (page: Page, n = 0) => page.getByTestId('viewport').nth(n);
const status = (page: Page) => page.getByTestId('workbench-status');
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '檢視工具列' });

/** 畫布內容的指紋：每個像素乘上位置權重，旋轉或 WC 改變都會反映出來。 */
async function fingerprint(page: Page, n = 0): Promise<number> {
  return viewport(page, n)
    .locator('canvas')
    .evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum = (sum + data[i] * ((i / 4) % 9973 + 1)) % 2147483647;
      return sum;
    });
}

/** 在第一個視窗的畫布上拖曳；座標是畫布寬高的比例（0–1）。 */
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const canvas = viewport(page).locator('canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const at = ([x, y]: [number, number]) => [box.x + box.width * x, box.y + box.height * y] as const;
  await page.mouse.move(...at(from));
  await page.mouse.down();
  await page.mouse.move(...at([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]), { steps: 4 });
  await page.mouse.move(...at(to), { steps: 4 });
  await page.mouse.up();
}

async function saved(page: Page, username: string): Promise<Saved[]> {
  return page.evaluate(async (user) => {
    const res = await fetch('/api/projects/1/labels/annotations', { headers: { Authorization: `Bearer test-token:${user}` } });
    return res.json();
  }, username);
}

async function setLabel(page: Page, label: string) {
  await page.getByLabel('標籤', { exact: true }).fill(label);
}

const pickKind = (page: Page, name: '分類' | '分割' | '偵測') =>
  page.getByRole('group', { name: '標註種類' }).getByRole('button', { name, exact: true }).click();

test.describe('TC-B02-01 檢視工具列', () => {
  test('預設器官數值不少於 3 組，每一組都改變影像', async ({ page }) => {
    await loginAs(page, 'md01');
    await openWorkbench(page, 1);
    const presets = toolbar(page).getByRole('group', { name: '預設器官數值' }).getByRole('button');
    const count = await presets.count();
    expect(count).toBeGreaterThanOrEqual(3);
    const seen = new Set<number>();
    for (let i = 0; i < count; i++) {
      await presets.nth(i).click();
      await expect(presets.nth(i)).toHaveAttribute('aria-pressed', 'true');
      seen.add(await fingerprint(page));
    }
    expect(seen.size).toBe(count);
  });

  test('10 個研究各操作排列、旋轉、WW/WC 3 次，失敗 0', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await loginAs(page, 'md01');
    const layouts = ['1×2', '2×2', '1×1'];
    const windows = [
      { ww: 1500, wl: -600 },
      { ww: 1800, wl: 400 },
      { ww: 350, wl: 50 },
    ];
    let operations = 0;
    for (const no of STUDIES) {
      await openWorkbench(page, no);
      for (let round = 0; round < 3; round++) {
        // 排列
        await toolbar(page).getByRole('button', { name: layouts[round], exact: true }).click();
        const expected = layouts[round].replace('×', 'x');
        await expect(page.getByTestId('viewport-grid')).toHaveAttribute('data-layout', expected);
        await expect(page.getByTestId('viewport')).toHaveCount(expected === '1x1' ? 1 : expected === '1x2' ? 2 : 3);
        await expect(viewport(page)).toHaveAttribute('data-ready', '1');
        operations++;

        // 旋轉
        const before = await fingerprint(page);
        const angle = Number(await viewport(page).getAttribute('data-rotation'));
        await toolbar(page).getByRole('button', { name: round === 1 ? '向左轉 90°' : '向右轉 90°' }).click();
        await expect(viewport(page)).toHaveAttribute('data-rotation', String((angle + (round === 1 ? 270 : 90)) % 360));
        await expect.poll(() => fingerprint(page)).not.toBe(before);
        operations++;

        // WW/WC
        const beforeWindow = await fingerprint(page);
        await toolbar(page).getByLabel('WW').fill(String(windows[round].ww));
        await toolbar(page).getByLabel('WC').fill(String(windows[round].wl));
        await toolbar(page).getByRole('button', { name: '套用' }).click();
        await expect(viewport(page)).toHaveAttribute('data-window-width', String(windows[round].ww));
        await expect(viewport(page)).toHaveAttribute('data-window-center', String(windows[round].wl));
        await expect.poll(() => fingerprint(page)).not.toBe(beforeWindow);
        operations++;
      }
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
    expect(operations).toBe(10 * 3 * 3);
    await snap(page, testInfo.project.name, 'labeling/workbench-toolbar');
  });
});

test('TC-B02-02 5 組快捷鍵各觸發 1 次，動作正確', async ({ page }) => {
  await loginAs(page, 'md01');
  await openWorkbench(page, 1);
  await page.locator('summary', { hasText: '快捷鍵' }).click();
  expect(await page.locator('.hotkeys tbody tr').count()).toBeGreaterThanOrEqual(5);
  await page.locator('h1').click(); // 焦點離開輸入欄

  // 第 1 組：預設器官數值
  let before = await fingerprint(page);
  await page.keyboard.press('2');
  await expect(status(page)).toContainText('肺窗：WW 1500、WC -600');
  await expect(viewport(page)).toHaveAttribute('data-window-width', '1500');
  await expect.poll(() => fingerprint(page)).not.toBe(before);

  // 第 2 組：旋轉
  before = await fingerprint(page);
  await page.keyboard.press('r');
  await expect(viewport(page)).toHaveAttribute('data-rotation', '90');
  await expect.poll(() => fingerprint(page)).not.toBe(before);
  await page.keyboard.press('l');
  await expect(viewport(page)).toHaveAttribute('data-rotation', '0');

  // 第 3 組：換張
  const first = await viewport(page).getAttribute('data-sop');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('image-position')).toHaveText('第 2 / 3 張');
  await expect(viewport(page)).not.toHaveAttribute('data-sop', first!);
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('image-position')).toHaveText('第 1 / 3 張');

  // 第 4 組：排列
  await page.keyboard.press('g');
  await expect(page.getByTestId('viewport-grid')).toHaveAttribute('data-layout', '1x2');
  await expect(page.getByTestId('viewport')).toHaveCount(2);

  // 第 5 組：標註工具
  await page.keyboard.press('d');
  await expect(page.getByRole('button', { name: '畫框工具' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('b');
  await expect(page.getByRole('button', { name: '筆刷', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('c');
  await expect(page.getByRole('button', { name: '儲存分類標註' })).toBeVisible();

  // 在輸入欄打字不會觸發快捷鍵
  await page.getByLabel('標籤', { exact: true }).fill('');
  await page.getByLabel('標籤', { exact: true }).pressSequentially('r2g');
  await expect(page.getByLabel('標籤', { exact: true })).toHaveValue('r2g');
  await expect(viewport(page)).toHaveAttribute('data-rotation', '0');
  await expect(page.getByTestId('viewport-grid')).toHaveAttribute('data-layout', '1x2');
});

test('TC-B02-04 分類、分割、偵測各 10 筆，儲存 100%，重新載入差異 0', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await loginAs(page, 'md01');
  let stored = 0;
  for (const no of STUDIES) {
    await openWorkbench(page, no);

    await pickKind(page, '分類');
    await setLabel(page, no % 2 ? 'nodule' : 'normal');
    await page.getByRole('button', { name: '儲存分類標註' }).click();
    await expect(status(page)).toContainText(/已儲存分類標註 #\d+/);
    stored++;

    await pickKind(page, '偵測');
    await setLabel(page, 'nodule');
    await drag(page, [0.25, 0.25], [0.5, 0.625]);
    await expect(page.getByRole('list', { name: '草稿中的框' }).getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('list', { name: '草稿中的框' })).toContainText('[16, 16, 32, 40]');
    await page.getByRole('button', { name: '儲存偵測標註' }).click();
    await expect(status(page)).toContainText(/已儲存偵測標註 #\d+（1 個框/);
    stored++;

    await pickKind(page, '分割');
    await setLabel(page, 'lung');
    await drag(page, [0.3, 0.5], [0.45, 0.55]);
    await expect(page.getByTestId('mask-info')).toContainText(/已塗 [1-9]\d* 個像素：lung/);
    await page.getByRole('button', { name: '儲存分割標註' }).click();
    await expect(status(page)).toContainText(/已儲存分割標註 #\d+（lung/);
    stored++;
  }
  expect(stored).toBe(30);

  const before = await saved(page, 'md01');
  expect(before).toHaveLength(30);
  for (const kind of ['classification', 'segmentation', 'detection']) {
    expect(before.filter((a) => a.kind === kind), kind).toHaveLength(10);
  }
  for (const a of before.filter((x) => x.kind === 'detection')) {
    expect(a.payload).toEqual({ shape: [64, 64], box_format: 'xyxy', boxes: [{ label: 'nodule', box: [16, 16, 32, 40] }] });
  }
  for (const a of before.filter((x) => x.kind === 'segmentation')) {
    const p = a.payload as { rle: [number, number][]; label_names: Record<string, number>; shape: number[] };
    expect(p.label_names).toEqual({ background: 0, lung: 1 });
    expect(p.rle.reduce((n, [, run]) => n + run, 0)).toBe(64 * 64);
    expect(p.rle.some(([v]) => v === 1)).toBe(true);
  }

  await page.reload();
  await expect(viewport(page)).toHaveAttribute('data-ready', '1');
  expect(await saved(page, 'md01')).toEqual(before);
  const table = page.getByRole('table', { name: '標註清單' });
  await expect(table.locator('tbody tr')).toHaveCount(3);
  for (const kind of ['classification', 'segmentation', 'detection']) {
    await expect(table.locator(`tbody tr[data-kind="${kind}"]`)).toHaveCount(1);
  }
  await snap(page, testInfo.project.name, 'labeling/three-kinds');

  await page.goto('/labeling');
  await expect(page.getByTestId('label-totals')).toContainText('30 筆標註（分類 10、分割 10、偵測 10）');
});

test('TC-B02-03 評分 10 筆後重新載入，差異 0', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, 'md01');
  await openWorkbench(page, 3);
  for (let i = 0; i < 10; i++) {
    await setLabel(page, `finding-${i + 1}`);
    await page.getByRole('button', { name: '儲存分類標註' }).click();
    await expect(status(page)).toContainText(`finding-${i + 1}`);
  }
  const table = page.getByRole('table', { name: '標註清單' });
  await expect(table.locator('tbody tr')).toHaveCount(10);
  const expected: Record<number, number> = {};
  for (let id = 1; id <= 10; id++) {
    const rating = ((id * 3) % 5) + 1;
    await page.getByRole('group', { name: `標註 #${id} 的評分` }).getByRole('button', { name: `${rating} 分` }).click();
    await expect(status(page)).toContainText(`標註 #${id} 評為 ${rating} 分`);
    expected[id] = rating;
  }

  await page.reload();
  await expect(table.locator('tbody tr')).toHaveCount(10);
  for (const [id, rating] of Object.entries(expected)) {
    const group = page.getByRole('group', { name: `標註 #${id} 的評分` });
    await expect(group).toHaveAttribute('data-rating', String(rating));
    await expect(group.getByRole('button', { name: `${rating} 分` })).toHaveAttribute('aria-pressed', 'true');
    await expect(group.locator('button[aria-pressed="true"]')).toHaveCount(1);
  }
  const after = await saved(page, 'md01');
  expect(Object.fromEntries(after.map((a) => [a.id, a.rating]))).toEqual(expected);
  expect(after.every((a) => a.version === 1)).toBe(true); // 評分不算內容修改
});

test('TC-B02-06 從標註頁建立訓練任務 3 次，建立成功 100%', async ({ page }, testInfo) => {
  await loginAs(page, 'ra01');
  await page.goto('/labeling');
  await expect(page.getByRole('table', { name: '研究清單' }).locator('tbody tr')).toHaveCount(10);

  // 先用 CSV 診斷結果做分類標註（TC-B02-05 的頁面流程）
  const rows = STUDIES.map((no) => `PAT${String(no).padStart(4, '0')},${no % 2 ? 'nodule' : 'normal'}`);
  await page.getByLabel(/^CSV 檔/).setInputFiles({
    name: 'diagnosis.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(['patient_id,diagnosis', ...rows].join('\n'), 'utf8'),
  });
  await page.getByRole('button', { name: '上傳並標註' }).click();
  await expect(page.getByTestId('csv-result')).toContainText('共 10 列：已標註 10 列（10 個研究；新增 10');

  const form = page.getByRole('form', { name: '建立訓練任務' });
  const types = ['classification', 'classification', 'classification'];
  for (let i = 0; i < types.length; i++) {
    await form.getByLabel('訓練型態').selectOption(types[i]);
    await expect(form.getByLabel(/^nodule/)).toBeChecked();
    await form.getByLabel('Resize（像素）').fill(String(128 + i * 32));
    await form.getByLabel('隨機種子').fill(String(40 + i));
    await form.getByRole('button', { name: '建立訓練任務' }).click();
    await expect(page.getByRole('table', { name: '已建立的訓練任務' }).locator('tbody tr')).toHaveCount(i + 1);
  }
  const jobs = page.getByRole('table', { name: '已建立的訓練任務' });
  for (const id of [1, 2, 3]) await expect(jobs.getByRole('row', { name: new RegExp(`#${id}.*等待中`) })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await snap(page, testInfo.project.name, 'labeling/training-from-labels');
});

test('TC-B02-06 沒有 Training 權限時說明原因，不顯示建立按鈕', async ({ page }) => {
  await loginAs(page, 'md01');
  await page.goto('/labeling');
  await expect(page.getByText('建立訓練任務需要 Training 權限')).toBeVisible();
  await expect(page.getByRole('button', { name: '建立訓練任務' })).toHaveCount(0);
});

test('TC-B03-03 在標註平台開啟自動標註結果，修改後儲存 100%', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await loginAs(page, 'md01');
  const opened: number[] = [];
  for (const model of ['fake_detection', 'fake_segmentation']) {
    await page.goto('/auto-labeling');
    await expect(page.getByLabel('影像', { exact: true })).toBeEnabled();
    await page.getByLabel('模型').selectOption(model);
    await page.getByLabel('研究').selectOption(studyUid(2));
    await expect(page.getByLabel('影像', { exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '送出自動標註' }).click();
    await expect(page.getByTestId('autolabel-result')).toContainText('自動標註完成');

    await page.getByRole('link', { name: '在標註工作台開啟編輯' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '影像標註工作台' })).toBeVisible();
    await expect(viewport(page)).toHaveAttribute('data-ready', '1');
    await expect(status(page)).toContainText(/編輯標註 #\d+（(偵測|分割)，自動標註）/);
    const id = Number((await status(page).textContent())!.match(/#(\d+)/)![1]);
    opened.push(id);

    if (model === 'fake_detection') {
      const draft = page.getByRole('list', { name: '草稿中的框' });
      await expect(draft.getByRole('listitem')).toHaveCount(2);
      await page.getByRole('button', { name: '刪除第 2 個框' }).click();
      await setLabel(page, 'nodule');
      await drag(page, [0.5, 0.5], [0.75, 0.75]);
      await expect(draft.getByRole('listitem')).toHaveCount(2);
      await expect(draft).toContainText('[32, 32, 48, 48]');
      await page.getByRole('button', { name: '儲存偵測標註' }).click();
      await expect(status(page)).toContainText(`已儲存偵測標註 #${id}（2 個框，版本 2）`);
    } else {
      const info = page.getByTestId('mask-info');
      await expect(info).toContainText(/已塗 \d+ 個像素：lung、nodule/);
      const painted = Number((await info.textContent())!.match(/已塗 (\d+)/)![1]);
      await page.getByRole('button', { name: '橡皮擦' }).click();
      await drag(page, [0.45, 0.45], [0.55, 0.55]);
      await expect.poll(async () => Number((await info.textContent())!.match(/已塗 (\d+)/)![1])).toBeLessThan(painted);
      await page.getByRole('button', { name: '儲存分割標註' }).click();
      await expect(status(page)).toContainText(new RegExp(`已儲存分割標註 #${id}（.*版本 2）`));
    }
  }

  const before = await saved(page, 'md01');
  expect(before.map((a) => [a.id, a.source, a.version])).toEqual(opened.map((id) => [id, 'autolabel', 2]));
  const detection = before.find((a) => a.kind === 'detection')!;
  expect((detection.payload as { boxes: { box: number[] }[] }).boxes.map((b) => b.box)).toContainEqual([32, 32, 48, 48]);

  await page.reload();
  await expect(viewport(page)).toHaveAttribute('data-ready', '1');
  expect(await saved(page, 'md01')).toEqual(before);
  await expect(page.getByRole('table', { name: '標註清單' }).locator('tbody tr[data-source="autolabel"]')).toHaveCount(2);
  await snap(page, testInfo.project.name, 'labeling/autolabel-edited');

  await page.goto('/auto-labeling');
  await expect(page.getByRole('table', { name: '自動標註執行紀錄' }).locator('tbody tr')).toHaveCount(2);
});

test('TC-B02-07 vw01 直接輸入標註頁網址 → 無權限頁與文字原因', async ({ page }) => {
  await loginAs(page, 'vw01');
  for (const path of ['/labeling', `/labeling/studies/${studyUid(1)}`, '/auto-labeling']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: '無法存取此功能' })).toBeVisible();
    await expect(page.getByText(/沒有 Labeling 權限/)).toBeVisible();
  }
});

test('旋轉後畫的框仍落在正確的影像座標', async ({ page }) => {
  await loginAs(page, 'md01');
  await openWorkbench(page, 1);
  await toolbar(page).getByRole('button', { name: '向右轉 90°' }).click();
  await expect(viewport(page)).toHaveAttribute('data-rotation', '90');
  await pickKind(page, '偵測');
  await setLabel(page, 'nodule');
  // 旋轉 90 度後，畫布右上角是影像的左上角：畫布 (x, y) → 影像 (y, 1 − x)
  await drag(page, [0.75, 0.25], [0.5, 0.5]);
  await expect(page.getByRole('list', { name: '草稿中的框' })).toContainText('[16, 16, 32, 32]');
});
