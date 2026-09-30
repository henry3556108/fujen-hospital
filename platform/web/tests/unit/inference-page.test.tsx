// 推論服務管理頁（元件層級，模擬 API）。TC-B06-01、02、03、04。批次推論：送出 → 輪詢 → 結果、取消。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { resetInferenceMock } from '../../src/mocks/inference';
import { inferencePolling, waitForRecord, type InferenceRecord } from '../../src/pages/inference/api';
import { renderApp } from '../render';

const polling = { ...inferencePolling };
beforeEach(() => Object.assign(inferencePolling, { firstMs: 1, maxMs: 5 }));
afterEach(() => {
  resetInferenceMock();
  Object.assign(inferencePolling, polling);
});

async function openModel(name: RegExp | string, username = 'vw01') {
  const utils = await renderApp('/inference', username);
  const table = await screen.findByRole('table', { name: '模型清單' });
  const button = within(table).queryByRole('button', { name: `選擇 ${name}` });
  if (button) await utils.user.click(button);
  await screen.findByRole('heading', { name: `執行推論：${name}` });
  return utils;
}

describe('inference page', () => {
  it('lists trained models with kind and format', async () => {
    await renderApp('/inference', 'vw01');
    const table = await screen.findByRole('table', { name: '模型清單' });
    expect(within(table).getByRole('row', { name: /diagnosis-rf-run1.*結構式分類.*PKL/ })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /modality-cnn-run2.*影像分類.*H5/ })).toBeInTheDocument();
  });

  it('TC-B06-01 / 04 batch inference on tabular data adds a prediction column to every row', async () => {
    const { user } = await openModel('diagnosis-rf-run1');
    await user.click(screen.getByRole('button', { name: '批次推論' }));
    const table = await screen.findByRole('table', { name: '結構式推論結果' });
    expect(screen.queryByTestId('batch-status')).not.toBeInTheDocument();
    const header = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(header.slice(-2)).toEqual(['prediction', 'prediction_note']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(20);
    for (const row of rows) {
      const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
      expect(cells.at(-2) !== '' || cells.at(-1) === '特徵含缺值，無法預測').toBe(true);
    }
    expect(screen.getByRole('heading', { name: '推論結果 #1（20 筆）' })).toBeInTheDocument();
  });

  it('TC-B06-02 / 04 uploaded images each show a classification result', async () => {
    const { user } = await openModel('modality-cnn-run2');
    const files = Array.from({ length: 9 }, (_, i) => new File([`dicom-${i}`], `IM${i + 1}.dcm`));
    await user.upload(screen.getByLabelText('影像檔'), files);
    await user.click(screen.getByRole('button', { name: '上傳並推論' }));
    const grid = await screen.findByRole('list', { name: '影像推論結果' });
    const cards = within(grid).getAllByTestId('image-result');
    expect(cards).toHaveLength(9);
    for (const [i, card] of cards.entries()) {
      expect(within(card).getByRole('img', { name: `IM${i + 1}.dcm 切片 1` })).toBeInTheDocument();
      expect(within(card).getByTestId('result-label')).toHaveTextContent(/^分類：(CT|MR)（\d+%）$/);
    }
  });

  it('detection results draw boxes scaled to the model input size', async () => {
    const { user } = await openModel('nodule-det-run3');
    await user.upload(screen.getByLabelText('影像檔'), [new File(['x'], 'a.dcm')]);
    await user.click(screen.getByRole('button', { name: '上傳並推論' }));
    const box = await screen.findByTestId('result-box');
    expect(box.style.top).toBe(`${(6 / 32) * 100}%`);
    expect(box.style.height).toBe(`${(12 / 32) * 100}%`);
    expect(screen.getByTestId('result-label')).toHaveTextContent(/^偵測：nodule \d+%$/);
  });

  it('TC-B06-03 history lists every run and reopens a result', async () => {
    const { user } = await openModel('diagnosis-rf-run1');
    for (let i = 0; i < 3; i += 1) {
      await user.click(screen.getByRole('button', { name: '批次推論' }));
      await screen.findByRole('heading', { name: `推論結果 #${i + 1}（20 筆）` });
    }
    const history = await screen.findByRole('table', { name: '推論歷史' });
    await waitFor(() => expect(within(history).getAllByRole('row')).toHaveLength(4));
    await user.click(within(history).getByRole('button', { name: '檢視 #1' }));
    expect(await screen.findByRole('heading', { name: '推論結果 #1（20 筆）' })).toBeInTheDocument();
    expect(within(history).getAllByRole('button', { name: /^下載 #/ })).toHaveLength(3);
  });

  it('files blocked by the virus scanner are listed and not inferred', async () => {
    const { user } = await openModel('modality-cnn-run2');
    await user.upload(screen.getByLabelText('影像檔'), [new File(['a'], 'ok.dcm'), new File(['b'], 'eicar.dcm')]);
    await user.click(screen.getByRole('button', { name: '上傳並推論' }));
    expect(await screen.findAllByTestId('image-result')).toHaveLength(1);
    expect(screen.getByText(/1 個檔案未推論：eicar\.dcm（掃毒攔截：Eicar-Signature）/)).toBeInTheDocument();
  });

  it('server errors are shown in Chinese', async () => {
    const { user } = await openModel('diagnosis-rf-run1');
    await user.upload(screen.getByLabelText('CSV 檔'), new File(['foo,bar\n1,2\n'], 'x.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: '上傳並推論' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('資料缺少特徵欄位：age、bmi、glucose、sbp');
  });

  it('a submitted batch shows its status while it runs in the background', async () => {
    Object.assign(inferencePolling, { firstMs: 60_000, maxMs: 60_000 });
    const { user } = await openModel('diagnosis-rf-run1');
    await user.click(screen.getByRole('button', { name: '批次推論' }));
    expect(await screen.findByTestId('batch-status')).toHaveTextContent('批次推論排隊中…在背景執行');
    expect(screen.getByRole('heading', { name: '推論結果 #1（20 筆）' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下載結果' })).not.toBeInTheDocument();
    const history = await screen.findByRole('table', { name: '推論歷史' });
    await waitFor(() => expect(within(history).getByRole('row', { name: /#1.*批次.*排隊中/ })).toBeInTheDocument());
    // 從歷史重新檢視會繼續輪詢：模擬 API 每查一次往前一步（排隊中 → 執行中）
    await user.click(within(history).getByRole('button', { name: '檢視 #1' }));
    expect(await screen.findByTestId('batch-status')).toHaveTextContent('批次推論執行中…');
  });

  it('a queued batch can be cancelled from the result panel and the history', async () => {
    Object.assign(inferencePolling, { firstMs: 60_000, maxMs: 60_000 });
    const { user } = await openModel('modality-cnn-run2');
    await user.click(screen.getByRole('button', { name: '批次推論' }));
    await screen.findByTestId('batch-status');
    await user.click(screen.getByRole('button', { name: '取消推論' }));
    expect(await screen.findByText('由 vw01 取消')).toBeInTheDocument();
    expect(screen.queryByTestId('batch-status')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '批次推論' }));
    await screen.findByRole('heading', { name: '推論結果 #2（20 筆）' });
    const history = await screen.findByRole('table', { name: '推論歷史' });
    await user.click(await within(history).findByRole('button', { name: '取消 #2' }));
    await waitFor(() => expect(within(history).getByRole('row', { name: /#2.*已取消/ })).toBeInTheDocument());
    expect(within(history).getByRole('row', { name: /#1.*已取消/ })).toBeInTheDocument();
    expect(within(history).queryByRole('button', { name: /^取消 #/ })).not.toBeInTheDocument();
  });

  it('waitForRecord polls until the record is finished and can be stopped', async () => {
    const seen: string[] = [];
    const states: InferenceRecord['status'][] = ['queued', 'running', 'running', 'succeeded'];
    const api = { record: async (id: number) => ({ id, status: states.shift() }) as InferenceRecord };
    const done = await waitForRecord(api, 7, { onUpdate: (r) => seen.push(r.status) });
    expect(done?.status).toBe('succeeded');
    expect(seen).toEqual(['queued', 'running', 'running', 'succeeded']);
    const stop = new AbortController();
    stop.abort();
    expect(await waitForRecord(api, 7, { signal: stop.signal })).toBeNull();
  });

  it('needs Prediction permission', async () => {
    await renderApp('/inference', 'user01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
  });
});
