import '../upload-env';
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { failedCsv } from '../../src/pages/imaging/ImportResult';
import { pairCoefficient } from '../../src/pages/tabular/CorrelationTab';
import { summaryColumns } from '../../src/pages/tabular/PreviewTab';
import type { ImportJob } from '../../src/pages/imaging/types';
import type { DescribeColumn } from '../../src/pages/tabular/types';
import { fixtureFile } from '../fixtures';
import { renderApp } from '../render';
import { renderData } from './imaging-render';

const STUDY1 = [1, 2, 3].map((s) => `imaging/study_0001/series_001/IM000${s}.dcm`);

describe('研究資料改版：影像清單（A02、B06）', () => {
  it('each row shows a thumbnail next to the accession number', async () => {
    await renderData('/data/imaging', 'ra01');
    await screen.findByText(/^共 6 筆影像/);
    const table = screen.getByRole('table', { name: '影像清單' });
    expect(within(table).getAllByTestId('dicom-thumb')).toHaveLength(6);
    expect(within(table).getByRole('rowheader', { name: /ACC0011/ })).toContainElement(within(table).getAllByTestId('dicom-thumb')[0]);
  });

  it('加入資料 opens the slide-over on the list; closing it goes back and the new study shows up', async () => {
    const { user } = await renderData('/data/imaging', 'ra01');
    await screen.findByText(/^共 6 筆影像/);
    await user.click(screen.getByRole('link', { name: '加入資料' }));
    const dialog = await screen.findByRole('dialog', { name: '加入資料' });
    // 只列現有支援的格式
    const sources = within(dialog).getByRole('list', { name: '資料來源' });
    expect(sources).toHaveTextContent('DICOM');
    expect(sources).toHaveTextContent('NIfTI');
    expect(sources).toHaveTextContent('MHA');
    expect(sources).toHaveTextContent('makesense JSON');
    expect(sources).not.toHaveTextContent(/PNG|JPG|ZIP/);
    const form = within(dialog).getByRole('form', { name: '從電腦上傳' });
    await user.upload(within(form).getByLabelText(/^選擇檔案/), STUDY1.map((p) => fixtureFile(p)));
    await user.click(within(form).getByRole('button', { name: /^上傳到/ }));
    await within(form).findByRole('table', { name: 'DICOM 匯入結果逐檔結果' });
    await user.click(within(dialog).getByRole('button', { name: '關閉' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByText(/^共 7 筆影像/);
  });
});

describe('研究資料改版：匯入結果（B05）', () => {
  const job: ImportJob = {
    id: 3,
    kind: 'dicom',
    status: 'partial',
    created_by: 'ra01',
    created_at: '2026-10-23T10:26:00Z',
    counts: { imported: 1, duplicate: 0, failed: 2 },
    files: [
      { filename: 'a.dcm', status: 'imported', reason: '' },
      { filename: 'b,1.dcm', status: 'failed', reason: '不是 DICOM 檔案' },
      { filename: 'c.dcm', status: 'failed', reason: '缺少 "SOP" 欄位' },
    ],
  };

  it('F6 the failed list CSV has a BOM, a header and only the failed files (quoted when needed)', () => {
    expect(failedCsv(job)).toBe('﻿檔案名稱,失敗原因\r\n"b,1.dcm",不是 DICOM 檔案\r\nc.dcm,"缺少 ""SOP"" 欄位"\r\n');
  });

  it('the job page shows the summary, download and 重新上傳 / 查看匯入的影像', async () => {
    const { user } = await renderData('/data/imaging/import', 'ra01');
    const form = await screen.findByRole('form', { name: '從電腦上傳' });
    await user.upload(within(form).getByLabelText(/^選擇檔案/), [fixtureFile(STUDY1[0]), fixtureFile('imaging/not-dicom.dcm')]);
    await user.click(within(form).getByRole('button', { name: /^上傳到/ }));
    const region = await within(form).findByRole('region', { name: 'DICOM 匯入結果' });
    expect(within(region).getByRole('button', { name: '下載失敗清單' })).toBeInTheDocument();
    expect(region).toHaveTextContent('匯入專案P1-lung-ct');
    expect(region).toHaveTextContent('資料來源從電腦上傳（DICOM）');

    await user.click(within(form).getByRole('link', { name: '看匯入紀錄' }));
    await user.click(await screen.findByRole('link', { name: '檢視匯入工作 1 的逐檔結果' }));
    expect(await screen.findByRole('heading', { level: 2, name: '匯入結果' })).toBeInTheDocument();
    const page = await screen.findByRole('region', { name: '匯入工作 1' });
    expect(within(page).getByRole('link', { name: /重新上傳/ })).toHaveAttribute('href', '/data/imaging/import');
    expect(within(page).getByRole('link', { name: /查看匯入的影像/ })).toHaveAttribute('href', '/data/imaging');
    await user.click(within(page).getByRole('button', { name: '重複（0）' }));
    expect(within(page).getByRole('table', { name: '匯入工作 1逐檔結果' })).toHaveTextContent('沒有檔案');
  });
});

describe('研究資料改版：表格資料（B09、B10、A05）', () => {
  it('查看資料 has four sections; 統計分析 opens inline and 進一步分析 preselects the model', async () => {
    const { user } = await renderApp('/data/tabular/2/view?show=correlation', 'vw01');
    const group = await screen.findByRole('group', { name: '查看資料的段落' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['資料預覽', '欄位統計', '相關與散佈圖', '統計分析']);
    await user.click(await screen.findByRole('link', { name: 'Cox 迴歸' }));
    const form = await screen.findByRole('form', { name: '統計分析' });
    expect(within(form).getByLabelText('模型')).toHaveValue('cox');
  });

  it('預覽 shows summary tiles and a searchable column panel', async () => {
    const { user } = await renderApp('/data/tabular/2/view', 'vw01');
    await screen.findByRole('table', { name: '資料預覽' });
    expect(await screen.findByRole('list', { name: '摘要統計' })).toHaveTextContent('平均 age');
    const group = screen.getByRole('group', { name: '顯示欄位' });
    await user.type(screen.getByLabelText('搜尋欄位名稱'), 'gluc');
    expect(within(group).getAllByRole('checkbox').map((c) => c.parentElement?.textContent)).toEqual(['glucose']);
  });

  it('summaryColumns skips 0/1 and identifier-like columns', () => {
    const col = (name: string, extra: Partial<DescribeColumn>): DescribeColumn =>
      ({ name, dtype: 'float64', kind: 'numeric', missing: 0, count: 100, unique: 30, mean: 1, min: 0, max: 9, ...extra }) as DescribeColumn;
    const cols = [col('id', { unique: 100 }), col('flag', { min: 0, max: 1, unique: 2 }), col('age', {}), col('bmi', {}), col('sbp', {}), col('dbp', {})];
    expect(summaryColumns(cols, cols.map((c) => c.name)).map((c) => c.name)).toEqual(['age', 'bmi', 'sbp']);
    expect(summaryColumns(cols, ['dbp']).map((c) => c.name)).toEqual(['dbp']);
  });

  it('pairCoefficient reads r from the matrix', () => {
    const m = { method: 'pearson', columns: ['age', 'bmi'], matrix: [[1, 0.42], [0.42, 1]] };
    expect(pairCoefficient(m, 'bmi', 'age')).toBe(0.42);
    expect(pairCoefficient(m, 'age', 'sbp')).toBeNull();
    expect(pairCoefficient(null, 'age', 'bmi')).toBeNull();
  });

  it('F4 a step can be edited in place; 加步驟 on a column opens the form with that column ticked', async () => {
    const { user } = await renderApp('/data/tabular/2/prepare', 'ra01');
    const fieldTable = await screen.findByRole('table', { name: '欄位整理' });
    await user.click(within(fieldTable).getByRole('button', { name: '替 glucose 加整理步驟' }));
    const form = await screen.findByRole('form', { name: '加入前處理步驟' });
    expect(within(form).getByRole('checkbox', { name: 'glucose' })).toBeChecked();
    expect(within(form).getByLabelText('類別')).toHaveValue('imputation');
    await user.selectOptions(within(form).getByLabelText('方法'), '固定值補值');
    await user.click(within(form).getByRole('checkbox', { name: 'glucose' }));
    await user.type(within(form).getByLabelText('填入值'), '5');
    await user.click(within(form).getByRole('button', { name: '加入步驟' }));
    const list = screen.getByRole('list', { name: '已加入的步驟' });
    expect(within(list).getByText('固定值補值：glucose（填入值＝5）')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: '修改第 1 步' }));
    const edit = within(list).getByRole('form', { name: '修改第 1 步' });
    expect(within(edit).getByLabelText('填入值')).toHaveValue('5');
    await user.clear(within(edit).getByLabelText('填入值'));
    await user.type(within(edit).getByLabelText('填入值'), '99');
    await user.click(within(edit).getByRole('checkbox', { name: 'bmi' }));
    await user.click(within(edit).getByRole('button', { name: '儲存修改' }));
    expect(within(list).getByText('固定值補值：glucose、bmi（填入值＝99）')).toBeInTheDocument();
    expect(within(list).queryByRole('form', { name: '修改第 1 步' })).toBeNull();
    expect(screen.getByTestId('handling-bmi')).toHaveTextContent('固定值補值');
  });

  it('處理前後比較 marks missing cells before and filled cells after', async () => {
    const { user } = await renderApp('/data/tabular/2/prepare', 'ra01');
    const form = await screen.findByRole('form', { name: '加入前處理步驟' });
    await user.selectOptions(within(form).getByLabelText('類別'), within(form).getByRole('option', { name: /^缺值處理/ }));
    await user.selectOptions(within(form).getByLabelText('方法'), '平均數補值');
    await user.click(within(form).getByRole('checkbox', { name: 'glucose' }));
    await user.click(within(form).getByRole('button', { name: '加入步驟' }));
    await user.click(screen.getByRole('button', { name: '預覽處理結果' }));
    const result = await screen.findByRole('region', { name: '處理前後預覽' });
    const before = within(result).getByRole('table', { name: '處理前的資料' });
    const after = within(result).getByRole('table', { name: '處理後的資料' });
    expect(before.querySelectorAll('.rd-cell--missing').length).toBeGreaterThan(0);
    expect(after.querySelectorAll('.rd-cell--filled').length).toBeGreaterThan(0);
  });
});
