import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { useLlm } from './useLlm';

export function ServicesPage() {
  const { llm } = useLlm();
  const services = useResource(() => llm!.services(), [llm]);
  const kbs = useResource(() => llm!.knowledgeBases(), [llm]);
  const [form, setForm] = useState({ slug: '', name: '', kb: '', grants: '' });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState('');

  async function publish(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const s = await llm!.publish({ slug: form.slug, name: form.name, kb_id: form.kb ? Number(form.kb) : null,
        grants: form.grants.split(/[,，\s]+/).filter(Boolean) });
      setDone(`已發布「${s.name}」：POST ${s.endpoint}`);
      services.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      <ApiErrorAlert error={services.error} />
      <div className="table-wrap section">
        <table aria-label="已發布的服務">
          <thead><tr><th>名稱</th><th>端點</th><th>授權帳號</th><th>狀態</th><th>操作</th></tr></thead>
          <tbody>
            {(services.data ?? []).map((s) => (
              <tr key={s.id}>
                <th scope="row">{s.name}</th><td><code>{s.endpoint}</code></td><td>{s.grants.join('、') || '（無）'}</td>
                <td>{s.enabled ? '啟用' : '停用'}</td>
                <td className="row-actions">
                  <button type="button" className="btn btn--small btn--secondary" onClick={() => void llm!.setEnabled(s.id, !s.enabled).then(services.reload, setError)}>{s.enabled ? '停用' : '啟用'}</button>
                  <button type="button" className="btn btn--small btn--danger" onClick={() => void llm!.unpublish(s.id).then(services.reload, setError)}>取消發布</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form aria-label="發布為內部 API" className="card section" onSubmit={publish} noValidate>
        <h2>發布為內部 API</h2>
        <p className="text-muted">發布時使用你目前的生成參數。只有授權名單內的帳號可以經 Gateway 呼叫。</p>
        {done && <Alert tone="success">{done}</Alert>}
        <ApiErrorAlert error={error} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="svc-slug">服務代號（小寫英數字與 -）</label>
            <input id="svc-slug" className="input" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="svc-name">名稱</label>
            <input id="svc-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="svc-kb">知識庫</label>
            <select id="svc-kb" className="select" value={form.kb} onChange={(e) => setForm({ ...form, kb: e.target.value })}>
              <option value="">不使用</option>
              {(kbs.data ?? []).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="svc-grants">授權帳號（以逗號分隔）</label>
            <input id="svc-grants" className="input" value={form.grants} onChange={(e) => setForm({ ...form, grants: e.target.value })} />
          </div>
        </div>
        <button type="submit" className="btn btn--primary">發布</button>
      </form>
    </>
  );
}
