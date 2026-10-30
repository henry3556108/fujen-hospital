import { expect, type Browser, type Page } from '@playwright/test';
import { useProject } from '../e2e-acceptance/helpers';
import { userPage } from '../e2e-acceptance/ops';

// 影像 AI 主線（img-*.spec.ts）共用：示範專案、資料位置。
// 依序跑：A1 → B1 → B2 → B4 → B3 → B5 → B6 → B7 → B8 → B9 → B10 → D1 → D2（後面的情境用前面做出來的資料）。

/** 示範專案（A1 建立，每次 A1 重建） */
export const IMG_PROJECT = '手冊-胸部影像研究';
/** D1 匯入流程用的新專案 */
export const IMPORT_PROJECT = '手冊-流程匯入';

/** 合成 DICOM（sample-data M1 dicom 去掉 manifest.json）：20 個研究（ACC0001–ACC0020），每個 5 張影像 */
export const DICOM_DIR = '/mnt/c/Users/skyland/Desktop/workspace/結案-操作手冊與影片/資料/胸部影像DICOM';
/** 診斷結果 CSV（accession_number,diagnosis；與上面 20 個研究對應） */
export const DIAG_CSV = '/mnt/c/Users/skyland/Desktop/workspace/結案-操作手冊與影片/資料/胸部影像診斷.csv';

export const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });
export const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** B6 第 1 次訓練的設定名稱（B7 套用同一份設定再跑） */
export const RUN1 = '胸部CT分類-第1次';

/**
 * 鏡頭外準備（不錄影）：admin01 重建專案 name、加入成員；可選擇再由 uploader 把 DICOM 資料夾上傳進去、匯入診斷 CSV。
 * D1 匯入流程的目標專案用。
 */
export async function prepareProject(
  browser: Browser,
  name: string,
  members: [string, string][],
  data?: { uploader: string; dicom: string; csv?: string },
) {
  const { ctx, page } = await userPage(browser, 'admin01');
  await page.goto('/admin/projects');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const del = page.getByRole('button', { name: `刪除 ${name}`, exact: true });
  if (await del.count()) {
    await del.click();
    await page.getByRole('dialog').getByRole('button', { name: '確認刪除' }).click();
    await expect(status(page, `已刪除專案「${name}」`)).toBeVisible();
  }
  const form = page.getByRole('form', { name: '新增專案' });
  await form.getByLabel('專案名稱（必填）').fill(name);
  const group = form.getByLabel('GPU 群組');
  const option = (await group.locator('option').allInnerTexts()).find((t) => t.startsWith('gpu-shared'));
  await group.selectOption({ label: option! });
  await form.getByRole('button', { name: '新增專案' }).click();
  await expect(status(page, `已新增專案「${name}」`)).toBeVisible();
  await page.getByRole('table', { name: '專案列表' }).getByRole('link', { name, exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/projects\/\d+/);
  await page.locator('main').getByRole('link', { name: '成員與權限', exact: true }).click();
  const f = page.getByRole('form', { name: '設定專案成員' });
  for (const [user, role] of members) {
    await f.getByLabel('帳號').selectOption({ label: user });
    await f.getByLabel('角色').selectOption({ label: role });
    await f.getByRole('button', { name: '加入專案' }).click();
    await expect(status(page, `已將「${user}」設定為`)).toBeVisible();
  }
  await ctx.close();
  if (!data) return;
  const u = await userPage(browser, data.uploader);
  await useProject(u.page, name);
  await u.page.goto('/data/imaging/import');
  const dicom = u.page.getByRole('form', { name: '從電腦上傳' });
  await dicom.getByRole('checkbox', { name: '選擇整個資料夾（保留資料夾路徑）' }).check();
  await dicom.locator('input[type=file]').setInputFiles(data.dicom);
  await dicom.getByRole('button', { name: /^上傳到「/ }).click();
  await expect(dicom.getByRole('region', { name: 'DICOM 匯入結果' })).toContainText(/新增 \d+、重複 \d+、失敗 \d+/, { timeout: 5 * 60_000 });
  if (data.csv) {
    await u.page.goto('/labeling/datasets');
    const c = u.page.getByRole('form', { name: '匯入診斷結果' });
    await c.locator('input[type=file]').setInputFiles(data.csv);
    await c.getByLabel('用哪一種編號對照影像').selectOption('accession_number');
    await expect(c.getByTestId('csv-preview')).toBeVisible();
    await c.getByRole('button', { name: '匯入', exact: true }).click();
    await expect(u.page.getByTestId('csv-result')).toBeVisible({ timeout: 60_000 });
  }
  await u.ctx.close();
}
