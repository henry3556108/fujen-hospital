import { expect, loginAs, snap, test } from './fixtures';

// 色彩指南 §11「已測試常見色覺差異情境」：以色覺模擬濾鏡截圖，並確認狀態除了顏色還有 Icon 與文字。
// 矩陣取自 Machado et al. 2009（severity 1.0）。
const MATRICES: Record<string, string> = {
  protanopia: '0.152 1.053 -0.205 0 0  0.115 0.786 0.099 0 0  -0.004 -0.048 1.052 0 0  0 0 0 1 0',
  deuteranopia: '0.367 0.861 -0.228 0 0  0.280 0.673 0.047 0 0  -0.012 0.043 0.969 0 0  0 0 0 1 0',
  tritanopia: '1.256 -0.077 -0.179 0 0  -0.078 0.931 0.148 0 0  0.005 0.691 0.304 0 0  0 0 0 1 0',
  achromatopsia: '0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0',
};

test('色覺差異模擬：錯誤、成功、選中狀態都有顏色以外的線索', async ({ page }, testInfo) => {
  await loginAs(page, 'admin01');
  await page.goto('/admin/projects');
  await page.getByRole('button', { name: '新增專案' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('資料驗證失敗：');
  await expect(alert.locator('svg')).toHaveCount(1);
  await expect(page.getByLabel(/^專案名稱/)).toHaveAttribute('aria-invalid', 'true');

  const nav = page.getByRole('navigation', { name: '功能選單' });
  const selected = nav.getByRole('link', { name: '帳號管理' });
  const unselected = nav.getByRole('link', { name: '數據管理' });
  const weight = (l: typeof selected) => l.evaluate((el) => getComputedStyle(el).fontWeight);
  const bar = (l: typeof selected) => l.evaluate((el) => getComputedStyle(el).borderLeftColor);
  expect(Number(await weight(selected))).toBeGreaterThan(Number(await weight(unselected)));
  expect(await bar(selected)).not.toBe(await bar(unselected));

  for (const [name, matrix] of Object.entries(MATRICES)) {
    await page.evaluate(
      ([id, m]) => {
        document.getElementById('cvd-filter')?.remove();
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'cvd-filter';
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.innerHTML = `<filter id="cvd-${id}"><feColorMatrix type="matrix" values="${m}"/></filter>`;
        document.body.appendChild(svg);
        document.documentElement.style.filter = `url(#cvd-${id})`;
      },
      [name, matrix],
    );
    await snap(page, testInfo.project.name, `color-vision/${name}`);
  }
});
