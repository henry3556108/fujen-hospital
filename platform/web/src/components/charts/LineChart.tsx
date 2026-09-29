import { Axes, ChartFrame, markProps, px, py } from './Frame';
import { formatTick, niceScale, seriesColor } from './scale';

export interface Series {
  name: string;
  points: [number, number][];
}

const TABLE_LIMIT = 300;

/** 折線圖：存活曲線（階梯）與 ROC 曲線。2 個以上系列時顯示圖例，並在線尾直接標名稱（最多 3 條）。 */
export function LineChart({
  title,
  series,
  xLabel,
  yLabel,
  step = false,
  yRange,
  diagonal = false,
}: {
  title: string;
  series: Series[];
  xLabel: string;
  yLabel: string;
  /** 階梯線（Kaplan-Meier） */
  step?: boolean;
  yRange?: [number, number];
  /** 畫出對角參考線（ROC 的隨機猜測） */
  diagonal?: boolean;
}) {
  const all = series.flatMap((s) => s.points);
  const x = niceScale(Math.min(0, ...all.map((p) => p[0])), Math.max(...all.map((p) => p[0])));
  const y = yRange ? niceScale(yRange[0], yRange[1]) : niceScale(Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1])));
  const path = (pts: [number, number][]) =>
    pts
      .map((p, i) => {
        const X = px(x, p[0]).toFixed(1);
        const Y = py(y, p[1]).toFixed(1);
        if (i === 0) return `M${X},${Y}`;
        return step ? `H${X} V${Y}` : `L${X},${Y}`;
      })
      .join(' ');
  const rows = series.flatMap((s) => s.points.map((p): (string | number)[] => [s.name, Number(p[0].toPrecision(6)), Number(p[1].toPrecision(6))]));
  return (
    <ChartFrame
      title={title}
      description={`${title}：${series.map((s) => s.name).join('、')}，橫軸 ${xLabel}，縱軸 ${yLabel}`}
      legend={series.map((s, i) => ({ label: s.name, color: seriesColor(i) }))}
      table={{
        caption: `${title}（表格${rows.length > TABLE_LIMIT ? `，前 ${TABLE_LIMIT} 筆` : ''}）`,
        head: ['系列', xLabel, yLabel],
        rows: rows.slice(0, TABLE_LIMIT),
      }}
    >
      {(setActive) => (
        <>
          <Axes x={x} y={y} xLabel={xLabel} yLabel={yLabel} />
          {diagonal && <line className="chart-axis" x1={px(x, 0)} y1={py(y, 0)} x2={px(x, 1)} y2={py(y, 1)} />}
          {series.map((s, i) => (
            <g key={s.name}>
              <path d={path(s.points)} fill="none" stroke={seriesColor(i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {/* 較粗的透明線當作滑鼠目標 */}
              <path
                d={path(s.points)}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                {...markProps(`${s.name}：${s.points.length} 個點，最後一點 ${xLabel} ${formatTick(s.points.at(-1)![0])}、${yLabel} ${formatTick(s.points.at(-1)![1])}`, setActive)}
              />
            </g>
          ))}
        </>
      )}
    </ChartFrame>
  );
}
