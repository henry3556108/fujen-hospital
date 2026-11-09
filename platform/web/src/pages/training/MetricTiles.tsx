// 指標方塊（設計稿 A07）：圓環＋大數字＋計數（5 / 6，由混淆矩陣算）＋一句話。
// 訓練結果（建模管理）與訓練結果（模型部署與推論服務）共用。圓環只畫 0～1 的指標（比例、AUC、Dice…），誤差類不畫。
import type { ReactNode } from 'react';
import { METRICS } from './metrics';

export interface MetricTile {
  name: string;
  label: string;
  /** 原始數值（0～1 的比例或其他），決定圓環 */
  value: number | null;
  /** 顯示的數字，例：83.3%、0.91 */
  text: string;
  /** 計數，例：5 / 6 */
  count?: string;
  /** 白話一句 */
  plain?: ReactNode;
  help?: string;
}

const ringable = (name: string, v: number | null) => typeof v === 'number' && v >= 0 && v <= 1 && !METRICS[name]?.lower && name !== 'score';

function Ring({ value }: { value: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg className="trn-ring" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true" focusable="false">
      <circle className="trn-ring__track" cx="32" cy="32" r={r} />
      <circle className="trn-ring__fill" cx="32" cy="32" r={r} strokeDasharray={`${c * value} ${c}`} transform="rotate(-90 32 32)" />
    </svg>
  );
}

export function MetricTiles({ tiles, label }: { tiles: MetricTile[]; label: string }) {
  return (
    <ul className="trn-tiles" aria-label={label}>
      {tiles.map((t) => (
        <li key={t.name} className="trn-tile metric-card">
          <span className="trn-tile__label metric-card__label">{t.label}</span>
          <span className="trn-tile__main">
            {ringable(t.name, t.value) ? <Ring value={t.value as number} /> : null}
            <span className="trn-tile__numbers">
              <span className="trn-tile__value metric-card__value">{t.text}</span>
              {t.count ? <span className="trn-tile__count" data-testid="metric-count">（{t.count}）</span> : null}
            </span>
          </span>
          {t.plain ? <span className="trn-tile__plain metric-card__plain">{t.plain}</span> : null}
          {t.help ? <span className="trn-tile__help metric-card__help">{t.help}</span> : null}
        </li>
      ))}
    </ul>
  );
}
