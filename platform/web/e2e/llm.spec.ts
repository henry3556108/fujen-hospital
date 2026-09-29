import { expect, loginAs, test } from './fixtures';

// TC-B07-03、TC-B07-08：Playground 在瀏覽器裡的時間行為（MSW 模擬 API；數字要在甲方環境重跑）。
async function fault(page: import('@playwright/test').Page, mode: 'none' | 'down' | 'hang') {
  await page.evaluate(async (m) => {
    await fetch('/api/__mock/llm-fault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: m }) });
  }, mode);
}

async function openPlayground(page: import('@playwright/test').Page) {
  await loginAs(page, 'ca01');
  await page.goto('/llm/playground');
  await expect(page.getByRole('heading', { name: 'Playground' })).toBeVisible();
  await fault(page, 'none');
}

test.describe('LLM Playground', () => {
  test('TC-B07-03 20 則對話（Free Chat 與 Chat with Knowledge Base），每則回應後 10 秒內顯示', async ({ page }) => {
    test.setTimeout(120_000);
    await openPlayground(page);
    const input = page.getByRole('textbox', { name: '訊息' });
    const log = page.getByRole('list', { name: '對話內容' });
    let slowest = 0;
    for (let i = 1; i <= 20; i++) {
      if (i === 11) {
        await page.getByLabel('對話模式').selectOption('kb');
        await page.getByLabel('知識庫').selectOption({ index: 1 });
      }
      await input.fill(`第 ${i} 則`);
      const started = Date.now();
      await input.press('Enter');
      await expect(log.getByText(`[fake-llm] echo: 第 ${i} 則`, { exact: true })).toBeVisible({ timeout: 10_000 });
      slowest = Math.max(slowest, Date.now() - started);
    }
    await expect(log.locator('[data-role="assistant"]')).toHaveCount(10);
    await expect(log.getByText('出處：outpatient_hours.pdf')).toHaveCount(10);
    expect(slowest).toBeLessThan(10_000);
  });

  test('TC-B07-08 模型服務中斷時立即提示重試，頁面不卡住', async ({ page }) => {
    await openPlayground(page);
    await fault(page, 'down');
    const started = Date.now();
    await page.getByRole('textbox', { name: '訊息' }).fill('還在嗎');
    await page.getByRole('textbox', { name: '訊息' }).press('Enter');
    const failed = page.getByTestId('chat-failed');
    await expect(failed.getByRole('alert')).toContainText('可以直接重試', { timeout: 30_000 });
    expect(Date.now() - started).toBeLessThan(30_000);
    // 頁面仍可操作：換分頁、再輸入
    await expect(page.getByRole('textbox', { name: '訊息' })).toBeEnabled();
    await fault(page, 'none');
    await failed.getByRole('button', { name: '重試' }).click();
    await expect(page.getByText('[fake-llm] echo: 還在嗎', { exact: true })).toBeVisible();
  });

  test('TC-B07-03 模型沒有回應時 30 秒內提示重試', async ({ page }) => {
    test.setTimeout(90_000);
    await openPlayground(page);
    await fault(page, 'hang');
    const started = Date.now();
    await page.getByRole('textbox', { name: '訊息' }).fill('逾時測試');
    await page.getByRole('textbox', { name: '訊息' }).press('Enter');
    await expect(page.getByRole('status').filter({ hasText: '模型回應中' })).toBeVisible();
    // 等待期間其他分頁仍可切換（頁面沒有卡住）
    await page.getByRole('link', { name: 'Prompt 範本' }).click();
    await expect(page.getByRole('table', { name: 'Prompt 範本' })).toBeVisible();
    await page.getByRole('link', { name: 'Playground' }).click();
    await fault(page, 'hang');
    await page.getByRole('textbox', { name: '訊息' }).fill('逾時測試');
    const resent = Date.now();
    await page.getByRole('textbox', { name: '訊息' }).press('Enter');
    await expect(page.getByTestId('chat-failed').getByRole('alert')).toContainText('模型回應逾時，請重試', { timeout: 30_000 });
    expect(Date.now() - resent).toBeLessThan(30_000);
    expect(Date.now() - started).toBeGreaterThan(0);
    await fault(page, 'none');
    await page.getByTestId('chat-failed').getByRole('button', { name: '重試' }).click();
    await expect(page.getByText('[fake-llm] echo: 逾時測試', { exact: true })).toBeVisible();
  });
});
