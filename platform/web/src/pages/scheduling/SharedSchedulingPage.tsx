import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert, Card, InfoList } from '../../components/ui';
import { SchedulingPage } from './SchedulingRoutes';
import type { SharedSchedulingSettings } from './types';

export const SHARED_PATH = '/api/admin/cluster/shared-scheduling';

function invalid(error: unknown, field: string): boolean {
  return error instanceof ApiError && error.fieldErrors.some((f) => f.field === field);
}

/**
 * TC-A02-07 共享排程設定：時間片份數與共享池工作時限。儲存後以伺服器回傳值為準。
 * 「共享設定」分頁與「排隊順序」右欄（設計稿 B22）共用。
 */
export function SharedSettingsForm({
  initial,
  onSaved,
  submitLabel = '儲存設定',
  idPrefix = '',
  secondary = false,
}: {
  initial: SharedSchedulingSettings;
  onSaved: (s: SharedSchedulingSettings) => void;
  submitLabel?: string;
  idPrefix?: string;
  /** true＝次要按鈕（排隊順序右欄：主要按鈕是「套用順序」） */
  secondary?: boolean;
}) {
  const { api } = useSession();
  const [replicas, setReplicas] = useState(String(initial.time_slice_replicas));
  const [timeout, setTimeoutMinutes] = useState(String(initial.job_timeout_minutes));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const id = (s: string) => `${idPrefix}${s}`;
  const n = Number(replicas);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.put<SharedSchedulingSettings>(SHARED_PATH, {
          time_slice_replicas: Number(replicas),
          job_timeout_minutes: Number(timeout),
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="修改共享排程設定" className="sch-form" onSubmit={submit} noValidate>
      <ApiErrorAlert error={error} />
      <div className="field">
        <label htmlFor={id('replicas')}>時間片份數（1–16）</label>
        <input
          id={id('replicas')}
          className="input"
          type="number"
          inputMode="numeric"
          min={1}
          max={16}
          value={replicas}
          onChange={(e) => setReplicas(e.target.value)}
          aria-describedby={id('replicas-hint')}
          aria-invalid={invalid(error, 'time_slice_replicas') || undefined}
        />
        <span id={id('replicas-hint')} className="field__hint">
          {n >= 1 ? `每件工作輪流使用 1 / ${n} 的時間片；` : ''}一張共享 GPU 同時可排入的工作數
        </span>
      </div>
      <div className="field">
        <label htmlFor={id('timeout')}>工作時限（分鐘，1–1440）</label>
        <input
          id={id('timeout')}
          className="input"
          type="number"
          inputMode="numeric"
          min={1}
          max={1440}
          value={timeout}
          onChange={(e) => setTimeoutMinutes(e.target.value)}
          aria-describedby={id('timeout-hint')}
          aria-invalid={invalid(error, 'job_timeout_minutes') || undefined}
        />
        <span id={id('timeout-hint')} className="field__hint">
          單一工作最多可執行的時間；共享池工作超過時限會被結束並標為失敗
        </span>
      </div>
      <p className="text-muted sch-note">獨占池（gpu-exclusive）一件工作使用一張卡，不受這裡的設定影響。</p>
      <div className="sch-form__actions">
        <button type="submit" className={`btn ${secondary ? 'btn--secondary' : 'btn--primary'} btn--block`} disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function SharedSchedulingPage() {
  const { api } = useSession();
  const settings = useResource(() => api.get<SharedSchedulingSettings>(SHARED_PATH));
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <SchedulingPage title="排隊與共享設定" subtitle="管理不同資源類型的排隊順序與共享規則">
      <p className="text-muted">共享池（gpu-shared）以時間片讓多件工作共用同一張 GPU。</p>
      <ApiErrorAlert error={settings.error} />
      {notice && <Alert tone="success">{notice}</Alert>}
      {settings.loading && !settings.data && <p role="status">載入中…</p>}
      {settings.data && (
        <div className="sch-shared">
          <Card title="目前設定">
            <InfoList
              items={[
                { label: '時間片份數', value: <span data-testid="current-replicas">{settings.data.time_slice_replicas}</span> },
                { label: '工作時限（分鐘）', value: <span data-testid="current-timeout">{settings.data.job_timeout_minutes}</span> },
              ]}
            />
          </Card>
          <Card title="共享排程設定">
            <SharedSettingsForm
              initial={settings.data}
              onSaved={(saved) => {
                settings.setData(saved);
                setNotice(`已儲存：時間片 ${saved.time_slice_replicas} 份、工作時限 ${saved.job_timeout_minutes} 分鐘`);
              }}
            />
          </Card>
        </div>
      )}
    </SchedulingPage>
  );
}
