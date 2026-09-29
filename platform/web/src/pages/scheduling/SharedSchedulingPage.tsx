import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { SchedulingPage } from './SchedulingRoutes';
import type { SharedSchedulingSettings } from './types';

const PATH = '/api/admin/cluster/shared-scheduling';

function invalid(error: unknown, field: string): boolean {
  return error instanceof ApiError && error.fieldErrors.some((f) => f.field === field);
}

/** TC-A02-07 共享排程設定：時間片份數與共享池工作時限。儲存後以伺服器回傳值為準。 */
function SettingsForm({
  initial,
  onSaved,
}: {
  initial: SharedSchedulingSettings;
  onSaved: (s: SharedSchedulingSettings) => void;
}) {
  const { api } = useSession();
  const [replicas, setReplicas] = useState(String(initial.time_slice_replicas));
  const [timeout, setTimeoutMinutes] = useState(String(initial.job_timeout_minutes));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.put<SharedSchedulingSettings>(PATH, {
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
    <form aria-label="修改共享排程設定" className="card section" onSubmit={submit} noValidate>
      <h2>修改設定</h2>
      <ApiErrorAlert error={error} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="replicas">時間片份數（1–16）</label>
          <input
            id="replicas"
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={16}
            value={replicas}
            onChange={(e) => setReplicas(e.target.value)}
            aria-describedby="replicas-hint"
            aria-invalid={invalid(error, 'time_slice_replicas') || undefined}
          />
          <span id="replicas-hint" className="field__hint">
            一張共享 GPU 同時可排入的工作數
          </span>
        </div>
        <div className="field">
          <label htmlFor="timeout">工作時限（分鐘，1–1440）</label>
          <input
            id="timeout"
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            value={timeout}
            onChange={(e) => setTimeoutMinutes(e.target.value)}
            aria-describedby="timeout-hint"
            aria-invalid={invalid(error, 'job_timeout_minutes') || undefined}
          />
          <span id="timeout-hint" className="field__hint">
            共享池工作超過時限會被結束並標為失敗
          </span>
        </div>
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          儲存設定
        </button>
      </div>
    </form>
  );
}

export function SharedSchedulingPage() {
  const { api } = useSession();
  const settings = useResource(() => api.get<SharedSchedulingSettings>(PATH));
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <SchedulingPage title="共享排程設定">
      <p className="text-muted">
        共享池（gpu-shared）以時間片讓多件工作共用同一張 GPU。獨占池（gpu-exclusive）一件工作使用一張卡，不受這裡的設定影響。
      </p>
      <ApiErrorAlert error={settings.error} />
      {notice && <Alert tone="success">{notice}</Alert>}
      {settings.loading && !settings.data && <p role="status">載入中…</p>}
      {settings.data && (
        <>
          <section className="card section" aria-labelledby="current-settings">
            <h2 id="current-settings">目前設定</h2>
            <dl className="kv">
              <dt>時間片份數</dt>
              <dd data-testid="current-replicas">{settings.data.time_slice_replicas}</dd>
              <dt>工作時限（分鐘）</dt>
              <dd data-testid="current-timeout">{settings.data.job_timeout_minutes}</dd>
            </dl>
          </section>
          <SettingsForm
            initial={settings.data}
            onSaved={(saved) => {
              settings.setData(saved);
              setNotice(`已儲存：時間片 ${saved.time_slice_replicas} 份、工作時限 ${saved.job_timeout_minutes} 分鐘`);
            }}
          />
        </>
      )}
    </SchedulingPage>
  );
}
