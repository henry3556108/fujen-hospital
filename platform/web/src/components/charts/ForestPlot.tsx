import { Axes, ChartFrame, M, PH, markProps, px } from './Frame';
import { formatTick, logScale } from './scale';

export interface ForestRow {
  name: string;
  value: number;
  low: number;
  high: number;
}

/** 森林圖：每個變項一列，點為估計值、橫線為 95% 信賴區間，對數刻度，基準線為 1。 */
export function ForestPlot({ title, rows, measure }: { title: string; rows: ForestRow[]; measure: string }) {
  const x = logScale(Math.min(...rows.map((r) => r.low)), Math.max(...rows.map((r) => r.high)));
  const band = PH / Math.max(1, rows.length);
  // 類別軸畫在左側：借用 Axes 的 y 軸格式會誤導，這裡只畫 x 軸
  const y = { min: 0, max: 1, ticks: [] as number[], at: (v: number) => v };
  return (
    <ChartFrame
      title={title}
      description={`${title}：${rows.length} 個變項的 ${measure} 與 95% 信賴區間`}
      table={{
        caption: `${title}（表格）`,
        head: ['變項', measure, '95% CI 下限', '95% CI 上限'],
        rows: rows.map((r) => [r.name, Number(r.value.toPrecision(4)), Number(r.low.toPrecision(4)), Number(r.high.toPrecision(4))]),
      }}
    >
      {(setActive) => (
        <>
          <Axes x={x} y={y} xLabel={`${measure}（對數刻度）`} yLabel="" />
          <line className="chart-axis" x1={px(x, 1)} x2={px(x, 1)} y1={M.top} y2={M.top + PH} />
          {rows.map((r, i) => {
            const cy = M.top + band * (i + 0.5);
            const text = `${r.name}：${measure} ${formatTick(r.value)}（95% CI ${formatTick(r.low)}–${formatTick(r.high)}）`;
            return (
              <g key={r.name} {...markProps(text, setActive)}>
                <text className="chart-text" x={M.left - 8} y={cy} textAnchor="end" dominantBaseline="middle">
                  {r.name.length > 8 ? `${r.name.slice(0, 7)}…` : r.name}
                </text>
                <line x1={px(x, r.low)} x2={px(x, r.high)} y1={cy} y2={cy} stroke="var(--chart-series-1)" strokeWidth={2} strokeLinecap="round" />
                <circle cx={px(x, r.value)} cy={cy} r={5} fill="var(--chart-series-1)" stroke="var(--chart-surface)" strokeWidth={2} />
              </g>
            );
          })}
        </>
      )}
    </ChartFrame>
  );
}
