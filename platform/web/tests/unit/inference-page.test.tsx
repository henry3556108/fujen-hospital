// 推論服務管理頁（元件層級，模擬 API）。TC-B06-01、02、03、04。
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { resetInferenceMock } from '../../src/mocks/inference';
import { renderApp } from '../render';

afterEach(() => resetInferenceMock());

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

  it('server errors are shown in Chinese', async () => {
    const { user } = await openModel('diagnosis-rf-run1');
    await user.upload(screen.getByLabelText('CSV 檔'), new File(['foo,bar\n1,2\n'], 'x.csv', { type: 'text/csv' }));
    await user.click(screen.getByRole('button', { name: '上傳並推論' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('資料缺少特徵欄位：age、bmi、glucose、sbp');
  });

  it('needs Prediction permission', async () => {
    await renderApp('/inference', 'user01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
  });
});
