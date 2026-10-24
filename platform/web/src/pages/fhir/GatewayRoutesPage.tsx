import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert, Card, Icon, InfoList, SidePanel, SplitLayout, StatusDot, Toggle } from '../../components/ui';
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
    <form aria-label={`修改路由 ${route.id}`} className="stack" onSubmit={submit}>
      <ApiErrorAlert error={error} />
      <InfoList
        items={[
          { label: '路由名稱', value: route.id },
          { label: 'API 路徑', value: <span className="fhir-code">{route.uri}</span> },
          { label: '上游服務', value: <span className="fhir-code">{route.upstream.join('、') || '—'}</span> },
        ]}
      />
      <Toggle checked={enabled} onChange={setEnabled} label="啟用這條路由" />
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
        <label htmlFor="route-threshold">每人每分鐘門檻（流量告警，次／分鐘）</label>
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
      <Alert tone="warning">
        變更會立即生效，影響全平台所有專案與使用中的服務，請確認後再儲存。
        {route.updated_by && ` 上次修改：${route.updated_by}，${formatTime(route.updated_at)}。`}
      </Alert>
      <div className="fhir-form-actions fhir-form-actions--stack">
        <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
          儲存路由設定
        </button>
        <Link to="/admin/fhir/alerts" className="btn btn--secondary btn--block">
          ← 返回專案告警
        </Link>
      </div>
    </form>
  );
}

/** Gateway 路由與流量門檻（設計稿 B28）：全平台設定；受管路由可在右欄修改，部署設定檔的路由唯讀。 */
export function GatewayRoutesPage() {
  const { api } = useSession();
  const routes = useResource(() => api.get<GatewayRoute[]>('/api/admin/gateway/routes'));
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const list = routes.data ?? [];
  const keyOf = (r: GatewayRoute, i: number) => (r.managed ? r.id : `static-${i}`);
  // 預設選第一條受管路由
  const firstManaged = list.findIndex((r) => r.managed);
  const selectedIndex = selectedKey ? list.findIndex((r, i) => keyOf(r, i) === selectedKey) : firstManaged;
  const selected = selectedIndex >= 0 ? list[selectedIndex] : null;

  const side = selected ? (
    <SidePanel title={selected.managed ? '編輯路由設定' : '路由設定（唯讀）'}>
      {selected.managed ? (
        <ManagedRouteForm
          key={`${selected.id}:${selected.updated_at}`}
          route={selected}
          onSaved={(saved) => {
            setNotice(`已儲存路由「${saved.id}」：${saved.enabled ? '啟用' : '停用'}，方法 ${saved.methods.join(' ')}`);
            routes.reload();
          }}
        />
      ) : (
        <div className="stack">
          <InfoList
            items={[
              { label: 'API 路徑', value: <span className="fhir-code">{selected.uri}</span> },
              { label: '上游服務', value: <span className="fhir-code">{selected.upstream.join('、') || '—'}</span> },
              { label: '方法', value: selected.methods.join(' ') || '—' },
              { label: '外掛', value: selected.plugins.join('、') || '—' },
              { label: '狀態', value: selected.enabled ? '啟用' : '停用' },
            ]}
          />
          <Alert tone="info">這條路由由部署設定檔控制，要改設定檔後重新部署，這裡不能修改。</Alert>
        </div>
      )}
    </SidePanel>
  ) : undefined;

  return (
    <div className="stack">
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={routes.error} />
      <SplitLayout side={side}>
        <Card flush title="路由清單" extra={<span className="text-muted">不顯示外掛內的認證資訊</span>}>
          <div className="table-wrap">
            <table aria-label="Gateway 路由">
              <thead>
                <tr>
                  <th scope="col">路由</th>
                  <th scope="col">路徑</th>
                  <th scope="col">方法</th>
                  <th scope="col">上游</th>
                  <th scope="col">來源</th>
                  <th scope="col">外掛</th>
                  <th scope="col">狀態</th>
                  <th scope="col">告警門檻</th>
                </tr>
              </thead>
              <tbody>
                {routes.loading && !routes.data && (
                  <tr>
                    <td colSpan={8} role="status">
                      載入中…
                    </td>
                  </tr>
                )}
                {list.map((r, i) => (
                  <tr key={keyOf(r, i)} className={i === selectedIndex ? 'fhir-row--selected' : r.managed ? undefined : 'fhir-row--static'}>
                    <th scope="row">
                      <button
                        type="button"
                        className="fhir-link-btn"
                        aria-pressed={i === selectedIndex}
                        onClick={() => setSelectedKey(keyOf(r, i))}
                      >
                        {r.managed ? r.id : '靜態路由'}
                      </button>
                    </th>
                    <td className="fhir-code">{r.uri}</td>
                    <td>{r.methods.join(' ')}</td>
                    <td className="fhir-code">{r.upstream.join('、') || '—'}</td>
                    <td>
                      {r.managed ? (
                        '可在此修改'
                      ) : (
                        <span className="fhir-lock">
                          <Icon name="lock" />
                          部署設定檔
                        </span>
                      )}
                    </td>
                    <td>{r.plugins.join('、') || '—'}</td>
                    <td>
                      <StatusDot tone={r.enabled ? 'success' : 'neutral'}>{r.enabled ? '啟用' : '停用'}</StatusDot>
                    </td>
                    <td>{r.alert_threshold_per_minute ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </SplitLayout>
    </div>
  );
}
