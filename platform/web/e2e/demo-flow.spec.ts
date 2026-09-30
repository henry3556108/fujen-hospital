import type { Page } from '@playwright/test';
import { expect as baseExpect, loginAs, navLabels, test } from './fixtures';
import { fixture } from './files';

// 這台開發機由多個工作共用，負載高時 dev server 首次編譯頁面較慢：等待上限放寬到 15 秒
const expect = baseExpect.configure({ timeout: 15_000 });

// TC-D02-03 示範可重現：依教育訓練教材的無程式碼流程，逐步操作網頁。教材步驟見 docs/delivery/教育訓練示範流程.md。
// 全程用頁面上的連結與按鈕操作（與教材一致）；只有進入首頁用 page.goto。
// 測試模式的模擬 API 在重新載入頁面時會重設資料，所以每一段各自從首頁開始、不依賴其他段落建立的資料。
// 選擇器沿用各功能的 e2e 規格（imaging、tabular、labeling、inference、scheduling、fhir、llm）。

/** 從左側「功能選單」進入某個入口。 */
async function openEntry(page: Page, label: string) {
  await page.getByRole('navigation', { name: '功能選單' }).getByRole('link', { name: label, exact: true }).click();
}

/** 在工作台第一個視窗的畫布上拖曳；座標是畫布寬高的比例（0–1）。 */
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const canvas = page.getByTestId('viewport').first().locator('canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const at = ([x, y]: [number, number]) => [box.x + box.width * x, box.y + box.height * y] as const;
  await page.mouse.move(...at(from));
  await page.mouse.down();
  await page.mouse.move(...at([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]), { steps: 4 });
  await page.mouse.move(...at(to), { steps: 4 });
  await page.mouse.up();
}

const STUDY1 = [1, 2, 3].map((s) => fixture(`imaging/study_0001/series_001/IM000${s}.dcm`));
const DICOM = (i: number) => ({ name: `IM${String(i + 1).padStart(4, '0')}.dcm`, mimeType: 'application/dicom', buffer: Buffer.from(`synthetic-${i}`) });

test.describe('TC-D02-03 教育訓練示範流程', () => {
  test('段落 1：Admin 建立專案、指派成員；成員登入後看到對應入口', async ({ page }) => {
    const project = `DEMO-${Date.now()}`;
    await loginAs(page, 'admin01');
    await page.goto('/');
    await openEntry(page, '帳號管理');
    await page.getByRole('link', { name: '專案', exact: true }).click();

    const form = page.getByRole('form', { name: '新增專案' });
    await form.getByLabel('專案名稱（必填）').fill(project);
    await form.getByLabel('說明').fill('教育訓練示範');
    await form.getByRole('button', { name: '新增專案' }).click();
    await expect(page.getByText(`已新增專案「${project}」`)).toBeVisible();
    await expect(page.getByRole('table', { name: '專案列表' }).getByText(project)).toBeVisible();

    await page.getByRole('link', { name: '專案成員' }).click();
    const members = page.getByRole('form', { name: '設定專案成員' });
    await members.getByLabel('專案').selectOption({ label: project });
    await members.getByLabel('帳號').selectOption({ label: 'md01' });
    await members.getByLabel('角色').selectOption({ index: 0 });
    await members.getByRole('button', { name: '儲存成員設定' }).click();
    await expect(page.getByRole('table', { name: '本次設定的成員' })).toContainText('md01');

    await page.getByRole('button', { name: '登出' }).click();
    await expect(page.getByRole('heading', { name: '登入' })).toBeVisible();
    await page.getByLabel('測試帳號').selectOption('md01');
    await page.getByRole('button', { name: '登入' }).click();
    // 選單在登入後非同步載入帳號資訊才出現，先等它出現再讀（否則會讀到空選單）
    await expect(page.getByRole('navigation', { name: '功能選單' }).getByRole('link').first()).toBeVisible();
    const labels = await navLabels(page);
    expect(labels).not.toContain('帳號管理');
    expect(labels.length).toBeGreaterThan(0);
  });

  test('段落 2：上傳影像與 CSV、篩選、檢視統計', async ({ page }) => {
    await loginAs(page, 'ra01');
    await page.goto('/');
    await openEntry(page, '數據管理');

    // 影像：上傳 DICOM → 研究列表 → 篩選
    await page.getByRole('navigation', { name: '醫療影像分頁' }).getByRole('link', { name: '匯入影像' }).click();
    const dicom = page.getByRole('form', { name: 'DICOM' });
    await dicom.getByLabel(/^選擇檔案/).setInputFiles(STUDY1);
    await expect(dicom.getByText('已選擇 3 個檔案')).toBeVisible();
    await dicom.getByRole('button', { name: '上傳DICOM' }).click();
    await expect(dicom.getByRole('region', { name: 'DICOM 匯入結果' })).toContainText('匯入 3、重複 0、失敗 0');
    await dicom.getByRole('link', { name: '到研究列表查看' }).click();
    await expect(page.getByText(/^共 7 個研究/)).toBeVisible();
    await expect(page.getByRole('table', { name: '研究列表' }).getByRole('row', { name: /ACC0001/ })).toContainText('CT CHEST WO CONTRAST');
    await page.getByLabel(/^Study Description/).fill('chest');
    await page.getByRole('button', { name: '套用篩選' }).click();
    await expect(page.getByText(/^共 \d+ 個研究（已套用 1 個篩選條件）/)).toBeVisible();
    await expect(page.getByRole('table', { name: '研究列表' }).getByRole('row', { name: /ACC0001/ })).toBeVisible();

    // 結構式資料：上傳 CSV 與結構定義 → 開啟資料集 → 描述統計、相關矩陣
    await page.getByRole('navigation', { name: '數據管理分頁' }).getByRole('link', { name: '結構式資料' }).click();
    const csv = page.getByRole('form', { name: '上傳 CSV' });
    await csv.getByLabel(/^CSV 檔案/).setInputFiles(fixture('tabular/cohort_01.csv'));
    await csv.getByLabel('資料集名稱').fill('demo-cohort');
    await csv.getByLabel(/^載入結構定義檔/).setInputFiles(fixture('tabular/schema.json'));
    await expect(csv.getByLabel('結構定義（JSON）')).toHaveValue(/"patient_id"/);
    await csv.getByRole('button', { name: '上傳並驗證' }).click();
    await expect(page.getByRole('region', { name: '「demo-cohort」的上傳結果' })).toContainText('共 100 列，通過 100 列，拒絕 0 列');
    await page.getByRole('link', { name: '開啟資料集「demo-cohort」' }).click();
    await expect(page.getByRole('heading', { name: '資料集：demo-cohort' })).toBeVisible();

    const tabs = page.getByRole('navigation', { name: '資料集分頁' });
    await tabs.getByRole('link', { name: '描述統計' }).click();
    await expect(page.getByRole('table', { name: '描述統計' }).getByRole('row', { name: /^age / })).toBeVisible();
    await expect(page.getByRole('figure', { name: 'age 的分布' }).getByRole('img').first()).toBeVisible();
    await tabs.getByRole('link', { name: '相關與散佈圖' }).click();
    await page.getByRole('button', { name: '產生相關矩陣' }).click();
    await expect(page.getByRole('table', { name: '相關矩陣（pearson）' }).getByRole('row', { name: /^sbp/ })).toBeVisible();
  });

  test('段落 3：影像標註、自動標註、修改後儲存', async ({ page }) => {
    test.setTimeout(90_000);
    await loginAs(page, 'ra01');
    await page.goto('/');
    await openEntry(page, '影像標註');

    // 從研究清單開啟工作台，做一筆分類與一筆偵測標註
    await page.getByRole('link', { name: '開啟 ACC0001 的標註工作台' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '影像標註工作台' })).toBeVisible();
    await expect(page.getByTestId('viewport').first()).toHaveAttribute('data-ready', '1');
    const status = page.getByTestId('workbench-status');
    const kinds = page.getByRole('group', { name: '標註種類' });
    await kinds.getByRole('button', { name: '分類', exact: true }).click();
    await page.getByLabel('標籤', { exact: true }).fill('nodule');
    await page.getByRole('button', { name: '儲存分類標註' }).click();
    await expect(status).toContainText(/已儲存分類標註 #\d+/);
    await kinds.getByRole('button', { name: '偵測', exact: true }).click();
    await page.getByLabel('標籤', { exact: true }).fill('nodule');
    await drag(page, [0.25, 0.25], [0.5, 0.625]);
    await expect(page.getByRole('list', { name: '草稿中的框' }).getByRole('listitem')).toHaveCount(1);
    await page.getByRole('button', { name: '儲存偵測標註' }).click();
    await expect(status).toContainText(/已儲存偵測標註 #\d+（1 個框/);
    await expect(page.getByRole('table', { name: '標註清單' }).locator('tbody tr')).toHaveCount(2);

    // 自動標註 → 在工作台開啟 → 刪一個框、補畫一個框 → 儲存為新版本
    await openEntry(page, '自動影像分類標註');
    await expect(page.getByLabel('影像', { exact: true })).toBeEnabled();
    await page.getByLabel('模型').selectOption('fake_detection');
    await page.getByRole('button', { name: '送出自動標註' }).click();
    await expect(page.getByTestId('autolabel-result')).toContainText('自動標註完成');
    await page.getByRole('link', { name: '在標註工作台開啟編輯' }).click();
    await expect(page.getByTestId('viewport').first()).toHaveAttribute('data-ready', '1');
    await expect(status).toContainText(/編輯標註 #\d+（偵測，自動標註）/);
    const id = Number((await status.textContent())!.match(/#(\d+)/)![1]);
    const draft = page.getByRole('list', { name: '草稿中的框' });
    await expect(draft.getByRole('listitem')).toHaveCount(2);
    await page.getByRole('button', { name: '刪除第 2 個框' }).click();
    await page.getByLabel('標籤', { exact: true }).fill('nodule');
    await drag(page, [0.5, 0.5], [0.75, 0.75]);
    await expect(draft.getByRole('listitem')).toHaveCount(2);
    await page.getByRole('button', { name: '儲存偵測標註' }).click();
    await expect(status).toContainText(`已儲存偵測標註 #${id}（2 個框，版本 2）`);
    await expect(page.getByRole('table', { name: '標註清單' }).locator('tbody tr[data-source="autolabel"]')).toHaveCount(1);
  });

  test('段落 4：建立訓練、匯出模型、部署與推論', async ({ page }) => {
    test.setTimeout(90_000);
    // pi01（Principal Investigator）有 Training 與 Coding：可訓練、下載模型、匯出原始碼、部署
    await loginAs(page, 'pi01');
    await page.goto('/');

    // 建模管理：新增影像分類的訓練設定（資料來源＝影像標註平台的標註），存檔後送出訓練
    await openEntry(page, '建模管理');
    await page.getByRole('button', { name: '新增訓練設定' }).click();
    const form = page.getByRole('form', { name: '新增訓練設定' });
    await form.getByLabel('設定名稱').fill('demo-modality');
    await form.getByLabel('訓練種類').selectOption('image_classification');
    await form.getByLabel('標註來源').selectOption('annotations');
    await form.getByLabel('Label（以逗號分隔）').fill('CT, MR');
    await form.getByLabel('Resize 高（像素）').fill('64');
    await form.getByLabel('Resize 寬（像素）').fill('64');
    await form.getByLabel('亂數種子').fill('7');
    await form.getByLabel('旋轉角度範圍（度）').fill('10');
    await form.getByRole('checkbox', { name: '水平翻轉' }).check();
    await form.getByRole('button', { name: '儲存設定' }).click();
    await expect(page.getByText('已新增訓練設定「demo-modality」。')).toBeVisible();
    await page.getByRole('button', { name: '送出訓練「demo-modality」' }).click();
    await expect(page.getByText(/^完成：已送出訓練 #1（demo-modality），目前排隊中。$/)).toBeVisible();

    // 狀態自動更新：排隊中 → 執行中 → 已完成，看指標
    const status = page.getByTestId('run-status');
    await expect(status).toContainText('已完成');
    await expect(page.getByRole('table', { name: '訓練 #1 的指標' })).toContainText('test.accuracy');

    // 模型匯出：下載 Keras H5、匯出原始碼
    const model = page.waitForEvent('download');
    await page.getByRole('button', { name: '下載模型（H5）' }).click();
    expect((await model).suggestedFilename()).toBe('demo-modality-run1.h5');
    const source = page.waitForEvent('download');
    await page.getByRole('button', { name: '匯出原始碼' }).click();
    expect((await source).suggestedFilename()).toBe('training-run-1-source.zip');

    // AI 模型部署：部署剛訓練好的模型，授權 md01 與 pi01，看呼叫端點
    await openEntry(page, 'AI 模型部署');
    const deploy = page.getByRole('form', { name: '部署模型' });
    await deploy.getByLabel('模型').selectOption({ label: 'demo-modality-run1（影像分類，H5）' });
    await deploy.getByLabel('部署名稱（小寫英數字與 -）').fill('demo-modality');
    await deploy.getByLabel('授權帳號（以逗號分隔）').fill('md01, pi01');
    await deploy.getByRole('button', { name: '部署' }).click();
    await expect(page.getByText('已部署「demo-modality」：POST /api/inference/demo-modality/predict')).toBeVisible();
    await expect(page.getByRole('table', { name: '線上部署清單' }).getByRole('row', { name: /demo-modality/ })).toContainText('md01、pi01');

    // 推論：選已訓練完成的模型，上傳影像推論
    await openEntry(page, '推論服務管理');
    await expect(page.getByRole('heading', { level: 1, name: '推論服務管理' })).toBeVisible();
    await page.getByRole('button', { name: '選擇 modality-cnn-run2' }).click();
    await page.getByLabel('影像檔').setInputFiles([DICOM(0), DICOM(1)]);
    await page.getByRole('button', { name: '上傳並推論' }).click();
    const cards = page.getByTestId('image-result');
    await expect(cards).toHaveCount(2);
    await expect(cards.first().getByTestId('result-label')).toHaveText(/^分類：(CT|MR)（\d+%）$/);
    await expect(page.getByRole('table', { name: '推論歷史' }).getByRole('button', { name: '下載 #1' })).toBeVisible();
  });

  test('段落 5：FHIR 資料來源、對應規則、排程', async ({ page }) => {
    await loginAs(page, 'admin01');
    await page.goto('/');
    await openEntry(page, '帳號管理');
    await page.getByRole('navigation', { name: '帳號管理分頁' }).getByRole('link', { name: '資料交換（FHIR）' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '醫療資料交換（FHIR）' })).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'FHIR 分頁' });

    // 來源：貼上 CSV 內容
    await tabs.getByRole('link', { name: '來源與對應' }).click();
    const source = page.getByRole('form', { name: '新增來源' });
    await source.getByLabel('來源名稱（必填）').fill('demo-encounters');
    await source.getByLabel('來源類型').selectOption('csv');
    await source.getByLabel('內容').fill('patient_id,encounter_id,start\nSYN-0001,E001,2024-01-02\n');
    await source.getByRole('button', { name: '新增來源' }).click();
    await expect(page.getByText('已新增來源「demo-encounters」')).toBeVisible();
    await expect(page.getByRole('table', { name: '來源列表' }).getByRole('row', { name: /demo-encounters/ })).toContainText('CSV');

    // 對應規則：加入內建規則
    await page.getByLabel('內建規則').selectOption('csv-encounter');
    await page.getByRole('button', { name: '加入', exact: true }).click();
    await expect(page.getByText('已加入對應規則「csv-encounter」')).toBeVisible();
    await expect(page.getByRole('table', { name: '對應規則列表' }).getByRole('row', { name: /csv-encounter/ })).toContainText('Encounter');

    // 手動執行一次轉換
    const run = page.getByRole('form', { name: '執行轉換' });
    await run.getByLabel('來源').selectOption({ label: 'demo-encounters' });
    await run.getByLabel('對應規則').selectOption({ label: 'csv-encounter' });
    await run.getByRole('button', { name: '執行' }).click();
    await expect(run.getByText(/執行 #\d+ 成功：讀取 \d+ 筆，寫入 Encounter \d+/)).toBeVisible();

    // 排程：定時抓取同一個來源
    await tabs.getByRole('link', { name: '排程' }).click();
    const schedule = page.getByRole('form', { name: '新增排程' });
    await schedule.getByLabel('排程名稱（必填）').fill('demo-每小時');
    await schedule.getByLabel('來源').selectOption({ label: 'demo-encounters' });
    await schedule.getByLabel('對應規則').selectOption({ label: 'csv-encounter' });
    await schedule.getByLabel(/^間隔/).fill('60');
    await schedule.getByRole('button', { name: '新增排程' }).click();
    await expect(page.getByText('已新增排程「demo-每小時」')).toBeVisible();
    const row = page.getByRole('table', { name: '排程列表' }).getByRole('row', { name: /demo-每小時/ });
    await expect(row).toContainText('demo-encounters／csv-encounter');
    await expect(row).toContainText('啟用');
  });

  test('段落 6：LLM Playground、知識庫、發布 API', async ({ page }) => {
    await loginAs(page, 'ca01');
    await page.goto('/');
    await openEntry(page, 'LLM No-code 開發');
    const tabs = page.getByRole('navigation', { name: 'LLM 功能分頁' });

    // Playground：Free Chat
    await expect(page.getByRole('heading', { name: 'Playground' })).toBeVisible();
    const input = page.getByRole('textbox', { name: '訊息' });
    const log = page.getByRole('list', { name: '對話內容' });
    await input.fill('門診時間是幾點？');
    await input.press('Enter');
    await expect(log.getByText('[fake-llm] echo: 門診時間是幾點？', { exact: true })).toBeVisible();

    // 知識庫：新增、上傳文件
    await tabs.getByRole('link', { name: '知識庫' }).click();
    await page.getByRole('form', { name: '新增知識庫' }).getByLabel('知識庫名稱').fill('示範知識庫');
    await page.getByRole('button', { name: '新增知識庫' }).click();
    await expect(page.getByRole('heading', { name: '文件（示範知識庫）' })).toBeVisible();
    await page.getByLabel(/^選擇檔案/).setInputFiles({ name: 'visiting_hours.txt', mimeType: 'text/plain', buffer: Buffer.from('探病時間為每日 10:00–20:00。', 'utf8') });
    await page.getByRole('button', { name: '上傳並建立向量' }).click();
    await expect(page.getByText('寫入 1 份、重複 0 份、失敗 0 份')).toBeVisible();
    await expect(page.getByRole('list', { name: '已寫入的文件' })).toContainText('visiting_hours.txt');

    // Playground：Chat with Knowledge Base，回答附出處
    await tabs.getByRole('link', { name: 'Playground' }).click();
    await page.getByLabel('對話模式').selectOption('kb');
    await page.getByLabel('知識庫').selectOption({ label: '示範知識庫（1 份文件）' });
    await input.fill('探病時間？');
    await input.press('Enter');
    await expect(log.getByText('[fake-llm] echo: 探病時間？', { exact: true })).toBeVisible();
    await expect(log.getByText(/^出處：/)).toBeVisible();

    // 發布為內部 API
    await tabs.getByRole('link', { name: '發布 API' }).click();
    const publish = page.getByRole('form', { name: '發布為內部 API' });
    await publish.getByLabel(/^服務代號/).fill('demo-qa');
    await publish.getByLabel('名稱').fill('示範問答');
    await publish.getByLabel('知識庫').selectOption({ label: '示範知識庫' });
    await publish.getByLabel(/^授權帳號/).fill('pi01');
    await publish.getByRole('button', { name: '發布' }).click();
    await expect(publish.getByText('已發布「示範問答」：POST /api/llm-services/demo-qa/invoke')).toBeVisible();
    await expect(page.getByRole('table', { name: '已發布的服務' }).getByRole('row', { name: /示範問答/ })).toContainText('啟用');
  });
});
