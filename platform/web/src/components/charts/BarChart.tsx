import { Axes, ChartFrame, H, M, PH, PW, W, markProps, py } from './Frame';
import { formatTick, niceScale } from './scale';

export interface Bar {
  label: string;
  value: number;
  /** 說明列與表格用的完整名稱（例如分箱範圍） */
  detail?: string;
}

/** 文字在 12px 下的大約寬度（中文、全形字約 12px，其他約 7px），用來判斷軸標籤會不會重疊。 */
export function labelWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += /[⺀-￯]/.test(ch) ? 12 : 7;
  return w;
}

const ANGLE = 40;

/** 直條的軸標籤排法：放得下就水平；放不下就斜放（並多留下方高度）；直條太窄時隔幾個才標一次。 */
export function tickLayout(labels: string[], band: number): { angle: number; extra: number; every: number } {
  const widest = Math.max(0, ...labels.map(labelWidth));
  if (widest <= band - 6) return { angle: 0, extra: 0, every: Math.ceil(labels.length / 10) };
  const every = Math.max(1, Math.ceil(16 / band));
  const extra = Math.min(110, Math.ceil(widest * Math.sin((ANGLE * Math.PI) / 180)) + 4);
  return { angle: -ANGLE, extra, every };
}

/**
 * 直條圖：分布（直方圖）與類別次數。單一系列，不需要圖例。
 * horizontal：橫條圖（標籤在左側，適合名稱較長的項目，例如特徵重要性）。
 */
export function BarChart({ title, bars, xLabel, yLabel, horizontal = false }: {
  title: string; bars: Bar[]; xLabel: string; yLabel: string; horizontal?: boolean;
}) {
  if (horizontal) return <HorizontalBars title={title} bars={bars} xLabel={xLabel} yLabel={yLabel} />;
  const y = niceScale(0, Math.max(1, ...bars.map((b) => b.value)));
  const band = PW / Math.max(1, bars.length);
  const width = Math.max(2, Math.min(24, band - 2));
  const layout = tickLayout(bars.map((b) => b.label), band);
  return (
    <ChartFrame
      title={title}
      description={`${title}：${bars.length} 個直條，最大值 ${Math.max(0, ...bars.map((b) => b.value))}`}
      table={{ caption: `${title}（表格）`, head: [xLabel, yLabel], rows: bars.map((b) => [b.detail ?? b.label, b.value]) }}
      height={H + layout.extra}
    >
      {(setActive) => (
        <>
          <Axes
            y={y}
            xLabel={xLabel}
            yLabel={yLabel}
            tickAngle={layout.angle}
            extraBottom={layout.extra}
            xTicks={bars.map((b, i) => ({ at: M.left + band * (i + 0.5), label: i % layout.every === 0 ? b.label : '' }))}
          />
          {bars.map((b, i) => {
            const top = py(y, b.value);
            const h = M.top + PH - top;
            const x = M.left + band * (i + 0.5) - width / 2;
            const r = Math.min(4, width / 2, h);
            // 資料端圓角、基線端方角
            const d = `M${x},${M.top + PH} V${top + r} Q${x},${top} ${x + r},${top} H${x + width - r} Q${x + width},${top} ${x + width},${top + r} V${M.top + PH} Z`;
            return <path key={i} d={d} fill="var(--chart-series-1)" {...markProps(`${b.detail ?? b.label}：${b.value}`, setActive)} />;
          })}
        </>
      )}
    </ChartFrame>
  );
}

const ROW = 26;

/** 橫條圖：每個項目一列，名稱完整顯示在左側，數值軸在下方。 */
function HorizontalBars({ title, bars, xLabel, yLabel }: { title: string; bars: Bar[]; xLabel: string; yLabel: string }) {
  const x = niceScale(0, Math.max(1, ...bars.map((b) => b.value)));
  const left = Math.min(220, Math.max(56, Math.max(0, ...bars.map((b) => labelWidth(b.label))) + 16));
  const right = 24;
  const plot = W - left - right;
  const top = 8;
  const height = top + bars.length * ROW + 44;
  const at = (v: number) => left + x.at(v) * plot;
  return (
    <ChartFrame
      title={title}
      description={`${title}：${bars.length} 個橫條，最大值 ${Math.max(0, ...bars.map((b) => b.value))}`}
      table={{ caption: `${title}（表格）`, head: [yLabel, xLabel], rows: bars.map((b) => [b.detail ?? b.label, b.value]) }}
      height={height}
    >
      {(setActive) => (
        <>
          <g aria-hidden="true">
            {x.ticks.map((t) => (
              <g key={t}>
                <line className="chart-grid" x1={at(t)} x2={at(t)} y1={top} y2={top + bars.length * ROW} />
                <text className="chart-text" x={at(t)} y={top + bars.length * ROW + 16} textAnchor="middle">
                  {formatTick(t)}
                </text>
              </g>
            ))}
            <line className="chart-axis" x1={left} x2={left} y1={top} y2={top + bars.length * ROW} />
            {bars.map((b, i) => (
              <text key={i} className="chart-text" x={left - 8} y={top + ROW * (i + 0.5)} textAnchor="end" dominantBaseline="middle">
                {b.label}
              </text>
            ))}
            <text className="chart-text" x={left + plot / 2} y={height - 6} textAnchor="middle">
              {xLabel}
            </text>
          </g>
          {bars.map((b, i) => {
            const w = Math.max(0, at(b.value) - left);
            const y0 = top + ROW * i + 5;
            const hgt = ROW - 10;
            const r = Math.min(4, hgt / 2, w);
            // 資料端圓角、基線端方角
            const d = `M${left},${y0} H${left + w - r} Q${left + w},${y0} ${left + w},${y0 + r} V${y0 + hgt - r} Q${left + w},${y0 + hgt} ${left + w - r},${y0 + hgt} H${left} Z`;
            return <path key={i} d={d} fill="var(--chart-series-1)" {...markProps(`${b.detail ?? b.label}：${b.value}`, setActive)} />;
          })}
        </>
      )}
    </ChartFrame>
  );
}
