import { useId, useState, type ReactNode } from 'react';
import { formatTick, type Scale } from './scale';
import '../../styles/pages.css';

export const W = 640;
export const H = 320;
export const M = { top: 12, right: 16, bottom: 44, left: 56 };
export const PW = W - M.left - M.right;
export const PH = H - M.top - M.bottom;

export const px = (s: Scale, v: number) => M.left + s.at(v) * PW;
export const py = (s: Scale, v: number) => M.top + (1 - s.at(v)) * PH;

export interface LegendItem {
  label: string;
  color: string;
}

export interface TableView {
  caption: string;
  head: string[];
  rows: (string | number)[][];
}

/** 圖表外框：標題、SVG、圖例（2 個以上系列才有）、滑鼠或鍵盤指到的資料、表格檢視。 */
export function ChartFrame({
  title,
  description,
  legend,
  table,
  children,
}: {
  title: string;
  description: string;
  legend?: LegendItem[];
  table: TableView;
  children: (setActive: (text: string | null) => void) => ReactNode;
}) {
  const id = useId();
  const [active, setActive] = useState<string | null>(null);
  return (
    <figure className="chart" aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="chart__title">
        {title}
      </figcaption>
      <svg className="chart__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={description}>
        {children(setActive)}
      </svg>
      {legend && legend.length >= 2 && (
        <ul className="chart__legend" aria-label="圖例">
          {legend.map((l) => (
            <li key={l.label}>
              <span className="chart__swatch" style={{ background: l.color }} />
              {l.label}
            </li>
          ))}
        </ul>
      )}
      <p className="chart__tooltip" aria-live="polite">
        {active ?? '將滑鼠移到圖上，或用 Tab 鍵逐一查看數值'}
      </p>
      <details>
        <summary>表格檢視</summary>
        <div className="table-wrap">
          <table aria-label={table.caption}>
            <thead>
              <tr>
                {table.head.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className={typeof c === 'number' ? 'num' : undefined}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** 座標軸與水平格線（細、實線、退到背景）。 */
export function Axes({
  x,
  y,
  xLabel,
  yLabel,
  xTicks,
}: {
  x?: Scale;
  y: Scale;
  xLabel: string;
  yLabel: string;
  /** 類別軸：自訂刻度位置與文字 */
  xTicks?: { at: number; label: string }[];
}) {
  const ticks = xTicks ?? (x ? x.ticks.map((t) => ({ at: px(x, t), label: formatTick(t) })) : []);
  return (
    <g aria-hidden="true">
      {y.ticks.map((t) => (
        <g key={`y${t}`}>
          <line className="chart-grid" x1={M.left} x2={W - M.right} y1={py(y, t)} y2={py(y, t)} />
          <text className="chart-text" x={M.left - 8} y={py(y, t)} textAnchor="end" dominantBaseline="middle">
            {formatTick(t)}
          </text>
        </g>
      ))}
      <line className="chart-axis" x1={M.left} x2={W - M.right} y1={M.top + PH} y2={M.top + PH} />
      {ticks.map((t, i) => (
        <text key={`x${i}`} className="chart-text" x={t.at} y={M.top + PH + 16} textAnchor="middle">
          {t.label}
        </text>
      ))}
      <text className="chart-text" x={M.left + PW / 2} y={H - 6} textAnchor="middle">
        {xLabel}
      </text>
      <text className="chart-text" transform={`translate(14 ${M.top + PH / 2}) rotate(-90)`} textAnchor="middle">
        {yLabel}
      </text>
    </g>
  );
}

/** 資料標記的互動：滑鼠、鍵盤焦點都會更新說明列。 */
export function markProps(text: string, setActive: (t: string | null) => void) {
  return {
    className: 'chart-mark',
    tabIndex: 0,
    role: 'img' as const,
    'aria-label': text,
    onMouseEnter: () => setActive(text),
    onMouseLeave: () => setActive(null),
    onFocus: () => setActive(text),
    onBlur: () => setActive(null),
  };
}
