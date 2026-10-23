import { expect, test } from '@playwright/test';
import { P1, login, note, useProject } from './helpers';
import { psql } from './ops';
import { shotUrl } from './r-common';

// M1 補拍 07：vw01（Viewer）越權操作 10 次（TC-A03-05）。
const TC = 'TC-A03-05';

test('M1 補拍 07 越權操作 10 次（TC-A03-05）', async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const ds = psql(`select t.id from tabular_datasets t join projects p on p.id=t.project_id where p.name='${P1}' order by t.id limit 1`);
  expect(ds).toMatch(/^\d+$/);
  const deny = (perm: string, entry: string) => `你在專案「${P1}」沒有 ${perm} 權限，無法使用「${entry}」。`;
  const CASES: [string, string, string, string][] = [
    ['/training', '01-建模管理', 'Training', deny('Training', '建模管理')],
    ['/training/jobs', '02-專案工作', 'Training', deny('Training', '建模管理')],
    [`/data/tabular/${ds}/target`, '03-儲存Target', 'Training', `沒有權限：你在專案「${P1}」沒有 Training 權限，無法儲存 Target 與 Feature 設定。`],
    ['/labeling', '04-影像標註', 'Labeling', deny('Labeling', '影像標註')],
    ['/auto-labeling', '05-自動影像分類標註', 'Labeling', deny('Labeling', '自動影像分類標註')],
    ['/labeling/studies/1.2.3', '06-標註工作台', 'Labeling', deny('Labeling', '影像標註')],
    ['/llm/playground', '07-LLM-Playground', 'Coding', deny('Coding', 'LLM No-code 開發')],
    ['/llm/prompts', '08-Prompt範本', 'Coding', deny('Coding', 'LLM No-code 開發')],
    ['/llm/knowledge', '09-知識庫', 'Coding', deny('Coding', 'LLM No-code 開發')],
    ['/llm/workflows', '10-工作流', 'Coding', deny('Coding', 'LLM No-code 開發')],
  ];
  await login(page, 'vw01');
  await useProject(page);
  let shown = 0;
  let saveButtons = 0;
  for (const [i, [url, name, perm, msg]] of CASES.entries()) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    const hint = page.getByText(msg).first();
    await expect(hint).toBeVisible();
    const visible = await hint.isVisible();
    if (visible) shown++;
    let extra = '';
    if (i === 2) {
      saveButtons = await page.getByRole('button', { name: /儲存/ }).count();
      extra = `；儲存按鈕 ${saveButtons} 個`;
      await hint.scrollIntoViewIfNeeded();
    }
    await shotUrl(page, TC, name);
    note(TC, `第 ${i + 1} 次 ${url}（缺 ${perm}）：提示「${msg}」${visible ? '有' : '無'}${extra}`);
  }
  note(TC, `vw01 越權 10 次：越權成功 0/10，提示 ${shown}/10（資料集編號 ${ds}）`);
  expect(shown).toBe(10);
  expect(saveButtons).toBe(0);
});
