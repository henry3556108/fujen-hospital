import { Axes, ChartFrame, markProps, px, py } from './Frame';
import { formatTick, niceScale } from './scale';

const TABLE_LIMIT = 200;

/** 散佈圖：單一系列。點帶 2px 表面色外環，重疊時仍看得出來。 */
export function ScatterChart({
  title,
  points,
  xLabel,
  yLabel,
  reference,
}: {
  title: string;
  points: [number, number][];
  xLabel: string;
  yLabel: string;
  /** 水平參考線（例如殘差圖的 0） */
  reference?: number;
}) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = niceScale(Math.min(...xs), Math.max(...xs));
  const y = niceScale(Math.min(...ys, reference ?? Infinity), Math.max(...ys, reference ?? -Infinity));
  const shown = points.slice(0, TABLE_LIMIT);
  return (
    <ChartFrame
      title={title}
      description={`${title}：${points.length} 個點，橫軸 ${xLabel}，縱軸 ${yLabel}`}
      table={{
        caption: `${title}（表格${points.length > TABLE_LIMIT ? `，前 ${TABLE_LIMIT} 筆` : ''}）`,
        head: [xLabel, yLabel],
        rows: shown.map((p) => [Number(p[0].toPrecision(6)), Number(p[1].toPrecision(6))]),
      }}
    >
      {(setActive) => (
        <>
          <Axes x={x} y={y} xLabel={xLabel} yLabel={yLabel} />
          {reference !== undefined && (
            <line className="chart-axis" x1={px(x, x.min)} x2={px(x, x.max)} y1={py(y, reference)} y2={py(y, reference)} />
          )}
          {points.map((p, i) => (
            <circle
              key={i}
              cx={px(x, p[0])}
              cy={py(y, p[1])}
              r={4}
              fill="var(--chart-series-1)"
              stroke="var(--chart-surface)"
              strokeWidth={2}
              {...markProps(`${xLabel} ${formatTick(p[0])}，${yLabel} ${formatTick(p[1])}`, setActive)}
              tabIndex={-1}
            />
          ))}
        </>
      )}
    </ChartFrame>
  );
}
