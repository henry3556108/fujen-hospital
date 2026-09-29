import { expect as baseExpect, expectNoHorizontalOverflow, loginAs, snap, test } from './fixtures';

// 這台開發機由多個工作共用，負載高時 dev server 首次編譯頁面較慢：等待上限放寬到 15 秒
const expect = baseExpect.configure({ timeout: 15_000 });

// TC-A02-08：WP2／WP3／WP4 的新頁面在桌機（1280×800）與手機（375×812）不破版，並截圖存檔。
const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '375x812', width: 375, height: 812 },
];

const PAGES: { name: string; path: string; ready: { role: 'table' | 'form' | 'list' | 'heading'; name: string | RegExp } }[] = [
  { name: 'scheduling-settings', path: '/admin/scheduling', ready: { role: 'form', name: '修改共享排程設定' } },
  { name: 'scheduling-groups', path: '/admin/scheduling/groups', ready: { role: 'table', name: 'GPU 群組列表' } },
  { name: 'scheduling-nodes', path: '/admin/scheduling/nodes', ready: { role: 'table', name: '叢集節點列表' } },
  { name: 'scheduling-gpu-dashboard', path: '/admin/scheduling/gpu-dashboard', ready: { role: 'list', name: 'GPU 使用狀況' } },
  { name: 'scheduling-monitoring', path: '/admin/scheduling/monitoring', ready: { role: 'list', name: '監控工具' } },
  { name: 'training-jobs', path: '/training/jobs', ready: { role: 'table', name: '工作列表' } },
  { name: 'imaging-studies', path: '/data/imaging', ready: { role: 'table', name: '研究列表' } },
  { name: 'imaging-study', path: '/data/imaging/studies/1.2.826.0.1.3680043.10.9999.88.1.13', ready: { role: 'table', name: '序列列表' } },
  { name: 'imaging-import', path: '/data/imaging/import', ready: { role: 'form', name: 'DICOM' } },
  { name: 'imaging-jobs', path: '/data/imaging/jobs', ready: { role: 'table', name: '匯入工作列表' } },
  { name: 'imaging-files', path: '/data/imaging/files', ready: { role: 'table', name: '檔案列表' } },
  { name: 'imaging-allowlist', path: '/data/imaging/allowlist', ready: { role: 'form', name: '設定 Accession 清單' } },
  { name: 'imaging-pacs', path: '/data/imaging/pacs', ready: { role: 'form', name: '查詢 PACS' } },
  { name: 'tabular-datasets', path: '/data/tabular', ready: { role: 'form', name: '上傳 CSV' } },
  { name: 'tabular-preview', path: '/data/tabular/2', ready: { role: 'table', name: '資料預覽' } },
  { name: 'tabular-describe', path: '/data/tabular/2/describe', ready: { role: 'table', name: '描述統計' } },
  { name: 'tabular-target', path: '/data/tabular/2/target', ready: { role: 'form', name: '設定 Target 與 Feature' } },
  { name: 'tabular-preprocess', path: '/data/tabular/2/preprocess', ready: { role: 'form', name: '加入前處理步驟' } },
  { name: 'tabular-correlation', path: '/data/tabular/2/correlation', ready: { role: 'form', name: '相關矩陣' } },
  { name: 'tabular-stats', path: '/data/tabular/2/stats', ready: { role: 'form', name: '統計分析' } },
];

for (const vp of VIEWPORTS) {
  test.describe(`TC-A02-08 新頁面版面 ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`20 個新頁面不破版並截圖（${vp.name}）`, async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      await loginAs(page, 'admin01');
      let broken = 0;
      for (const p of PAGES) {
        await page.goto(p.path);
        await expect(page.getByRole(p.ready.role, { name: p.ready.name }).first()).toBeVisible();
        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        if (scrollWidth > clientWidth) {
          broken++;
          console.warn(`破版：${p.path} 水平溢出 ${scrollWidth - clientWidth}px（${vp.name}）`);
        }
        await snap(page, testInfo.project.name, `${vp.name}/${p.name}`);
      }
      expect(broken, '破版頁數').toBe(0);
    });

    test(`圖表與結果不破版（${vp.name}）`, async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await loginAs(page, 'admin01');
      await page.goto('/data/tabular/2/correlation');
      await page.getByRole('button', { name: '產生相關矩陣' }).click();
      await expect(page.getByRole('table', { name: '相關矩陣（pearson）' })).toBeVisible();
      await page.getByRole('button', { name: '產生散佈圖' }).click();
      await expect(page.getByRole('figure', { name: 'age 與 bmi' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await snap(page, testInfo.project.name, `${vp.name}/tabular-correlation-result`);

      await page.goto('/data/tabular/2/stats');
      await page.getByLabel('模型').selectOption('kaplan-meier');
      await page.getByLabel('分組欄位').selectOption('sex');
      await page.getByRole('button', { name: '執行分析' }).click();
      await expect(page.getByRole('figure', { name: '存活曲線' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await snap(page, testInfo.project.name, `${vp.name}/tabular-stats-km`);

      await page.getByLabel('模型').selectOption('cox');
      await page.getByRole('checkbox', { name: 'age', exact: true }).check();
      await page.getByRole('checkbox', { name: 'bmi', exact: true }).check();
      await page.getByRole('button', { name: '執行分析' }).click();
      await expect(page.getByRole('figure', { name: 'Hazard Ratio 森林圖' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await snap(page, testInfo.project.name, `${vp.name}/tabular-stats-cox`);
    });
  });
}

test.describe('深色模式（新頁面）', () => {
  test('圖表與狀態標籤在深色模式可讀', async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await loginAs(page, 'admin01');
    await page.goto('/data/tabular/2/describe');
    const bar = page.getByRole('figure', { name: 'age 的分布' }).getByRole('img', { name: /：\d+$/ }).first();
    await expect(bar).toBeVisible();
    // 深色模式用深色那一階的系列色（--primitive-chart-blue-400），不是自動反轉
    expect(await bar.evaluate((el) => getComputedStyle(el).fill)).toBe('rgb(57, 135, 229)');
    await snap(page, testInfo.project.name, 'dark/tabular-describe');

    await page.goto('/data/tabular/2/correlation');
    await page.getByRole('button', { name: '產生相關矩陣' }).click();
    await expect(page.getByRole('table', { name: '相關矩陣（pearson）' })).toBeVisible();
    await snap(page, testInfo.project.name, 'dark/tabular-correlation');

    await page.goto('/admin/scheduling/nodes');
    await expect(page.getByRole('table', { name: '叢集節點列表' })).toBeVisible();
    await snap(page, testInfo.project.name, 'dark/scheduling-nodes');
  });
});
