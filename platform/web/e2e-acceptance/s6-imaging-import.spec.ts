import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { EVIDENCE_DIR, P1, login, note, shot, useProject } from './helpers';

// 情境 6：數據管理與影像匯入（TC-B01-01～10）。照 docs/acceptance-kit/m1/B-01 劇本：
// 終端機部分（匯入程式、kit_check、稽核查詢）由本腳本呼叫並存檔；網頁部分以 admin01／ra01／pi01 三個獨立瀏覽器環境操作。
// 會新增 5 個 M1-* 專案、把 20 個研究匯入 P1-lung-ct、把 pi01 加入 P2-tabular 並上傳 4 份 CSV（資料留著給後面的情境用）。

const REPO = path.resolve(process.cwd(), '../..') // 在 platform/web 執行;
const KIT = path.join(REPO, 'docs/acceptance-kit/m1');
const IMPORTER = path.join(REPO, 'platform/tools/importer');
const ENV = {
  ...process.env,
  PYTHONUNBUFFERED: '1', // device-code 網址要即時印出，否則被緩衝讀不到
  GATEWAY_URL: process.env.GATEWAY_URL || 'http://localhost:38980',
  KEYCLOAK_URL: process.env.KEYCLOAK_URL || 'http://localhost:38180',
};
const NEW_PROJECTS = ['M1-pair-together', 'M1-pair-separate', 'M1-badfiles', 'M1-pacs', 'M1-accession'];

/** 在匯入程式目錄執行指令，輸出存到 <案例>/<檔名>.txt，回傳 { out, code } */
function sh(tc: string, file: string, cmd: string, input?: string) {
  let out = '';
  let code = 0;
  try {
    out = execSync(cmd, { cwd: IMPORTER, env: ENV, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/bash' });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    code = err.status ?? 1;
  }
  const dir = path.join(EVIDENCE_DIR, tc);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${file}.txt`), `$ ${cmd}\n${out}\n結束碼 ${code}\n`);
  const last = out.trim().split('\n').slice(-1)[0];
  note(tc, `${file}：${last}（結束碼 ${code}）`);
  return { out, code };
}
const upload = (tc: string, file: string, project: string, args: string) =>
  sh(tc, file, `uv run python -m importer upload --project ${project} ${args}`);

test.describe.configure({ mode: 'serial' });

let admin: Page, ra: Page, pi: Page;
const ctxs: BrowserContext[] = [];

async function imagingTab(p: Page, project: string, tab: string) {
  await useProject(p, project);
  await p.goto('/data/imaging');
  await useProject(p, project);
  await p.getByRole('link', { name: tab, exact: true }).first().click();
}

test.beforeAll(async ({ browser }) => {
  for (let i = 0; i < 3; i++) ctxs.push(await browser.newContext());
  [admin, ra, pi] = await Promise.all(ctxs.map((c) => c.newPage()));
  await login(admin, 'admin01');
  await login(ra, 'ra01');
  await login(pi, 'pi01');
  execSync('uv sync -q', { cwd: IMPORTER, env: ENV, shell: '/bin/bash' });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close();
});

test('準備：admin01 建立 5 個 M1 專案、加入成員；模擬 PACS 放入 2 個研究', async () => {
  const tc = '情境6-準備';
  await admin.goto('/admin/projects');
  for (const name of NEW_PROJECTS) {
    await admin.getByLabel('專案名稱（必填）').fill(name);
    await admin.getByRole('button', { name: '新增專案' }).click();
    await expect(admin.getByText(`已新增專案「${name}」`)).toBeVisible();
  }
  await shot(admin, tc, '01-新增5個專案');
  await admin.goto('/admin/members');
  const addMember = async (project: string, user: string, role: string, roleLabel: string) => {
    await admin.locator('#member-project').selectOption({ label: project });
    await admin.locator('#member-user').selectOption({ label: user });
    await admin.locator('#member-role').selectOption(role);
    await admin.getByRole('button', { name: '加入專案' }).click();
    await expect(admin.getByText(`已將「${user}」設定為「${project}」的 ${roleLabel}`)).toBeVisible();
  };
  for (const name of NEW_PROJECTS) await addMember(name, 'ra01', 'research_assistant', 'Research Assistant');
  await addMember('P2-tabular', 'pi01', 'principal_investigator', 'Principal Investigator');
  await shot(admin, tc, '02-加入成員');
  sh(tc, '03-模擬PACS放入研究',
    `for f in "${KIT}"/data/pacs/study_000*/series_001/*.dcm; do curl -s -u pacs-admin:pacs-dev -X POST --data-binary @"$f" http://127.0.0.1:38943/instances | grep -o '"Status" : "[A-Za-z]*"'; done`);
  await ra.reload();
  await pi.reload();
});

test('TC-B01-01 批次匯入需登入（device-code 登入）', async () => {
  const tc = 'TC-B01-01';
  sh(tc, '01-登出', 'uv run python -m importer logout');
  const r = upload(tc, '02-未登入匯入', P1, `--exclude manifest.json "${KIT}/data/dicom"`);
  expect(r.code).toBe(2);
  expect(r.out).toContain('尚未登入或登入已失效');
  await imagingTab(ra, P1, '匯入工作');
  await expect(ra.getByText('這個專案還沒有匯入工作')).toBeVisible();
  await shot(ra, tc, '03-匯入工作-沒有新增工作');

  // device-code：匯入程式印出網址，用 ra01 的瀏覽器開啟並同意
  const proc = spawn('uv', ['run', 'python', '-m', 'importer', 'login'], { cwd: IMPORTER, env: ENV });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  await expect.poll(() => /https?:\/\/\S+user_code=\S+/.test(log), { timeout: 30_000 }).toBe(true);
  const url = log.match(/https?:\/\/\S+user_code=[\w-]+/)![0];
  await ra.goto(url);
  await shot(ra, tc, '04-device-code-授權');
  for (const name of [/^(提交|Submit|送出)$/, /^(是|Yes)$/]) {
    const b = ra.getByRole('button', { name });
    if (await b.count()) await b.first().click();
  }
  await expect(ra.getByText(/裝置登入成功|Device Login Successful/)).toBeVisible();
  await shot(ra, tc, '05-device-code-登入成功');
  await new Promise<void>((res) => proc.on('exit', () => res()));
  fs.writeFileSync(path.join(EVIDENCE_DIR, tc, '06-登入.txt'), log);
  expect(log).toContain('已登入');
  note(tc, '未登入匯入被拒（結束碼 2），device-code 登入成功');
});

test('TC-B01-02 DICOM 批次匯入 20 個研究', async () => {
  const tc = 'TC-B01-02';
  const r = upload(tc, '01-匯入', P1, `--exclude manifest.json "${KIT}/data/dicom"`);
  expect(r.out).toContain('匯入 100、重複 0、失敗 0');
  const c = sh(tc, '02-筆數', `uv run python "${KIT}/tools/kit_check.py" counts --project ${P1}`);
  expect(c.out).toContain('筆數差異：0');
  await imagingTab(ra, P1, '研究列表');
  await expect(ra.getByText(/共 20 個研究/)).toBeVisible();
  await shot(ra, tc, '03-研究列表-20個研究');
  await ra.getByRole('link', { name: '匯入工作', exact: true }).first().click();
  await expect(ra.getByRole('table', { name: '匯入工作列表' })).toBeVisible();
  await shot(ra, tc, '04-匯入工作');
  sh(tc, '05-稽核', `kubectl -n ai-platform exec statefulset/postgres -- psql -U platform -d platform -c "select id, at, actor, category, action, target, result, source_ip, detail from audit_log where category='dataset' and action='imaging.import_dicom' order by id desc limit 5"`);
});

test('TC-B01-03 NIfTI、ITK、makesense 各 3 筆', async () => {
  const tc = 'TC-B01-03';
  for (const kind of ['nifti', 'itk', 'makesense']) {
    const r = upload(tc, kind, P1, `--exclude manifest.json "${KIT}/data/${kind}"`);
    expect(r.out).toMatch(/匯入 \d+、重複 0、失敗 0/);
  }
  await imagingTab(ra, P1, '檔案與配對');
  await expect(ra.getByText('共 15 個檔案，0 個標註尚未配對')).toBeVisible();
  await shot(ra, tc, '01-檔案與配對-15個檔案');
});

test('TC-B01-04 影像與標註配對（同時 3 次、個別 3 次）', async () => {
  const tc = 'TC-B01-04';
  const T = 'M1-pair-together', S = 'M1-pair-separate';
  upload(tc, '同時1-nifti', T, `--exclude manifest.json "${KIT}/data/nifti"`);
  upload(tc, '同時2-itk', T, `--exclude manifest.json "${KIT}/data/itk"`);
  upload(tc, '同時3-makesense與DICOM', T, `"${KIT}/data/pairing/makesense_with_dicom"`);
  await imagingTab(ra, T, '檔案與配對');
  await expect(ra.getByText('共 15 個檔案，0 個標註尚未配對')).toBeVisible();
  await shot(ra, tc, '01-同時匯入-全部配對');

  upload(tc, '個別1-標註', S, `--exclude manifest.json --exclude '*_image*' "${KIT}/data/nifti"`);
  upload(tc, '個別2-標註', S, `--exclude manifest.json --exclude '*_image*' "${KIT}/data/itk"`);
  upload(tc, '個別3-標註', S, `--exclude '*.dcm' "${KIT}/data/pairing/makesense_with_dicom"`);
  await imagingTab(ra, S, '檔案與配對');
  await expect(ra.getByText('共 9 個檔案，9 個標註尚未配對')).toBeVisible();
  await shot(ra, tc, '02-個別匯入-只有標註-尚未配對');
  upload(tc, '個別1-影像', S, `--exclude manifest.json --exclude '*_label*' "${KIT}/data/nifti"`);
  upload(tc, '個別2-影像', S, `--exclude manifest.json --exclude '*_label*' "${KIT}/data/itk"`);
  upload(tc, '個別3-影像', S, `--exclude '*.json' "${KIT}/data/pairing/makesense_with_dicom"`);
  await ra.getByRole('button', { name: '重新整理' }).click();
  await expect(ra.getByText('共 15 個檔案，0 個標註尚未配對')).toBeVisible();
  await shot(ra, tc, '03-個別匯入-補上影像後全部配對');
  for (const [p, f] of [[T, '配對-同時'], [S, '配對-個別']]) {
    const r = sh(tc, f, `uv run python "${KIT}/tools/kit_check.py" pairing --project ${p}`);
    expect(r.out).toContain('配對錯誤：0');
  }
});

test('TC-B01-05 壞檔處理', async () => {
  const tc = 'TC-B01-05';
  const r = upload(tc, '01-壞檔', 'M1-badfiles', `"${KIT}/data/bad-files"`);
  expect(r.out).toContain('匯入 2、重複 0、失敗 3');
  await imagingTab(ra, 'M1-badfiles', '匯入工作');
  await ra.getByRole('link', { name: /的逐檔結果$/ }).first().click();
  await expect(ra.getByText(/部分失敗/).first()).toBeVisible();
  await shot(ra, tc, '02-匯入工作逐檔結果');
  fs.mkdirSync('/tmp/m1-empty', { recursive: true });
  const e = upload(tc, '03-空資料夾', 'M1-badfiles', '/tmp/m1-empty');
  expect(e.out).toContain('資料夾內沒有可匯入的檔案');
  await imagingTab(ra, 'M1-badfiles', '研究列表');
  await expect(ra.getByText(/共 1 個研究/)).toBeVisible();
  await shot(ra, tc, '04-研究列表-好檔有進來');
});

test('TC-B01-06 重複匯入', async () => {
  const tc = 'TC-B01-06';
  const r = upload(tc, '01-第2次匯入', P1, `--exclude manifest.json "${KIT}/data/dicom"`);
  expect(r.out).toContain('匯入 0、重複 100、失敗 0');
  const c = sh(tc, '02-筆數', `uv run python "${KIT}/tools/kit_check.py" counts --project ${P1}`);
  expect(c.out).toContain('筆數差異：0');
  await imagingTab(ra, P1, '研究列表');
  await expect(ra.getByText(/共 20 個研究/)).toBeVisible();
  await shot(ra, tc, '03-研究列表-仍是20個');
});

test('TC-B01-07 PACS 查詢與取像', async () => {
  const tc = 'TC-B01-07';
  await imagingTab(ra, 'M1-pacs', 'PACS 查詢取像');
  let t0 = Date.now();
  await ra.getByRole('button', { name: '查詢 PACS' }).click();
  await expect(ra.getByText('PACS 回覆 2 個研究')).toBeVisible({ timeout: 30_000 });
  note(tc, `查詢 PACS 到畫面顯示回覆：${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  await shot(ra, tc, '01-查詢PACS-回覆2個研究');
  t0 = Date.now();
  await ra.getByRole('button', { name: '取回 ACC0001' }).click();
  await expect(ra.getByText(/全部成功：匯入工作 \d+：匯入 5、重複 0、失敗 0/)).toBeVisible({ timeout: 30_000 });
  note(tc, `取回 ACC0001 到畫面顯示結果：${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  await shot(ra, tc, '02-取回ACC0001-匯入5張');
  await ra.getByRole('link', { name: '到研究列表查看' }).click();
  await ra.getByRole('link', { name: '檢視研究 ACC0001' }).click();
  await expect(ra.getByRole('region', { name: '研究資訊' }).getByText('CT CHEST WO CONTRAST')).toBeVisible();
  await shot(ra, tc, '03-取回後研究明細-中繼資料');
  const r = sh(tc, '04-PACS比對', `uv run python "${KIT}/tools/kit_check.py" pacs --project M1-pacs`);
  expect(r.out).toContain('中繼資料差異合計：0');
});

const OUTSIDE = ['3', '4', '5', '7', '10'];
const uid = (n: string) => `1.2.826.0.1.3680043.10.9999.42.1.${n}`;

test('TC-B01-08 Accession 清單限制', async () => {
  const tc = 'TC-B01-08';
  await imagingTab(admin, 'M1-accession', 'Accession 清單');
  const list = fs.readFileSync(path.join(KIT, 'data/accession_allowlist.txt'), 'utf8');
  await admin.locator('#allowlist-text').fill(list);
  await expect(admin.getByText('目前輸入 10 筆')).toBeVisible();
  await shot(admin, tc, '01-貼上清單-10筆');
  await admin.getByRole('button', { name: '儲存清單' }).click();
  await expect(admin.getByText('已儲存 Accession 清單，共 10 筆')).toBeVisible();
  await shot(admin, tc, '02-儲存清單-共10筆');
  const r = upload(tc, '03-匯入20個研究', 'M1-accession', `--exclude manifest.json "${KIT}/data/dicom"`);
  expect(r.out).toContain('匯入 100、重複 0、失敗 0');
  await imagingTab(ra, 'M1-accession', '研究列表');
  await expect(ra.getByText(/共 10 個研究/)).toBeVisible();
  await shot(ra, tc, '04-ra01研究列表-只剩10個');
  let ok = 0;
  for (const n of OUTSIDE) {
    await ra.goto(`/data/imaging/studies/${uid(n)}`);
    await expect(ra.getByText('找不到研究，或不在本專案的 Accession 清單內').first()).toBeVisible();
    await expect(ra.getByRole('region', { name: '研究資訊' })).toHaveCount(0);
    await shot(ra, tc, `05-網頁直接網址-清單外ACC${n.padStart(4, '0')}`);
    ok++;
  }
  await ra.goto(`/data/imaging/studies/${uid('1')}`);
  await expect(ra.getByRole('region', { name: '研究資訊' })).toBeVisible();
  await shot(ra, tc, '06-對照組-清單內ACC0001可開啟');
  note(tc, `網頁直接輸入清單外研究 5 次，被擋 ${ok}/5`);
  const a = sh(tc, '07-API與DICOMweb', `uv run python "${KIT}/tools/kit_check.py" access --project M1-accession`);
  expect(a.out).toContain('清單外存取成功：0 次');
});

test('TC-B01-09 5 個欄位篩選', async () => {
  const tc = 'TC-B01-09';
  await imagingTab(ra, P1, '研究列表');
  const cases: [string, (p: Page) => Promise<void>, number][] = [
    ['01-Modality-MR', (p) => p.locator('#f-modality').selectOption('MR'), 10],
    ['02-PatientSex-F', (p) => p.locator('#f-sex').selectOption({ label: '女（F）' }), 10],
    ['03-StudyDescription-chest', (p) => p.locator('#f-study-desc').fill('chest'), 5],
    ['04-StudyDate-0301至0531', async (p) => { await p.locator('#f-from').fill('2024-03-01'); await p.locator('#f-to').fill('2024-05-31'); }, 5],
    ['05-SeriesDescription-lung', (p) => p.locator('#f-series-desc').fill('lung'), 5],
  ];
  for (const [name, set, n] of cases) {
    await ra.getByRole('button', { name: '清除篩選' }).click();
    await set(ra);
    await ra.getByRole('button', { name: '套用篩選' }).click();
    await expect(ra.getByText(new RegExp(`共 ${n} 個研究（已套用 1 個篩選條件）`))).toBeVisible();
    await shot(ra, tc, name);
    note(tc, `${name}：${n} 筆`);
  }
  await ra.getByRole('button', { name: '清除篩選' }).click();
});

test('TC-B01-10 CSV 上傳驗證（pi01，P2-tabular）', async () => {
  const tc = 'TC-B01-10';
  const csv = (f: string) => path.join(KIT, 'data/tabular', f);
  await pi.reload();
  await useProject(pi, 'P2-tabular');
  await pi.goto('/data/tabular');
  await useProject(pi, 'P2-tabular');
  for (const f of ['cohort_01.csv', 'cohort_02.csv', 'cohort_03.csv']) {
    await pi.locator('#csv-file').setInputFiles(csv(f));
    await expect(pi.getByText('全部通過：共 100 列，通過 100 列，拒絕 0 列。').first()).toBeVisible();
    await pi.getByRole('button', { name: '上傳並驗證' }).click();
    await expect(pi.getByText(`「${f}」的上傳結果`)).toBeVisible();
    await shot(pi, tc, `01-${f}-100列通過`);
  }
  await pi.locator('#csv-file').setInputFiles(csv('bad.csv'));
  await expect(pi.getByText(/共 30 列，通過 22 列，拒絕 8 列/).first()).toBeVisible();
  await pi.getByRole('checkbox', { name: 'sbp 必填' }).check();
  await pi.getByRole('button', { name: '重新預檢' }).click();
  await expect(pi.getByText(/共 30 列，通過 20 列，拒絕 10 列/).first()).toBeVisible();
  await shot(pi, tc, '02-bad-勾選sbp必填');
  await pi.locator('#csv-name').fill('bad');
  await pi.getByRole('button', { name: '上傳並驗證' }).click();
  await expect(pi.getByText('「bad」的上傳結果')).toBeVisible();
  await shot(pi, tc, '03-bad-上傳結果-拒絕10列');
  await pi.reload();
  await expect(pi.getByRole('link', { name: 'bad', exact: true })).toBeVisible();
  await shot(pi, tc, '04-資料集列表');
  note(tc, '3 份共 300 列全部通過；bad.csv 30 列拒絕 10 列、通過 20 列');
});
