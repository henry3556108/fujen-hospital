import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import { Icon } from './Icon';

export type Tone = 'error' | 'warning' | 'success' | 'info';

const TITLES: Record<Tone, string> = {
  error: '錯誤',
  warning: '注意',
  success: '完成',
  info: '說明',
};

/** 行內訊息：顏色 + Icon + 文字標題，三者並用。 */
export function Alert({ tone, title, children }: { tone: Tone; title?: string; children: ReactNode }) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone} className="alert__icon" />
      <div className="alert__body">
        <strong className="alert__title">{title ?? TITLES[tone]}：</strong>
        <span>{children}</span>
      </div>
    </div>
  );
}

const STATUS_TITLES: Record<number, string> = {
  0: '連線失敗',
  401: '登入已失效',
  403: '沒有權限',
  404: '找不到資料',
  409: '資料衝突',
  422: '資料驗證失敗',
};

/** 把 API 錯誤轉成行內訊息；422 另外列出每個欄位。 */
export function ApiErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiError) {
    const title = STATUS_TITLES[error.status] ?? '錯誤';
    if (error.status === 422 && error.fieldErrors.length > 0) {
      return (
        <Alert tone="error" title={title}>
          <ul className="alert__list">
            {error.fieldErrors.map((f) => (
              <li key={f.field + f.message}>{f.message}</li>
            ))}
          </ul>
        </Alert>
      );
    }
    return (
      <Alert tone="error" title={title}>
        {error.message}
      </Alert>
    );
  }
  return <Alert tone="error">{error instanceof Error ? error.message : String(error)}</Alert>;
}
