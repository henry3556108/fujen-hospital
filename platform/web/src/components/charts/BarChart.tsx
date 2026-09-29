import { Axes, ChartFrame, M, PH, PW, markProps, py } from './Frame';
import { niceScale } from './scale';

export interface Bar {
  label: string;
  value: number;
  /** 說明列與表格用的完整名稱（例如分箱範圍） */
  detail?: string;
}

/** 直條圖：分布（直方圖）與類別次數。單一系列，不需要圖例。 */
export function BarChart({ title, bars, xLabel, yLabel }: { title: string; bars: Bar[]; xLabel: string; yLabel: string }) {
  const y = niceScale(0, Math.max(1, ...bars.map((b) => b.value)));
  const band = PW / Math.max(1, bars.length);
  const width = Math.max(2, Math.min(24, band - 2));
  const every = Math.ceil(bars.length / 10);
  return (
    <ChartFrame
      title={title}
      description={`${title}：${bars.length} 個直條，最大值 ${Math.max(0, ...bars.map((b) => b.value))}`}
      table={{ caption: `${title}（表格）`, head: [xLabel, yLabel], rows: bars.map((b) => [b.detail ?? b.label, b.value]) }}
    >
      {(setActive) => (
        <>
          <Axes
            y={y}
            xLabel={xLabel}
            yLabel={yLabel}
            xTicks={bars.map((b, i) => ({ at: M.left + band * (i + 0.5), label: i % every === 0 ? b.label : '' }))}
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
