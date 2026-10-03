import '../upload-env';
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { parseDicom } from '../../src/mocks/imaging';
import { fixtureBytes, fixtureFile } from '../fixtures';
import { renderApp } from '../render';
import { bodyRows, cellsOf } from '../table';

const STUDY1 = [1, 2, 3].map((s) => `imaging/study_0001/series_001/IM000${s}.dcm`);

const resultRows = bodyRows;

async function uploadDicom(user: Awaited<ReturnType<typeof renderApp>>['user'], files: File[]) {
  const form = await screen.findByRole('form', { name: 'DICOM' });
  await user.upload(within(form).getByLabelText(/^選擇檔案/), files);
  await user.click(within(form).getByRole('button', { name: '上傳DICOM' }));
  return within(form).findByRole('table', { name: 'DICOM 匯入結果逐檔結果' });
}

describe('mock DICOM parser', () => {
  it('reads the index tags from a synthetic DICOM file', () => {
    expect(parseDicom(fixtureBytes(STUDY1[0]))).toEqual({
      sop: '1.2.826.0.1.3680043.10.9999.77.3.1.1',
      study: '1.2.826.0.1.3680043.10.9999.77.1.1',
      series: '1.2.826.0.1.3680043.10.9999.77.2.1.1',
      accession: 'ACC0001',
      patientId: 'PAT0001',
      sex: 'F',
      date: '20240115',
      studyDescription: 'CT CHEST WO CONTRAST',
      seriesDescription: 'AXIAL 5MM SOFT TISSUE',
      modality: 'CT',
    });
  });

  it('rejects non-DICOM and truncated files', () => {
    expect(() => parseDicom(fixtureBytes('imaging/not-dicom.dcm'))).toThrow(/不是 DICOM 檔案/);
    expect(() => parseDicom(fixtureBytes('imaging/truncated.dcm'))).toThrow(/不完整|缺少/);
  });
});

describe('匯入影像', () => {
  it('TC-B01-02 uploads 3 DICOM files; the study appears in the list with the same counts', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    const table = await uploadDicom(user, STUDY1.map((p) => fixtureFile(p)));
    expect(resultRows(table)).toEqual([
      ['IM0001.dcm', '已匯入', '—'],
      ['IM0002.dcm', '已匯入', '—'],
      ['IM0003.dcm', '已匯入', '—'],
    ]);
    expect(screen.getByRole('region', { name: 'DICOM 匯入結果' })).toHaveTextContent('匯入 3、重複 0、失敗 0');
    await user.click(screen.getAllByRole('link', { name: '到研究列表查看' })[0]);
    await screen.findByText(/^共 7 個研究/);
    const row = within(screen.getByRole('table', { name: '研究列表' })).getByRole('row', { name: /ACC0001/ });
    expect(row).toHaveTextContent('CT CHEST WO CONTRAST');
    expect(within(row).getAllByRole('cell').at(-2)).toHaveTextContent('3');
  });

  it('TC-B01-05 bad files fail with name and reason; good files in the same batch are imported', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    const table = await uploadDicom(user, [
      fixtureFile(STUDY1[0]),
      fixtureFile('imaging/not-dicom.dcm'),
      fixtureFile('imaging/truncated.dcm'),
      fixtureFile(STUDY1[1]),
    ]);
    const rows = resultRows(table);
    expect(rows.map((r) => r.slice(0, 2))).toEqual([
      ['IM0001.dcm', '已匯入'],
      ['not-dicom.dcm', '失敗'],
      ['truncated.dcm', '失敗'],
      ['IM0002.dcm', '已匯入'],
    ]);
    expect(rows[1][2]).toBe('不是 DICOM 檔案（缺少 DICM 檔頭或格式錯誤）');
    expect(rows[2][2]).not.toBe('—');
    const summary = screen.getByRole('region', { name: 'DICOM 匯入結果' });
    expect(summary).toHaveTextContent('部分失敗');
    expect(summary).toHaveTextContent('匯入 2、重複 0、失敗 2');
  });

  it('TC-B01-06 importing the same file twice reports a duplicate and adds no image', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    await uploadDicom(user, [fixtureFile(STUDY1[0])]);
    const table = await uploadDicom(user, [fixtureFile(STUDY1[0])]);
    await waitFor(() => expect(resultRows(table)[0][1]).toBe('重複'));
    expect(resultRows(table)[0][2]).toBe('SOP Instance UID 1.2.826.0.1.3680043.10.9999.77.3.1.1 已匯入');
  });

  it('asks for files before uploading', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    const form = await screen.findByRole('form', { name: 'DICOM' });
    await user.click(within(form).getByRole('button', { name: '上傳DICOM' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('請先選擇檔案');
  });

  it('TC-B01-03 / TC-B01-04 NIfTI, ITK and makesense are parsed and paired', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    // makesense 標註靠來源路徑配對：先匯入帶資料夾路徑的 DICOM
    const form0 = await screen.findByRole('form', { name: 'DICOM' });
    await user.upload(
      within(form0).getByLabelText(/^選擇檔案/),
      STUDY1.map((p) => Object.defineProperty(fixtureFile(p), 'webkitRelativePath', { value: p.replace('imaging/', '') })),
    );
    await user.click(within(form0).getByRole('button', { name: '上傳DICOM' }));
    const dicom = await within(form0).findByRole('table', { name: 'DICOM 匯入結果逐檔結果' });
    expect(resultRows(dicom)[0][0]).toBe('study_0001/series_001/IM0001.dcm');

    const form = screen.getByRole('form', { name: 'NIfTI、ITK、makesense' });
    await user.upload(within(form).getByLabelText(/^選擇檔案/), [
      fixtureFile('imaging/case01_label.nii.gz'),
      fixtureFile('imaging/case01_image.nii.gz'),
      fixtureFile('imaging/case02_image.mha'),
      fixtureFile('imaging/case02_label.mha'),
      fixtureFile('imaging/study1_makesense.json'),
      fixtureFile('imaging/notes.txt', 'broken.json'),
    ]);
    await user.click(within(form).getByRole('button', { name: /^上傳NIfTI/ }));
    const table = await within(form).findByRole('table', { name: '檔案匯入結果逐檔結果' });
    const rows = resultRows(table);
    expect(rows.filter((r) => r[1] === '已匯入')).toHaveLength(5);
    expect(rows.at(-1)).toEqual(['broken.json', '失敗', 'makesense 檔案不是有效的 JSON']);

    await user.click(within(form).getByRole('link', { name: '到檔案與配對查看' }));
    const files = await screen.findByRole('table', { name: '檔案列表' });
    await within(files).findByRole('rowheader', { name: 'case01_label.nii.gz' });
    const by = (name: string) => cellsOf(within(files).getByRole('row', { name: new RegExp(`^${name.replaceAll('.', '\\.')}`) }));
    expect(by('case01_label.nii.gz').slice(1, 7)).toEqual(['NIfTI', '標註', 'case01', '尺寸 4 × 4 × 2', '已配對', 'case01_image.nii.gz']);
    expect(by('case02_label.mha').slice(5, 7)).toEqual(['已配對', 'case02_image.mha']);
    expect(by('case02_image.mha')[5]).toBe('影像（不需配對）');
    // 配對對象寫出研究（Accession 與 Study Description），不只是張數
    expect(by('study1_makesense.json').slice(4, 7)).toEqual(['3 筆標註', '已配對', 'ACC0001 CT CHEST WO CONTRAST（3 張）']);
    expect(screen.getByRole('status')).toHaveTextContent('共 5 個檔案，0 個標註尚未配對');
  });

  it('a label uploaded before its image is unpaired with a note', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    const form = await screen.findByRole('form', { name: 'NIfTI、ITK、makesense' });
    await user.upload(within(form).getByLabelText(/^選擇檔案/), [fixtureFile('imaging/case01_label.nii.gz')]);
    await user.click(within(form).getByRole('button', { name: /^上傳NIfTI/ }));
    await within(form).findByRole('table', { name: '檔案匯入結果逐檔結果' });
    await user.click(within(form).getByRole('link', { name: '到檔案與配對查看' }));
    const row = await screen.findByRole('row', { name: /^case01_label/ });
    expect(row).toHaveTextContent('未配對');
    expect(row).toHaveTextContent('尚未匯入對應影像');
  });

  it('TC-A03-05 users without Labeling permission see no upload form', async () => {
    await renderApp('/data/imaging/import', 'vw01');
    expect(await screen.findByText('你在專案「P1-lung-ct」沒有 Labeling 權限，無法匯入影像。')).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });
});

describe('匯入工作', () => {
  it('lists jobs newest first and shows per-file results', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    await uploadDicom(user, [fixtureFile(STUDY1[0]), fixtureFile('imaging/not-dicom.dcm')]);
    await user.click(within(screen.getByRole('navigation', { name: '醫療影像分頁' })).getByRole('link', { name: '匯入工作' }));
    const table = await screen.findByRole('table', { name: '匯入工作列表' });
    const row = await within(table).findByRole('row', { name: /^1 / });
    expect(row).toHaveTextContent('DICOM 上傳');
    expect(row).toHaveTextContent('部分失敗');
    expect(row).toHaveTextContent('匯入 1、重複 0、失敗 1');
    expect(row).toHaveTextContent('ra01');
    await user.click(within(row).getByRole('link', { name: '檢視匯入工作 1 的逐檔結果' }));
    const detail = await screen.findByRole('table', { name: '匯入工作 1逐檔結果' });
    expect(resultRows(detail)).toEqual([
      ['IM0001.dcm', '已匯入', '—'],
      ['not-dicom.dcm', '失敗', '不是 DICOM 檔案（缺少 DICM 檔頭或格式錯誤）'],
    ]);
  });

  it('404 for an unknown job', async () => {
    await renderApp('/data/imaging/jobs/99', 'ra01');
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到匯入工作 99');
  });
});

describe('PACS 查詢取像', () => {
  it('TC-B01-07 queries by Modality, retrieves a study and indexes it', async () => {
    const { user } = await renderApp('/data/imaging/pacs', 'ra01');
    const form = await screen.findByRole('form', { name: '查詢 PACS' });
    await user.type(within(form).getByLabelText('Modality'), 'MR');
    await user.click(within(form).getByRole('button', { name: '查詢 PACS' }));
    const table = await screen.findByRole('table', { name: 'PACS 查詢結果' });
    expect(screen.getByText('PACS 回覆 2 個研究')).toBeInTheDocument();
    expect(resultRows(table).map((r) => r.slice(0, 7))).toEqual([
      ['2024-02-20', 'ACC0002', 'PAT0002', 'M', 'MR', 'MR BRAIN WWO CONTRAST', '3'],
      ['2024-04-05', 'ACC0004', 'PAT0004', 'F', 'MR', 'MR KNEE WO CONTRAST', '3'],
    ]);
    await user.click(within(table).getByRole('button', { name: '取回 ACC0002' }));
    const result = await screen.findByRole('region', { name: 'PACS 取像結果' });
    expect(result).toHaveTextContent('匯入 3、重複 0、失敗 0');
    await user.click(screen.getByRole('link', { name: '到研究列表查看' }));
    await screen.findByText(/^共 7 個研究/);
    expect(within(screen.getByRole('table', { name: '研究列表' })).getByRole('row', { name: /ACC0002/ })).toHaveTextContent('MR BRAIN WWO CONTRAST');
  });

  it('retrieving the same study again reports duplicates', async () => {
    const { user } = await renderApp('/data/imaging/pacs', 'ra01');
    await user.click(await screen.findByRole('button', { name: '查詢 PACS' }));
    const table = await screen.findByRole('table', { name: 'PACS 查詢結果' });
    expect(resultRows(table)).toHaveLength(4);
    await user.click(within(table).getByRole('button', { name: '取回 ACC0001' }));
    await screen.findByText(/匯入 3、重複 0、失敗 0/);
    await user.click(within(table).getByRole('button', { name: '取回 ACC0001' }));
    expect(await screen.findByText(/匯入 0、重複 3、失敗 0/)).toBeInTheDocument();
  });

  it('TC-B01-08 with an allowlist, PACS only lists studies on it', async () => {
    const admin = await renderApp('/data/imaging/allowlist', 'admin01');
    const form = await screen.findByRole('form', { name: '設定 Accession 清單' });
    await admin.user.type(within(form).getByLabelText(/^Accession Number/), 'ACC0003');
    await admin.user.click(within(form).getByRole('button', { name: '儲存清單' }));
    await screen.findByText('已儲存 Accession 清單，共 1 筆');
    admin.unmount();

    const { user } = await renderApp('/data/imaging/pacs', 'ra01');
    await user.click(await screen.findByRole('button', { name: '查詢 PACS' }));
    const table = await screen.findByRole('table', { name: 'PACS 查詢結果' });
    expect(resultRows(table).map((r) => r[1])).toEqual(['ACC0003']);
  });

  it('TC-A03-05 users without Labeling permission cannot query', async () => {
    await renderApp('/data/imaging/pacs', 'vw01');
    expect(await screen.findByText(/沒有 Labeling 權限，無法向 PACS 查詢或取回影像/)).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });
});
