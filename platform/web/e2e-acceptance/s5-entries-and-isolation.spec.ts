import { expect, test, type Browser, type Page } from '@playwright/test';
import { DENIED, P1, clickMenu, expectNotDenied, login, menuLabels, note, shot, useProject } from './helpers';

// 情境 5：首頁功能入口與專案隔離（TC-A02-01～04 的網頁部分）。全部唯讀，不改任何資料。

// 改版後從「功能目錄」點契約原名稱進入；舊入口轉到新位置（網址與頁面標題為新位置）
const ENTRIES: { name: string; url: RegExp; h1: string }[] = [
  { name: '帳號管理', url: /\/admin$/, h1: '總覽' },
  { name: '數據管理', url: /\/data\/imaging$/, h1: '研究資料' },
  { name: '影像標註', url: /\/labeling$/, h1: '影像標註' },
  { name: '自動影像分類標註', url: /\/labeling\/auto$/, h1: '影像標註' },
  { name: '建模管理', url: /\/training$/, h1: '建立模型' },
  { name: 'AI 模型部署', url: /\/models\?entry=deployment$/, h1: '使用模型' },
  { name: '推論服務管理', url: /\/models\?entry=inference$/, h1: '使用模型' },
  { name: 'LLM No-code 開發', url: /\/llm\/chat$/, h1: '語言模型' },
];

test('5-1 admin01 從 8 個入口都能進入（TC-A02-01）', async ({ page }) => {
  const tc = 'TC-A02-01';
  await login(page, 'admin01');
  await useProject(page);
  await expect(page.getByRole('heading', { level: 1, name: '專案首頁' })).toBeVisible();
  await expect(page.locator('.home-subtitle')).toHaveText(P1);
  expect(await menuLabels(page)).toEqual(ENTRIES.map((e) => e.name));
  await shot(page, tc, '01-功能目錄八個入口');
  let ok = 0;
  for (const [i, e] of ENTRIES.entries()) {
    await clickMenu(page, e.name);
    await expect(page).toHaveURL(e.url);
    await expect(page.getByRole('heading', { level: 1, name: e.h1 })).toBeVisible();
    await expectNotDenied(page);
    await shot(page, tc, `${String(i + 2).padStart(2, '0')}-${e.name}`);
    ok++;
  }
  note(tc, `8 個入口進入成功 ${ok}/8`);
});

const BY_ROLE: Record<string, string[]> = {
  vw01: ['數據管理', 'AI 模型部署', '推論服務管理'],
  md01: ['數據管理', '影像標註', '自動影像分類標註', 'AI 模型部署', '推論服務管理'],
  ca01: ['數據管理', '建模管理', 'AI 模型部署', '推論服務管理', 'LLM No-code 開發'],
};

for (const [user, expected] of Object.entries(BY_ROLE)) {
  test(`5-2 ${user} 左側選單符合角色權限（TC-A02-02）`, async ({ page }) => {
    const tc = 'TC-A02-02';
    await login(page, user);
    await useProject(page);
    const labels = await menuLabels(page);
    await shot(page, tc, user);
    note(tc, `${user} 功能目錄：${labels.join('、')}`);
    expect(labels).toEqual(expected);
  });
}

type Step = { label: string; run: (p: Page) => Promise<void> };
const openDataset = async (p: Page) => {
  await p.getByRole('link', { name: 'cohort_02.csv', exact: true }).first().click();
  await expect(p.getByText('資料集：cohort_02.csv')).toBeVisible();
};
const tab = (name: string) => async (p: Page) => {
  await p.getByRole('link', { name, exact: true }).or(p.getByRole('tab', { name, exact: true })).first().click();
};
/** 查看資料頁的段落按鈕（資料預覽、欄位統計、相關與散佈圖） */
const section = (name: string) => async (p: Page) => {
  await p.getByRole('group', { name: '查看資料的段落' }).getByRole('button', { name, exact: true }).click();
  await expect(p.getByRole('region', { name })).toBeVisible();
};
const runs = async (p: Page) => {
  await clickMenu(p, '建模管理');
  await expect(p.getByRole('heading', { level: 2, name: '訓練紀錄' })).toBeVisible();
};
const PLAN: Record<string, Step[]> = {
  pi01: [
    { label: '數據管理', run: (p) => clickMenu(p, '數據管理') },
    { label: '表格資料', run: tab('表格資料') },
    { label: '開啟資料集-查看資料', run: openDataset },
    { label: '欄位統計', run: section('欄位統計') },
    { label: '訓練紀錄', run: runs },
  ],
  md01: [
    { label: '數據管理', run: (p) => clickMenu(p, '數據管理') },
    { label: '影像標註', run: (p) => clickMenu(p, '影像標註') },
    { label: '自動影像分類標註', run: (p) => clickMenu(p, '自動影像分類標註') },
    { label: 'AI模型部署', run: (p) => clickMenu(p, 'AI 模型部署') },
    { label: '推論服務管理', run: async (p) => { await clickMenu(p, '推論服務管理'); await expect(p.getByRole('heading', { level: 1, name: '使用模型' })).toBeVisible(); } },
  ],
  ra01: [
    { label: '數據管理', run: (p) => clickMenu(p, '數據管理') },
    { label: '開啟資料集', run: async (p) => { await tab('表格資料')(p); await openDataset(p); } },
    { label: '相關與散佈圖', run: section('相關與散佈圖') },
    { label: '建模管理', run: (p) => clickMenu(p, '建模管理') },
    { label: '訓練紀錄', run: runs },
  ],
};

async function runUser(browser: Browser, user: string) {
  const tc = 'TC-A02-03';
  const ctx = await browser.newContext(); // 每個帳號一個獨立的瀏覽器環境，等同各自的無痕視窗
  const page = await ctx.newPage();
  try {
    await login(page, user);
    await useProject(page);
    let ok = 0;
    for (const [i, s] of PLAN[user].entries()) {
      await s.run(page);
      await expectNotDenied(page);
      await shot(page, tc, `${user}-${i + 1}-${s.label}`);
      ok++;
    }
    return ok;
  } finally {
    await ctx.close();
  }
}

test('5-3 pi01、md01、ra01 同時操作各 5 個動作（TC-A02-03）', async ({ browser }) => {
  const results = await Promise.all(Object.keys(PLAN).map((u) => runUser(browser, u)));
  note('TC-A02-03', `3 帳號同時操作，成功 ${results.reduce((a, b) => a + b, 0)}/15`);
  expect(results).toEqual([5, 5, 5]);
});

const USER01_URLS = ['/data', '/data/imaging', '/data/tabular', '/data/tabular/1/preview', '/data/tabular/1/describe',
  '/labeling', '/training/jobs', '/deployment', '/inference', '/llm/playground'];

test('5-4 user01（未加入專案）直接輸入 10 個網址都被擋（TC-A02-04）', async ({ page }) => {
  const tc = 'TC-A02-04';
  await login(page, 'user01');
  await expect(page.getByText('你尚未加入任何專案，請聯絡管理者將你加入專案。').first()).toBeVisible();
  await shot(page, tc, '00-首頁');
  let denied = 0;
  for (const [i, url] of USER01_URLS.entries()) {
    await page.goto(url);
    // 沒有任何專案：研究區一律顯示「你還沒有加入任何專案」說明頁（等同被擋）
    await expect(page.getByText(DENIED).or(page.getByRole('heading', { level: 1, name: '你還沒有加入任何專案' })).first()).toBeVisible();
    await expect(page.getByText('cohort_02.csv')).toHaveCount(0);
    await shot(page, tc, `${String(i + 1).padStart(2, '0')}-${url.replaceAll('/', '_')}`);
    denied++;
  }
  note(tc, `user01 直接輸入網址 10 次，被擋 ${denied}/10，看到 P1 資料 0 次`);
});
