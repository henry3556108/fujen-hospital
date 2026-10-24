import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { useUserLookup } from '../../api/userLookup';
import { UserPicker } from '../../components/UserPicker';
import { Alert, ApiErrorAlert, Badge, Card, EmptyState, InfoList, SidePanel, SplitLayout } from '../../components/ui';
import { PARAM_FIELDS } from './api';
import { LlmHeader } from './LlmLayout';
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

  const kbName = (id: number | null) => (id === null ? '不使用' : (kbs.data ?? []).find((k) => k.id === id)?.name ?? `#${id}`);

  const side = (
    <SidePanel title="發布為內部服務">
      <form aria-label="發布為內部服務" className="stack" onSubmit={publish} noValidate>
        <p className="text-muted">發布時使用你目前的回答設定。只有授權名單內的帳號可以經 Gateway 呼叫。</p>
        {done && <Alert tone="success">{done}</Alert>}
        <ApiErrorAlert error={error} />
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
            {(kbs.data ?? []).map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="svc-grants">授權帳號（以逗號分隔）</label>
          <UserPicker id="svc-grants" value={form.grants} lookup={lookup} onChange={(grants) => setForm({ ...form, grants })} />
        </div>
        <h3 className="llm-subhead">發布內容摘要</h3>
        <PublishSummary
          model={(catalog.data ?? []).filter((m) => m.loaded).map((m) => m.name).join('、') || '（目前沒有載入的模型）'}
          docs={(kbs.data ?? []).find((k) => String(k.id) === form.kb)?.name ?? '不使用'}
          rules={params.data?.system_prompt ?? ''}
          params={params.data ? PARAM_FIELDS.map((f) => `${f.label} ${params.data![f.key]}`).join('、') : '—'}
          grants={form.grants.split(/[,，\s]+/).filter(Boolean)}
        />
        <button type="submit" className="btn btn--primary llm-block-btn">
          發布
        </button>
      </form>
    </SidePanel>
  );

  return (
    <>
      <LlmHeader title="文件問答" subtitle="把目前的模型、參考文件與回答設定發布成院內服務，只開放給指定帳號呼叫。" />
      <div className="llm-stretch">
        <SplitLayout side={side}>
          <ApiErrorAlert error={services.error} />
          <Card title="已發布的服務" flush>
            {services.data && services.data.length === 0 ? (
              <EmptyState icon="server" title="還沒有發布的服務" description="在右側填好服務代號、名稱與授權帳號後按「發布」。" />
            ) : (
              <div className="table-wrap">
                <table aria-label="已發布的服務">
                  <thead>
                    <tr>
                      <th>名稱</th>
                      <th>端點</th>
                      <th>參考文件</th>
                      <th>授權帳號</th>
                      <th>狀態</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(services.data ?? []).map((s) => (
                      <tr key={s.id}>
                        <th scope="row">{s.name}</th>
                        <td>
                          <code>{s.endpoint}</code>
                        </td>
                        <td>{kbName(s.kb_id)}</td>
                        <td>{s.grants.join('、') || '（無）'}</td>
                        <td>
                          <Badge tone={s.enabled ? 'success' : 'neutral'}>{s.enabled ? '啟用' : '停用'}</Badge>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button type="button" className="btn btn--small btn--secondary" onClick={() => void llm!.setEnabled(s.id, !s.enabled).then(services.reload, setError)}>
                              {s.enabled ? '停用' : '啟用'}
                            </button>
                            <button type="button" className="btn btn--small btn--danger" onClick={() => void llm!.unpublish(s.id).then(services.reload, setError)}>
                              取消發布
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </SplitLayout>
      </div>
    </>
  );
}

/** 發布前的摘要：這次會用的模型、參考文件、回答規則、生成參數與授權對象，避免發布到另一組設定。 */
export function PublishSummary({ model, docs, rules, params, grants }: { model: string; docs: string; rules: string; params: string; grants: string[] }) {
  return (
    <div data-testid="publish-summary" aria-label="發布內容摘要" role="group">
      <InfoList
        items={[
          { label: '模型', value: model },
          { label: '參考文件', value: docs },
          { label: '回答規則（System Prompt）', value: rules || '（沒有設定）' },
          { label: '生成參數', value: params },
          { label: '授權對象', value: grants.length ? grants.join('、') : '（還沒有指定）' },
        ]}
      />
    </div>
  );
}
