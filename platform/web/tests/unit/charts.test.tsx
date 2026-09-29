import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BarChart } from '../../src/components/charts/BarChart';
import { ForestPlot } from '../../src/components/charts/ForestPlot';
import { cellColor, Heatmap } from '../../src/components/charts/Heatmap';
import { LineChart } from '../../src/components/charts/LineChart';
import { ScatterChart } from '../../src/components/charts/ScatterChart';
import { formatTick, logScale, niceScale, seriesColor } from '../../src/components/charts/scale';
import { contrastRatio, parseThemes } from '../../src/theme/contrast';
import { bodyRows } from '../table';

describe('chart scales', () => {
  it('niceScale picks round ticks that cover the data', () => {
    expect(niceScale(0, 35).ticks).toEqual([0, 10, 20, 30, 40]);
    expect(niceScale(16, 35).ticks).toEqual([15, 20, 25, 30, 35]);
    expect(niceScale(0, 1).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const s = niceScale(-32.5, 41);
    expect(s.min).toBeLessThanOrEqual(-32.5);
    expect(s.max).toBeGreaterThanOrEqual(41);
    expect(s.at(s.min)).toBe(0);
    expect(s.at(s.max)).toBe(1);
  });

  it('niceScale handles a single value and non-finite input', () => {
    expect(niceScale(5, 5).ticks.length).toBeGreaterThan(1);
    expect(niceScale(NaN, NaN).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it('logScale always includes the reference line at 1', () => {
    for (const [lo, hi] of [[0.94, 1.06], [0.2, 0.8], [1.5, 12], [0.05, 30]]) {
      const s = logScale(lo, hi);
      expect(s.ticks).toContain(1);
      expect(s.at(1)).toBeGreaterThan(0);
      expect(s.at(1)).toBeLessThan(1);
      expect(s.at(lo)).toBeGreaterThanOrEqual(0);
      expect(s.at(hi)).toBeLessThanOrEqual(1);
    }
  });

  it('formatTick keeps labels short', () => {
    expect(formatTick(0)).toBe('0');
    expect(formatTick(2500)).toBe('2,500');
    expect(formatTick(12.5)).toBe('12.5');
    expect(formatTick(0.025)).toBe('0.025');
  });

  it('categorical colour follows the series index in fixed order; the 4th and later series are neutral', () => {
    expect([0, 1, 2, 3, 7].map(seriesColor)).toEqual([
      'var(--chart-series-1)',
      'var(--chart-series-2)',
      'var(--chart-series-3)',
      'var(--chart-series-other)',
      'var(--chart-series-other)',
    ]);
  });
});

describe('chart colours', () => {
  const themes = parseThemes(readFileSync(resolve(__dirname, '../../src/theme/tokens.css'), 'utf8'));
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const mix = (a: string, b: string, t: number) =>
    `#${rgb(a).map((c, i) => Math.round(c * t + rgb(b)[i] * (1 - t)).toString(16).padStart(2, '0')).join('')}`;

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: heatmap text stays ≥ 4.5:1 on every cell colour`, () => {
      const t = themes[theme];
      for (const pole of ['--chart-negative', '--chart-positive']) {
        for (const strength of [0, 0.3, 0.6]) {
          const bg = mix(t[pole], t['--chart-neutral'], strength);
          expect(contrastRatio(t['--chart-cell-text'], bg), `${pole} ${strength}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${theme}: axis text ≥ 4.5:1 and axis line ≥ 3:1 on the chart surface`, () => {
      const t = themes[theme];
      expect(contrastRatio(t['--chart-text'], t['--chart-surface'])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t['--chart-axis'], t['--chart-surface'])).toBeGreaterThanOrEqual(3);
    });
  }

  it('dark: every series colour is ≥ 3:1 on the surface; light relies on legend and table view for series 3', () => {
    const dark = themes.dark;
    for (const n of [1, 2, 3]) expect(contrastRatio(dark[`--chart-series-${n}`], dark['--chart-surface'])).toBeGreaterThanOrEqual(3);
    const light = themes.light;
    for (const n of [1, 2]) expect(contrastRatio(light[`--chart-series-${n}`], light['--chart-surface'])).toBeGreaterThanOrEqual(3);
  });

  it('cellColor mixes toward the pole by |r| and is neutral for missing values', () => {
    expect(cellColor(0)).toBe('color-mix(in srgb, var(--chart-positive) 0%, var(--chart-neutral))');
    expect(cellColor(-0.5)).toBe('color-mix(in srgb, var(--chart-negative) 30%, var(--chart-neutral))');
    expect(cellColor(1)).toBe('color-mix(in srgb, var(--chart-positive) 60%, var(--chart-neutral))');
    expect(cellColor(null)).toBe('var(--chart-neutral)');
  });
});

describe('chart components', () => {
  it('BarChart: one mark per bar, no legend for a single series, table view has the same values', async () => {
    render(
      <BarChart
        title="bmi 分布"
        xLabel="bmi"
        yLabel="筆數"
        bars={[
          { label: '16', value: 15, detail: '16 – 19.8' },
          { label: '19.8', value: 17, detail: '19.8 – 23.6' },
          { label: '23.6', value: 35, detail: '23.6 – 27.4' },
        ]}
      />,
    );
    const fig = screen.getByRole('figure', { name: 'bmi 分布' });
    expect(within(fig).getByRole('img', { name: /bmi 分布：3 個直條，最大值 35/ })).toBeInTheDocument();
    expect(within(fig).getAllByRole('img', { name: /：\d+$/ }).map((m) => m.getAttribute('aria-label'))).toEqual([
      '16 – 19.8：15',
      '19.8 – 23.6：17',
      '23.6 – 27.4：35',
    ]);
    expect(within(fig).queryByRole('list', { name: '圖例' })).toBeNull();
    expect(bodyRows(within(fig).getByRole('table', { name: 'bmi 分布（表格）', hidden: true }))).toEqual([
      ['16 – 19.8', '15'],
      ['19.8 – 23.6', '17'],
      ['23.6 – 27.4', '35'],
    ]);
    // 鍵盤焦點會更新說明列
    await userEvent.setup().tab();
    expect(within(fig).getByText('16 – 19.8：15')).toBeInTheDocument();
  });

  it('LineChart: legend appears with 2 or more series and lists them in order', () => {
    const { rerender } = render(
      <LineChart
        title="存活曲線"
        xLabel="時間"
        yLabel="存活機率"
        step
        yRange={[0, 1]}
        series={[
          { name: 'F', points: [[0, 1], [5, 0.98], [9, 0.96]] },
          { name: 'M', points: [[0, 1], [4, 0.98]] },
        ]}
      />,
    );
    const legend = screen.getByRole('list', { name: '圖例' });
    expect(within(legend).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['F', 'M']);
    expect(bodyRows(screen.getByRole('table', { name: '存活曲線（表格）', hidden: true }))).toHaveLength(5);
    const paths = Array.from(document.querySelectorAll('path[stroke^="var(--chart-series"]'));
    expect(paths.map((p) => p.getAttribute('stroke'))).toEqual(['var(--chart-series-1)', 'var(--chart-series-2)']);
    expect(paths[0].getAttribute('d')).toMatch(/^M[\d.]+,[\d.]+ H[\d.]+ V[\d.]+ H/);

    rerender(<LineChart title="ROC" xLabel="FPR" yLabel="TPR" diagonal series={[{ name: 'ROC', points: [[0, 0], [0.2, 0.7], [1, 1]] }]} />);
    expect(screen.queryByRole('list', { name: '圖例' })).toBeNull();
  });

  it('ScatterChart: one point per row and a table view', () => {
    render(<ScatterChart title="age × bmi" xLabel="age" yLabel="bmi" points={[[48, 25.5], [75, 26.9], [83, 23.1]]} />);
    expect(document.querySelectorAll('circle')).toHaveLength(3);
    expect(bodyRows(screen.getByRole('table', { name: 'age × bmi（表格）', hidden: true }))).toEqual([
      ['48', '25.5'],
      ['75', '26.9'],
      ['83', '23.1'],
    ]);
  });

  it('ForestPlot: each row states the estimate and its interval', () => {
    render(
      <ForestPlot
        title="Hazard Ratio"
        measure="HR"
        rows={[
          { name: 'age', value: 1.042, low: 1.028, high: 1.057 },
          { name: 'bmi', value: 0.995, low: 0.94, high: 1.053 },
        ]}
      />,
    );
    expect(screen.getByRole('img', { name: 'age：HR 1.04（95% CI 1.03–1.06）' })).toBeInTheDocument();
    expect(bodyRows(screen.getByRole('table', { name: 'Hazard Ratio（表格）', hidden: true }))).toEqual([
      ['age', '1.042', '1.028', '1.057'],
      ['bmi', '0.995', '0.94', '1.053'],
    ]);
  });

  it('Heatmap: values are written in the cells and the legend explains the colours', () => {
    render(<Heatmap title="相關矩陣" columns={['age', 'bmi']} matrix={[[1, -0.0123], [-0.0123, 1]]} />);
    expect(bodyRows(screen.getByRole('table', { name: '相關矩陣' }))).toEqual([
      ['age', '1.00', '-0.01'],
      ['bmi', '-0.01', '1.00'],
    ]);
    expect(within(screen.getByRole('list', { name: '圖例' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      '負相關（−1）',
      '無相關（0）',
      '正相關（+1）',
    ]);
  });
});
