import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { GATEWAY_METHODS, formatTime, type GatewayRoute } from './types';

function ManagedRouteForm({ route, onSaved }: { route: GatewayRoute; onSaved: (r: GatewayRoute) => void }) {
  const { api } = useSession();
  const [enabled, setEnabled] = useState(route.enabled);
  const [methods, setMethods] = useState<string[]>(route.methods);
  const [threshold, setThreshold] = useState(String(route.alert_threshold_per_minute ?? 120));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ordered = GATEWAY_METHODS.filter((m) => methods.includes(m));
      onSaved(
        await api.patch<GatewayRoute>(`/api/admin/gateway/routes/${route.id}`, {
          enabled,
          methods: ordered,
          alert_threshold_per_minute: Number(threshold),
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (m: string) => setMethods((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : [...ms, m]));

  return (
    <form aria-label={`修改路由 ${route.id}`} className="card section" onSubmit={submit}>
      <h2>修改路由 {route.id}</h2>
      <p className="text-muted">
        修改立即生效：Gateway 每次請求都會向平台確認路由政策。{route.updated_by && `上次修改：${route.updated_by}，${formatTime(route.updated_at)}。`}
      </p>
      <ApiErrorAlert error={error} />
      <label className="checkbox-row">
        <input type="checkbox" className="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        啟用這條路由
      </label>
      <fieldset className="field">
        <legend>允許的方法</legend>
        <div className="fhir-methods">
          {GATEWAY_METHODS.map((m) => (
            <label key={m} className="checkbox-row">
              <input type="checkbox" className="checkbox" checked={methods.includes(m)} onChange={() => toggle(m)} />
              {m}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="route-threshold">流量告警門檻（每位使用者每分鐘請求數）</label>
        <input
          id="route-threshold"
          className="input"
          type="number"
          min={1}
          max={100000}
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
        />
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          儲存路由設定
        </button>
      </div>
    </form>
  );
}

export function GatewayRoutesPage() {
  const { api } = useSession();
  const routes = useResource(() => api.get<GatewayRoute[]>('/api/admin/gateway/routes'));
  const [notice, setNotice] = useState<string | null>(null);
  const managed = routes.data?.filter((r) => r.managed) ?? [];

  return (
    <div className="section">
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={routes.error} />
      <div className="table-wrap">
        <table aria-label="Gateway 路由">
          <thead>
            <tr>
              <th scope="col">路由</th>
              <th scope="col">路徑</th>
              <th scope="col">上游</th>
              <th scope="col">方法</th>
              <th scope="col">外掛</th>
              <th scope="col">狀態</th>
              <th scope="col">告警門檻</th>
            </tr>
          </thead>
          <tbody>
            {routes.loading && !routes.data && (
              <tr>
                <td colSpan={7} role="status">
                  載入中…
                </td>
              </tr>
            )}
            {routes.data?.map((r) => (
              <tr key={r.id}>
                <th scope="row">
                  {r.managed ? r.id : '靜態路由'}{' '}
                  {r.managed ? <span className="badge">可在此修改</span> : <span className="badge">部署設定檔</span>}
                </th>
                <td className="fhir-code">{r.uri}</td>
                <td className="fhir-code">{r.upstream.join('、') || '—'}</td>
                <td>{r.methods.join(' ')}</td>
                <td>{r.plugins.join('、') || '—'}</td>
                <td>{r.enabled ? '啟用' : '停用'}</td>
                <td>{r.alert_threshold_per_minute ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-muted">部署設定檔內的路由要改設定檔後重新部署；這裡只列出路由，不顯示外掛內的認證資訊。</p>
      {managed.map((r) => (
        <ManagedRouteForm
          key={`${r.id}:${r.updated_at}`}
          route={r}
          onSaved={(saved) => {
            setNotice(`已儲存路由「${saved.id}」：${saved.enabled ? '啟用' : '停用'}，方法 ${saved.methods.join(' ')}`);
            routes.reload();
          }}
        />
      ))}
    </div>
  );
}
