// 第三輪後使用性測試的五個缺陷（docs/usability/2026-10-03-round3.md、docs/superpowers/plans/2026-10-03-qoca-ux.md「修正五個缺陷」）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderApp } from '../render';
import { resetInferenceMock } from '../../src/mocks/inference';
import { inferencePolling, type Model } from '../../src/pages/inference/api';
import { positiveChance, positiveLabel } from '../../src/pages/inference/positive';
import { resultText } from '../../src/pages/deployment/TryPredict';
import { positiveSentence } from '../../src/pages/training/metrics';
import type { TrainingRun } from '../../src/pages/training/api';

vi.setConfig({ testTimeout: 30_000 });

const binary = { kind: 'tabular_classification', card: { target: 'diagnosis', classes: ['0', '1'] } } as Model;
const multi = { kind: 'tabular_classification', card: { target: 'grade', classes: ['a', 'b', 'c'] } } as Model;

describe('缺陷 1：機率一律是陽性類別的機率', () => {
  beforeEach(() => Object.assign(inferencePolling, { firstMs: 1, maxMs: 5 }));
  afterEach(() => {
    resetInferenceMock();
    Object.assign(inferencePolling, { firstMs: 1000, maxMs: 5000 });
  });

  it('the positive class is the second class (1 for 0/1); multi-class has none', () => {
    expect(positiveLabel(binary)).toBe('1');
    expect(positiveLabel(multi)).toBeNull();
    expect(positiveLabel({ ...binary, kind: 'tabular_regression' } as Model)).toBeNull();
    expect(positiveLabel(binary, { positive_label: 'yes' })).toBe('yes');
  });

  it('uses the positive column when present, otherwise derives it from the predicted class (older records)', () => {
    const columns = ['id', 'prediction_positive_probability', 'prediction', 'prediction_probability', 'prediction_note'];
    expect(positiveChance(['a', '0.06', '0', '0.94', ''], columns, 'prediction', '1')).toBeCloseTo(0.06);
    const old = ['id', 'prediction', 'prediction_probability', 'prediction_note'];
    expect(positiveChance(['a', '0', '0.94', ''], old, 'prediction', '1')).toBeCloseTo(0.06);
    expect(positiveChance(['a', '1', '0.83', ''], old, 'prediction', '1')).toBeCloseTo(0.83);
    expect(positiveChance(['a', '', '', ''], old, 'prediction', '1')).toBeNull();
  });

  it('the single try-out says the probability of diagnosis＝1, whichever class was predicted', () => {
    expect(resultText(binary, { prediction: '0', probability: '0.94', note: 'diagnosis＝1 的機率 6%' })).toBe('diagnosis＝1 的機率 6%（模型預測為「0」）。');
    expect(resultText(binary, { prediction: '1', probability: '0.83', positive: '0.83', note: 'diagnosis＝1 的機率 83%（glucose 缺值，已用訓練資料的中位數 100 補上）' }))
      .toBe('diagnosis＝1 的機率 83%（模型預測為「1」）。glucose 缺值，已用訓練資料的中位數 100 補上。');
    // 舊格式的說明欄（升級前的紀錄）也一樣換成陽性的機率
    expect(resultText(binary, { prediction: '0', probability: '0.94', note: '預測為「0」的機率 94%（glucose 缺值，已用訓練資料的中位數補上）' }))
      .toBe('diagnosis＝1 的機率 6%（模型預測為「0」）。glucose 缺值，已用訓練資料的中位數補上。');
    expect(resultText(multi, { prediction: 'b', probability: '0.7', note: '預測為「b」的機率 70%' })).toBe('grade 預測為「b」的機率 70%。');
  });

  it('the batch table shows a 「diagnosis＝1 的機率」 column and the note in the same terms', async () => {
    const { user } = await renderApp('/inference?model=101', 'pi01');
    await user.click(await screen.findByRole('button', { name: '多位病人一起預測' }));
    const table = await screen.findByRole('table', { name: '預測結果' });
    const header = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(header.slice(0, 6)).toEqual(['patient_id', 'diagnosis（實際）', '預測結果', 'diagnosis＝1 的機率', '預測對／錯', '說明']);
    expect(header).not.toContain('機率');
    for (const row of within(table).getAllByRole('row').slice(1)) {
      const cells = within(row).getAllByRole('cell').map((c) => c.textContent ?? '');
      if (cells[2] === '') continue;
      const chance = Number(cells[3].replace('%', ''));
      // 預測為 1 ⇔ diagnosis＝1 的機率超過一半
      expect(cells[2] === '1').toBe(chance > 50);
      expect(cells[5]).toMatch(new RegExp(`^diagnosis＝1 的機率 ${chance}%`));
    }
    expect(screen.getByText(/prediction_positive_probability/)).toBeInTheDocument();
  });

  it('the training result names the positive class', () => {
    const run = { kind: 'tabular_classification', metrics: { labels: { majority: '0', positive: '1' } },
      config: { tabular: { target: 'diagnosis' } } } as unknown as TrainingRun;
    expect(positiveSentence(run)).toBe('陽性＝diagnosis 為「1」：敏感度、特異度、ROC 曲線，以及預測時顯示的「diagnosis＝1 的機率」都以這一類計算。');
    expect(positiveSentence({ ...run, metrics: { labels: { majority: 'a' } } } as unknown as TrainingRun)).toBe('');
  });
});
