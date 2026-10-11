// 圖示步驟條（B5）：已送出 → 排隊中 → 訓練中 → 完成（或失敗、已取消）。每一步都有圖示與文字，不只靠顏色。
import type { RunStatus } from './api';

type StepState = 'done' | 'current' | 'todo' | 'failed';

const ICONS: Record<StepState, string> = {
  done: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.5 14.5-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7Z',
  current: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z',
  todo: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Z',
  failed: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.5 12.1-1.4 1.4L12 13.4l-2.1 2.1-1.4-1.4 2.1-2.1-2.1-2.1 1.4-1.4 2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1Z',
};

export const STATUS_TEXT: Record<RunStatus, string> = {
  queued: '排隊中：等待運算資源', running: '訓練中', succeeded: '已完成', failed: '失敗', cancelled: '已取消',
  held: '已暫存：移出佇列，按「恢復排隊」後重新排到最後',
};

export function stepsOf(status: RunStatus): { label: string; state: StepState }[] {
  const at = { queued: 1, held: 1, running: 2, succeeded: 3, failed: 3, cancelled: 3 }[status] ?? 1;
  const last = status === 'failed' ? '失敗' : status === 'cancelled' ? '已取消' : '完成';
  return ['已送出', status === 'held' ? '已暫存' : '排隊中', '訓練中', last].map((label, i) => ({
    label,
    state: i < at ? 'done' : i > at ? 'todo' : status === 'failed' || status === 'cancelled' ? 'failed' : status === 'succeeded' ? 'done' : 'current',
  }));
}

export function RunSteps({ status, runId }: { status: RunStatus; runId: number }) {
  return (
    <ol className="run-steps" aria-label={`訓練 #${runId} 的進度`}>
      {stepsOf(status).map((s) => (
        <li key={s.label} className={`run-steps__step run-steps__step--${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path fill="currentColor" d={ICONS[s.state]} />
          </svg>
          <span>{s.label}</span>
          <span className="visually-hidden">（{{ done: '已完成', current: '進行中', todo: '尚未開始', failed: '已結束' }[s.state]}）</span>
        </li>
      ))}
    </ol>
  );
}
