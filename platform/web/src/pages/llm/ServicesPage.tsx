import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { useUserLookup } from '../../api/userLookup';
import { UserPicker } from '../../components/UserPicker';
import { PARAM_FIELDS } from './api';
import { useLlm } from './useLlm';

export function ServicesPage() {
  const { llm } = useLlm();
  const lookup = useUserLookup();
  const services = useResource(() => llm!.services(), [llm]);
  const kbs = useResource(() => llm!.knowledgeBases(), [llm]);
  const params = useResource(() => llm!.getParams(), [llm]);
  const catalog = useResource(() => llm!.catalog(), [llm]);
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
      <form aria-label="發布為內部服務" className="card section" onSubmit={publish} noValidate>
        <h2>發布為內部服務</h2>
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
            <label htmlFor="svc-kb">參考文件</label>
            <select id="svc-kb" className="select" value={form.kb} onChange={(e) => setForm({ ...form, kb: e.target.value })}>
              <option value="">不使用</option>
              {(kbs.data ?? []).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="svc-grants">授權帳號（以逗號分隔）</label>
            <UserPicker id="svc-grants" value={form.grants} lookup={lookup} onChange={(grants) => setForm({ ...form, grants })} />
          </div>
        </div>
        <PublishSummary
          model={(catalog.data ?? []).filter((m) => m.loaded).map((m) => m.name).join('、') || '（目前沒有載入的模型）'}
          docs={(kbs.data ?? []).find((k) => String(k.id) === form.kb)?.name ?? '不使用'}
          rules={params.data?.system_prompt ?? ''}
          params={params.data ? PARAM_FIELDS.map((f) => `${f.label} ${params.data![f.key]}`).join('、') : '—'}
          grants={form.grants.split(/[,，\s]+/).filter(Boolean)}
        />
        <button type="submit" className="btn btn--primary">發布</button>
      </form>
    </>
  );
}

/** 發布前的摘要：這次會用的模型、參考文件、回答規則、生成參數與授權對象，避免發布到另一組設定。 */
export function PublishSummary({ model, docs, rules, params, grants }: { model: string; docs: string; rules: string; params: string; grants: string[] }) {
  return (
    <dl className="training-facts" data-testid="publish-summary" aria-label="發布內容摘要">
      <dt>模型</dt>
      <dd>{model}</dd>
      <dt>參考文件</dt>
      <dd>{docs}</dd>
      <dt>回答規則（範本）</dt>
      <dd>{rules || '（沒有設定）'}</dd>
      <dt>生成參數</dt>
      <dd>{params}</dd>
      <dt>授權對象</dt>
      <dd>{grants.length ? grants.join('、') : '（還沒有指定）'}</dd>
    </dl>
  );
}
