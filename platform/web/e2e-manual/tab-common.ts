import { expect, type Locator, type Page } from '@playwright/test';

// 結構式資料主線（C1～C4）共用：專案、資料檔、資料集名稱與幾個定位小工具。前置見 tab-00-setup.spec.ts。
export const TAB_PROJECT = '手冊-臨床表格研究';
export const CSV = '/mnt/c/Users/skyland/Desktop/workspace/sample-data/M1-驗收資料包/tabular/cohort_01.csv';
/** 預測新病人用（同格式的另一批病人） */
export const CSV_NEW = '/mnt/c/Users/skyland/Desktop/workspace/sample-data/M1-驗收資料包/tabular/cohort_02.csv';
export const DS = '門診病人資料';
export const FEATURES = ['age', 'sex', 'bmi', 'sbp', 'dbp', 'glucose', 'smoker'];
export const COLS = ['patient_id', 'age', 'sex', 'bmi', 'sbp', 'dbp', 'glucose', 'smoker', 'diagnosis', 'time_to_event', 'event', 'study_accession'];

/** 下拉選單中「文字完全相同、找不到才用包含」的選項 value */
export async function optionValue(sel: Locator, text: string) {
  const exact = sel.locator('option', { hasText: new RegExp(`^\\s*${text}\\s*$`) });
  const option = (await exact.count()) ? exact.first() : sel.locator('option', { hasText: text }).first();
  return (await option.getAttribute('value')) ?? text;
}

/** 資料集分頁導覽 */
export const datasetTabs = (page: Page) => page.getByRole('navigation', { name: '資料集分頁' });

/** 鏡頭外直接開資料集的某個分頁（path：view、prepare、stats） */
export async function openDatasetOffCamera(page: Page, path: 'view' | 'prepare' | 'stats' = 'view') {
  await page.goto('/data/tabular');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const link = page.getByRole('table', { name: '資料集列表' }).getByRole('link', { name: DS, exact: true });
  await expect(link).toBeVisible({ timeout: 30_000 });
  const href = await link.getAttribute('href');
  await page.goto(`${href}/${path}`);
  await expect(page.getByRole('heading', { name: `資料集：${DS}` })).toBeVisible();
  await page.waitForLoadState('networkidle').catch(() => undefined);
}
