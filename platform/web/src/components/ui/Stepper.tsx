import { Icon } from '../Icon';
import './ui.css';

export interface Step {
  label: string;
  /** 圓圈下方第二行小字，例：120 筆影像（設計稿 A01） */
  description?: string;
}

export type StepState = 'done' | 'current' | 'todo';

export function stepState(index: number, current: number): StepState {
  if (index < current) return 'done';
  if (index === current) return 'current';
  return 'todo';
}

/**
 * 步驟條：圓圈數字＋連線＋文字（設計稿 A01 資料→標註→結果、A06 選訓練種類→確認資料→確認並送出）。
 * current 從 0 起算；等於 steps.length 代表全部完成。編號由元件產生，label 不要再寫「1.」。
 */
export function Stepper({ steps, current, label = '步驟' }: { steps: Step[]; current: number; label?: string }) {
  return (
    <ol className="ui-stepper" aria-label={label}>
      {steps.map((s, i) => {
        const state = stepState(i, current);
        return (
          <li
            key={`${s.label}-${i}`}
            className={`ui-stepper__step ui-stepper__step--${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="ui-stepper__marker" aria-hidden="true">
              {state === 'done' ? <Icon name="check" /> : i + 1}
            </span>
            <span className="ui-stepper__label">
              <span className="visually-hidden">
                第 {i + 1} 步{state === 'done' ? '（已完成）' : state === 'current' ? '（目前）' : ''}：
              </span>
              {s.label}
            </span>
            {s.description && <span className="ui-stepper__desc">{s.description}</span>}
          </li>
        );
      })}
    </ol>
  );
}
