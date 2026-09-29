import { expect as baseExpect, loginAs, test } from './fixtures';

// 這台開發機由多個工作共用，負載高時 dev server 首次編譯頁面較慢：等待上限放寬到 15 秒
const expect = baseExpect.configure({ timeout: 15_000 });
import { fixture } from './files';

const STUDY1 = [1, 2, 3].map((s) => fixture(`imaging/study_0001/series_001/IM000${s}.dcm`));

test.describe('影像匯入', () => {
  test('TC-B01-02／TC-B01-05 同一批有好檔與壞檔：好檔匯入、壞檔列出檔名與原因，研究出現在列表', async ({ page }) => {
    await loginAs(page, 'ra01');
    await page.goto('/data/imaging/import');
    const form = page.getByRole('form', { name: 'DICOM' });
    await form.getByLabel(/^選擇檔案/).setInputFiles([...STUDY1, fixture('imaging/not-dicom.dcm'), fixture('imaging/truncated.dcm')]);
    await expect(form.getByText('已選擇 5 個檔案')).toBeVisible();
    await form.getByRole('button', { name: '上傳DICOM' }).click();

    const result = form.getByRole('region', { name: 'DICOM 匯入結果' });
    await expect(result).toContainText('匯入 3、重複 0、失敗 2');
    const rows = result.getByRole('table').getByRole('row');
    await expect(rows.nth(1)).toContainText('IM0001.dcm');
    await expect(rows.nth(1)).toContainText('已匯入');
    await expect(rows.nth(4)).toContainText('not-dicom.dcm');
    await expect(rows.nth(4)).toContainText('不是 DICOM 檔案（缺少 DICM 檔頭或格式錯誤）');
    await expect(rows.nth(5)).toContainText('truncated.dcm');
    await expect(rows.nth(5)).toContainText('失敗');

    await form.getByRole('link', { name: '到研究列表查看' }).click();
    await expect(page.getByText(/^共 7 個研究/)).toBeVisible();
    const study = page.getByRole('table', { name: '研究列表' }).getByRole('row', { name: /ACC0001/ });
    await expect(study).toContainText('CT CHEST WO CONTRAST');

    // 重新載入後仍在（TC-B01-06：再匯入一次不會多出影像）
    await page.goto('/data/imaging/import');
    await form.getByLabel(/^選擇檔案/).setInputFiles(STUDY1);
    await form.getByRole('button', { name: '上傳DICOM' }).click();
    await expect(form.getByRole('region', { name: 'DICOM 匯入結果' })).toContainText('匯入 0、重複 3、失敗 0');
    await page.goto('/data/imaging');
    await expect(page.getByText(/^共 7 個研究/)).toBeVisible();
  });

  test('TC-B01-03 NIfTI、ITK 匯入後自動配對', async ({ page }) => {
    await loginAs(page, 'ra01');
    await page.goto('/data/imaging/import');
    const form = page.getByRole('form', { name: 'NIfTI、ITK、makesense' });
    await form
      .getByLabel(/^選擇檔案/)
      .setInputFiles(['case01_image.nii.gz', 'case01_label.nii.gz', 'case02_image.mha', 'case02_label.mha'].map((f) => fixture(`imaging/${f}`)));
    await form.getByRole('button', { name: /^上傳NIfTI/ }).click();
    await expect(form.getByRole('region', { name: '檔案匯入結果' })).toContainText('匯入 4、重複 0、失敗 0');
    await form.getByRole('link', { name: '到檔案與配對查看' }).click();
    const table = page.getByRole('table', { name: '檔案列表' });
    await expect(table.getByRole('row', { name: /^case01_label\.nii\.gz/ })).toContainText('已配對');
    await expect(table.getByRole('row', { name: /^case02_label\.mha/ })).toContainText('case02_image.mha');
    await expect(page.getByText('共 4 個檔案，0 個標註尚未配對')).toBeVisible();
  });

  test('TC-A03-05 vw01 沒有 Labeling 權限：看不到上傳表單，仍可看研究列表', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/data/imaging/import');
    await expect(page.getByText('你在專案「P1-lung-ct」沒有 Labeling 權限，無法匯入影像。')).toBeVisible();
    await expect(page.getByRole('form')).toHaveCount(0);
    await page.goto('/data/imaging');
    await expect(page.getByText(/^共 6 個研究/)).toBeVisible();
  });
});

test.describe('研究列表篩選', () => {
  test('TC-B01-09 以 5 個欄位各篩選 1 次，結果沒有不符的列', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/data/imaging');
    await expect(page.getByText(/^共 6 個研究/)).toBeVisible();
    const table = page.getByRole('table', { name: '研究列表' });
    const column = async (index: number) => {
      const rows = await table.getByRole('row').all();
      return Promise.all(rows.slice(1).map(async (r) => (await r.locator('th,td').nth(index).textContent()) ?? ''));
    };
    const apply = async (count: number) => {
      await page.getByRole('button', { name: '套用篩選' }).click();
      await expect(page.getByText(new RegExp(`^共 ${count} 個研究（已套用 1 個篩選條件）`))).toBeVisible();
    };
    const clear = async () => {
      await page.getByRole('button', { name: '清除篩選' }).click();
      await expect(page.getByText(/^共 6 個研究$/)).toBeVisible();
    };

    await page.getByLabel('Modality').selectOption('MR');
    await apply(2);
    expect((await column(4)).filter((v) => v !== 'MR')).toEqual([]);
    await clear();

    await page.getByLabel("Patient's Sex").selectOption('F');
    await apply(3);
    expect((await column(3)).filter((v) => v !== 'F')).toEqual([]);
    await clear();

    await page.getByLabel(/^Study Description/).fill('chest');
    await apply(3);
    expect((await column(5)).filter((v) => !/CHEST/i.test(v))).toEqual([]);
    await clear();

    await page.getByLabel('Study Date 起').fill('2024-03-01');
    await page.getByLabel('Study Date 迄').fill('2024-05-31');
    await apply(3);
    expect((await column(0)).filter((v) => v < '2024-03-01' || v > '2024-05-31')).toEqual([]);
    await expect(page).toHaveURL(/study_date=20240301-20240531/);
    await page.reload();
    await expect(page.getByText(/^共 3 個研究（已套用 1 個篩選條件）/)).toBeVisible();
    await expect(page.getByLabel('Study Date 起')).toHaveValue('2024-03-01');
    await clear();

    await page.getByLabel(/^Series Description/).fill('lung');
    await apply(2);
    expect((await column(6)).filter((v) => !/LUNG/i.test(v))).toEqual([]);
  });

  test('研究明細從列表開啟', async ({ page }) => {
    await loginAs(page, 'vw01');
    await page.goto('/data/imaging');
    await page.getByRole('link', { name: '檢視研究 ACC0013' }).click();
    await expect(page.getByRole('region', { name: '研究資訊' })).toContainText('MR BRAIN WWO CONTRAST');
    await expect(page.getByRole('table', { name: '序列列表' }).getByRole('row', { name: /AX T1/ })).toContainText('5');
  });
});

test.describe('Accession 清單與 PACS', () => {
  test('TC-B01-08 Admin 設定清單後，清單外的研究在列表與直接網址都看不到', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/data/imaging/allowlist');
    await page.getByLabel(/^Accession Number/).fill('ACC0011\nACC0013');
    await page.getByRole('button', { name: '儲存清單' }).click();
    await expect(page.getByText('已儲存 Accession 清單，共 2 筆')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('list', { name: '清單內的 Accession Number' }).getByRole('listitem')).toHaveText(['ACC0011', 'ACC0013']);

    await page.goto('/data/imaging');
    await expect(page.getByText(/^共 2 個研究/)).toBeVisible();
    let outside = 0;
    for (const no of [12, 14, 15, 16, 12]) {
      await page.goto(`/data/imaging/studies/1.2.826.0.1.3680043.10.9999.88.1.${no}`);
      await expect(page.getByRole('alert')).toContainText('找不到研究，或不在本專案的 Accession 清單內');
      outside += await page.getByRole('region', { name: '研究資訊' }).count();
    }
    expect(outside).toBe(0);
  });

  test('TC-B01-07 向 PACS 查詢並取回研究', async ({ page }) => {
    await loginAs(page, 'ra01');
    await page.goto('/data/imaging/pacs');
    await page.getByLabel('Modality').fill('MR');
    await page.getByRole('button', { name: '查詢 PACS' }).click();
    await expect(page.getByText('PACS 回覆 2 個研究')).toBeVisible();
    await page.getByRole('button', { name: '取回 ACC0004' }).click();
    await expect(page.getByRole('region', { name: 'PACS 取像結果' })).toContainText('匯入 3、重複 0、失敗 0');
    await page.getByRole('link', { name: '到研究列表查看' }).click();
    await expect(page.getByRole('table', { name: '研究列表' }).getByRole('row', { name: /ACC0004/ })).toContainText('MR KNEE WO CONTRAST');
    await page.goto('/data/imaging/jobs');
    await expect(page.getByRole('table', { name: '匯入工作列表' }).getByRole('row', { name: /^1 / })).toContainText('PACS 取像');
  });
});
