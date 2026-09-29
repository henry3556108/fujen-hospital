// 圖表共用：座標換算與刻度。圖表一律單一 y 軸。

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
  /** 資料值 → 0..1 */
  at: (value: number) => number;
}

const STEPS = [1, 2, 2.5, 5, 10];

/** 取整的刻度：涵蓋 [min, max]，約 count 格。 */
export function niceScale(min: number, max: number, count = 5): Scale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return niceScale(0, 1, count);
  if (min === max) {
    const pad = Math.abs(min) || 1;
    return niceScale(min - pad / 2, max + pad / 2, count);
  }
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = (STEPS.find((s) => s * power >= raw) ?? 10) * power;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let i = 0; lo + i * step <= hi + step / 1e6; i++) ticks.push(Number((lo + i * step).toPrecision(12)));
  return { min: lo, max: hi, ticks, at: (v) => (v - lo) / (hi - lo) };
}

/** 對數刻度（森林圖的 HR／OR）：以 1 為基準線。 */
export function logScale(min: number, max: number): Scale {
  const lo = Math.min(min, 1);
  const hi = Math.max(max, 1);
  const a = Math.log(lo > 0 ? lo : 0.01) - 0.1;
  const b = Math.log(hi) + 0.1;
  const candidates = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
  let ticks = candidates.filter((t) => Math.log(t) >= a && Math.log(t) <= b);
  if (ticks.length < 3) {
    const fine = [0.8, 0.9, 0.95, 1, 1.05, 1.1, 1.25];
    ticks = fine.filter((t) => Math.log(t) >= a && Math.log(t) <= b);
  }
  return { min: Math.exp(a), max: Math.exp(b), ticks, at: (v) => (Math.log(v) - a) / (b - a) };
}

export function formatTick(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return String(Number(value.toFixed(2)));
  return String(Number(value.toPrecision(2)));
}

export const SERIES_COLORS = ['var(--chart-series-1)', 'var(--chart-series-2)', 'var(--chart-series-3)'];
export const OTHER_COLOR = 'var(--chart-series-other)';
/** 類別色最多 3 個系列；第 4 個以後用中性色，靠圖例與表格辨識。 */
export const seriesColor = (index: number) => SERIES_COLORS[index] ?? OTHER_COLOR;
