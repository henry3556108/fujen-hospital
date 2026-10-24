import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert, Badge, Card, ConfirmDialog, SegmentedTabs, SidePanel, SplitLayout, tabPanelId } from '../../components/ui';
import type { PromptTemplate } from './api';
import { LlmHeader } from './LlmLayout';
import { useLlm } from './useLlm';

type Scope = 'all' | 'personal' | 'public';

export function PromptsPage() {
  const { llm } = useLlm();
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [tag, setTag] = useState('');
  const list = useResource(() => llm!.prompts(applied), [llm, applied]);
  const [form, setForm] = useState({ title: '', content: '', tags: '', visibility: 'personal' as 'personal' | 'public' });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState('');
  const [removing, setRemoving] = useState<PromptTemplate | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const tags = form.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      const p = await llm!.createPrompt({ ...form, tags });
      setDone(`已新增問答範本「${p.title}」`);
      setForm({ title: '', content: '', tags: '', visibility: 'personal' });
      list.reload();
    } catch (err) {
      setError(err);
    }
  }

  async function remove() {
    if (!removing) return;
    try {
      await llm!.deletePrompt(removing.id);
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setRemoving(null);
    }
  }

  const all = list.data ?? [];
  const inScope = all.filter((p) => scope === 'all' || p.visibility === scope);
  const tags = [...new Set(inScope.flatMap((p) => p.tags))];
  const shown = inScope.filter((p) => !tag || p.tags.includes(tag));

  const side = (
    <SidePanel title="新增問答範本">
      <form aria-label="新增問答範本" className="stack" onSubmit={create} noValidate>
        {done && <Alert tone="success">{done}</Alert>}
        <ApiErrorAlert error={error} />
        <div className="field">
          <label htmlFor="prompt-title">標題（必填）</label>
          <input id="prompt-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="prompt-content">內容（必填，可用 {'{input}'} 代表使用者輸入）</label>
          <textarea id="prompt-content" className="input" rows={6} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="prompt-tags">tag（以逗號分隔）</label>
          <input id="prompt-tags" className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="prompt-visibility">可見範圍</label>
          <select id="prompt-visibility" className="select" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as 'personal' | 'public' })}>
            <option value="personal">個人（只有自己看得到）</option>
            <option value="public">公開（專案成員都看得到）</option>
          </select>
        </div>
        <button type="submit" className="btn btn--primary llm-block-btn">
          新增問答範本
        </button>
      </form>
    </SidePanel>
  );

  return (
    <>
      <LlmHeader title="文件問答" subtitle="常用的提問方式存成範本，對話時從左側點選套用。個人範本只有自己看得到，共用範本專案成員都看得到。" />
      <div className="llm-stretch">
        <SplitLayout side={side}>
          <Card title="問答範本" flush>
            <div className="llm-toolbar">
              <SegmentedTabs
                label="範本範圍"
                idPrefix="prompt-scope"
                items={[
                  { key: 'all', label: '全部' },
                  { key: 'personal', label: '個人範本' },
                  { key: 'public', label: '共用範本' },
                ]}
                value={scope}
                onChange={(k) => {
                  setScope(k);
                  setTag('');
                }}
              />
              <form
                role="search"
                aria-label="搜尋問答範本"
                className="llm-inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  setApplied(query);
                }}
              >
                <div className="field">
                  <label htmlFor="prompt-q">搜尋（標題、內容、tag）</label>
                  <input id="prompt-q" className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <button type="submit" className="btn btn--secondary">
                  搜尋
                </button>
              </form>
              {tags.length > 0 && (
                <div className="llm-tags" role="group" aria-label="依 tag 篩選">
                  {tags.map((t) => (
                    <button key={t} type="button" className="llm-tag" aria-pressed={tag === t} onClick={() => setTag(tag === t ? '' : t)}>
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ApiErrorAlert error={list.error} />
            <div role="tabpanel" id={tabPanelId('prompt-scope', scope)} aria-labelledby={`prompt-scope-${scope}-tab`} className="table-wrap">
              <table aria-label="問答範本">
                <thead>
                  <tr>
                    <th>標題</th>
                    <th>tag</th>
                    <th>可見範圍</th>
                    <th>建立者</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id}>
                      <th scope="row" title={p.content}>
                        {p.title}
                      </th>
                      <td>
                        <span className="llm-tags llm-tags--inline">
                          {p.tags.map((t) => (
                            <span key={t} className="llm-tag llm-tag--static">
                              {t}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td>
                        <Badge tone={p.visibility === 'public' ? 'info' : 'neutral'}>{p.visibility === 'public' ? '共用' : '個人'}</Badge>
                      </td>
                      <td>{p.owner}</td>
                      <td>
                        <button type="button" className="btn btn--small btn--danger" onClick={() => setRemoving(p)}>
                          刪除
                        </button>
                      </td>
                    </tr>
                  ))}
                  {list.data && shown.length === 0 && (
                    <tr>
                      <td colSpan={5} className="llm-empty-row">
                        沒有符合的範本。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </SplitLayout>
      </div>
      {removing && (
        <ConfirmDialog title="刪除問答範本" confirmLabel="刪除" onConfirm={() => void remove()} onCancel={() => setRemoving(null)}>
          確定刪除「{removing.title}」？刪除後無法復原。
        </ConfirmDialog>
      )}
    </>
  );
}
