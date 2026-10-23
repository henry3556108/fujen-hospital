import '../upload-env';
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { parseDicom } from '../../src/mocks/imaging';
import { fixtureBytes, fixtureFile } from '../fixtures';
import { renderData as renderApp } from './imaging-render';
import { bodyRows, cellsOf } from '../table';

const STUDY1 = [1, 2, 3].map((s) => `imaging/study_0001/series_001/IM000${s}.dcm`);

const resultRows = bodyRows;

async function uploadDicom(user: Awaited<ReturnType<typeof renderApp>>['user'], files: File[]) {
  const form = await screen.findByRole('form', { name: '從電腦上傳' });
  await user.upload(within(form).getByLabelText(/^選擇檔案/), files);
  await user.click(within(form).getByRole('button', { name: /^上傳到/ }));
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
      ['IM0001.dcm', '新增', '—'],
      ['IM0002.dcm', '新增', '—'],
      ['IM0003.dcm', '新增', '—'],
    ]);
    expect(screen.getByRole('region', { name: 'DICOM 匯入結果' })).toHaveTextContent('新增 3、重複 0、失敗 0');
    expect(screen.getByRole('link', { name: '開始標註' })).toHaveAttribute('href', '/labeling');
    await user.click(screen.getByRole('link', { name: '到影像清單查看' }));
    await screen.findByText(/^共 7 筆影像/);
    const row = within(screen.getByRole('table', { name: '影像清單' })).getByRole('row', { name: /ACC0001/ });
    expect(row).toHaveTextContent('CT CHEST WO CONTRAST');
    expect(within(row).getAllByRole('cell').at(-3)).toHaveTextContent('3');
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
      ['IM0001.dcm', '新增'],
      ['not-dicom.dcm', '失敗'],
      ['truncated.dcm', '失敗'],
      ['IM0002.dcm', '新增'],
    ]);
    expect(rows[1][2]).toBe('不是 DICOM 檔案（缺少 DICM 檔頭或格式錯誤）');
    expect(rows[2][2]).not.toBe('—');
    const summary = screen.getByRole('region', { name: 'DICOM 匯入結果' });
    expect(summary).toHaveTextContent('部分失敗');
    expect(summary).toHaveTextContent('新增 2、重複 0、失敗 2');
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
    const form = await screen.findByRole('form', { name: '從電腦上傳' });
    await user.click(within(form).getByRole('button', { name: /^上傳到/ }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('請先選擇檔案');
  });

  it('TC-B01-03 / TC-B01-04 NIfTI, ITK and makesense are parsed and paired', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    // makesense 標註靠來源路徑配對：先匯入帶資料夾路徑的 DICOM
    const form0 = await screen.findByRole('form', { name: '從電腦上傳' });
    await user.upload(
      within(form0).getByLabelText(/^選擇檔案/),
      STUDY1.map((p) => Object.defineProperty(fixtureFile(p), 'webkitRelativePath', { value: p.replace('imaging/', '') })),
    );
    await user.click(within(form0).getByRole('button', { name: /^上傳到/ }));
    const dicom = await within(form0).findByRole('table', { name: 'DICOM 匯入結果逐檔結果' });
    expect(resultRows(dicom)[0][0]).toBe('study_0001/series_001/IM0001.dcm');

    await user.click(screen.getByRole('button', { name: /^匯入影像與標註檔/ }));
    const form = await screen.findByRole('form', { name: '匯入影像與標註檔' });
    await user.upload(within(form).getByLabelText(/^選擇檔案/), [
      fixtureFile('imaging/case01_label.nii.gz'),
      fixtureFile('imaging/case01_image.nii.gz'),
      fixtureFile('imaging/case02_image.mha'),
      fixtureFile('imaging/case02_label.mha'),
      fixtureFile('imaging/study1_makesense.json'),
      fixtureFile('imaging/notes.txt', 'broken.json'),
    ]);
    await user.click(within(form).getByRole('button', { name: /^上傳到/ }));
    const table = await within(form).findByRole('table', { name: '影像與標註檔匯入結果逐檔結果' });
    const rows = resultRows(table);
    expect(rows.filter((r) => r[1] === '新增')).toHaveLength(5);
    expect(rows.at(-1)).toEqual(['broken.json', '失敗', 'makesense 檔案不是有效的 JSON']);

    await user.click(within(form).getByRole('link', { name: '看檔案與配對' }));
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
    const { user } = await renderApp('/data/imaging/import?source=bundle', 'ra01');
    const form = await screen.findByRole('form', { name: '匯入影像與標註檔' });
    await user.upload(within(form).getByLabelText(/^選擇檔案/), [fixtureFile('imaging/case01_label.nii.gz')]);
    await user.click(within(form).getByRole('button', { name: /^上傳到/ }));
    await within(form).findByRole('table', { name: '影像與標註檔匯入結果逐檔結果' });
    await user.click(within(form).getByRole('link', { name: '看檔案與配對' }));
    const row = await screen.findByRole('row', { name: /^case01_label/ });
    expect(row).toHaveTextContent('未配對');
    expect(row).toHaveTextContent('尚未匯入對應影像');
  });

  it('TC-A03-05 users without Labeling permission see no upload form', async () => {
    await renderApp('/data/imaging/import', 'vw01');
    expect(await screen.findByText('你在專案「P1-lung-ct」沒有 Labeling 權限，無法加入影像。')).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });
});

describe('匯入紀錄', () => {
  it('lists jobs newest first and shows per-file results', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    await uploadDicom(user, [fixtureFile(STUDY1[0]), fixtureFile('imaging/not-dicom.dcm')]);
    await user.click(within(screen.getByRole('navigation', { name: '影像分頁' })).getByRole('link', { name: '匯入紀錄' }));
    const table = await screen.findByRole('table', { name: '匯入紀錄' });
    const row = await within(table).findByRole('row', { name: /^1 / });
    expect(row).toHaveTextContent('從電腦上傳（DICOM）');
    expect(row).toHaveTextContent('部分失敗');
    expect(row).toHaveTextContent('新增 1、重複 0、失敗 1');
    expect(row).toHaveTextContent('ra01');
    await user.click(within(row).getByRole('link', { name: '檢視匯入工作 1 的逐檔結果' }));
    const detail = await screen.findByRole('table', { name: '匯入工作 1逐檔結果' });
    expect(resultRows(detail)).toEqual([
      ['IM0001.dcm', '新增', '—'],
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
    // B-01 判準「30 秒內」：畫面顯示從送出到收到回應的時間
    expect(screen.getByRole('status')).toHaveTextContent(/PACS 回覆 2 個研究，回應時間 \d+\.\d 秒/);
    expect(resultRows(table).map((r) => r.slice(0, 7))).toEqual([
      ['2024-02-20', 'ACC0002', 'PAT0002', 'M', 'MR', 'MR BRAIN WWO CONTRAST', '3'],
      ['2024-04-05', 'ACC0004', 'PAT0004', 'F', 'MR', 'MR KNEE WO CONTRAST', '3'],
    ]);
    await user.click(within(table).getByRole('button', { name: '取回 ACC0002' }));
    const result = await screen.findByRole('region', { name: 'PACS 取像結果' });
    expect(result).toHaveTextContent('新增 3、重複 0、失敗 0');
    await user.click(screen.getByRole('link', { name: '到影像清單查看' }));
    await screen.findByText(/^共 7 筆影像/);
    expect(within(screen.getByRole('table', { name: '影像清單' })).getByRole('row', { name: /ACC0002/ })).toHaveTextContent('MR BRAIN WWO CONTRAST');
  });

  it('retrieving the same study again reports duplicates', async () => {
    const { user } = await renderApp('/data/imaging/pacs', 'ra01');
    await user.click(await screen.findByRole('button', { name: '查詢 PACS' }));
    const table = await screen.findByRole('table', { name: 'PACS 查詢結果' });
    expect(resultRows(table)).toHaveLength(4);
    await user.click(within(table).getByRole('button', { name: '取回 ACC0001' }));
    await screen.findByText(/新增 3、重複 0、失敗 0/);
    await user.click(within(table).getByRole('button', { name: '取回 ACC0001' }));
    expect(await screen.findByText(/新增 0、重複 3、失敗 0/)).toBeInTheDocument();
  });

  it('TC-B01-08 with an allowlist, PACS only lists studies on it', async () => {
    const admin = await renderApp('/admin/allowlist', 'admin01');
    const form = await screen.findByRole('form', { name: '設定影像存取清單' });
    await admin.user.type(within(form).getByLabelText(/^Accession Number/), 'ACC0003');
    await admin.user.click(within(form).getByRole('button', { name: '儲存清單' }));
    await screen.findByText('已儲存影像存取清單，共 1 筆');
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

describe('加入資料（改版）', () => {
  it('shows the target project and the three sources', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    expect(await screen.findByText(/加入的影像只會進到專案/)).toHaveTextContent('P1-lung-ct');
    const sources = screen.getByRole('list', { name: '資料來源' });
    expect(within(sources).getAllByRole('button').map((b) => b.querySelector('.entry-card__title')?.textContent)).toEqual([
      '從電腦上傳',
      '從院內影像系統取得',
      '匯入影像與標註檔',
    ]);
    await user.click(within(sources).getByRole('button', { name: /^從院內影像系統取得/ }));
    expect(await screen.findByRole('form', { name: '查詢 PACS' })).toBeInTheDocument();
  });

  it('one upload splits DICOM and NIfTI into their own results', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    const form = await screen.findByRole('form', { name: '從電腦上傳' });
    await user.upload(within(form).getByLabelText(/^選擇檔案/), [fixtureFile(STUDY1[0]), fixtureFile('imaging/case02_image.mha')]);
    await user.click(within(form).getByRole('button', { name: /^上傳到/ }));
    expect(resultRows(await within(form).findByRole('table', { name: 'DICOM 匯入結果逐檔結果' }))).toEqual([['IM0001.dcm', '新增', '—']]);
    expect(resultRows(await within(form).findByRole('table', { name: '影像與標註檔匯入結果逐檔結果' }))[0].slice(0, 2)).toEqual([
      'case02_image.mha',
      '新增',
    ]);
  });

  it('retries only the failed files and can filter the failed ones', async () => {
    const { user } = await renderApp('/data/imaging/import', 'ra01');
    const table = await uploadDicom(user, [fixtureFile(STUDY1[0]), fixtureFile('imaging/not-dicom.dcm')]);
    const region = screen.getByRole('region', { name: 'DICOM 匯入結果' });
    await user.click(within(region).getByRole('button', { name: '失敗（1）' }));
    expect(resultRows(table).map((r) => r[0])).toEqual(['not-dicom.dcm']);
    await user.click(within(region).getByRole('button', { name: '只重傳失敗的 1 個檔案' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'DICOM 匯入結果' })).toHaveTextContent('匯入工作 2：新增 0、重複 0、失敗 1'));
  });
});
