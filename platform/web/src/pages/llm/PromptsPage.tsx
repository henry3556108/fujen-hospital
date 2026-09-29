import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { useLlm } from './useLlm';

export function PromptsPage() {
  const { llm } = useLlm();
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const list = useResource(() => llm!.prompts(applied), [llm, applied]);
  const [form, setForm] = useState({ title: '', content: '', tags: '', visibility: 'personal' as 'personal' | 'public' });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState('');

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const tags = form.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      const p = await llm!.createPrompt({ ...form, tags });
      setDone(`已新增 Prompt「${p.title}」`);
      setForm({ title: '', content: '', tags: '', visibility: 'personal' });
      list.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      <form role="search" aria-label="搜尋 Prompt" className="card section row-actions" onSubmit={(e) => { e.preventDefault(); setApplied(query); }}>
        <div className="field">
          <label htmlFor="prompt-q">搜尋（標題、內容、tag）</label>
          <input id="prompt-q" className="input" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="submit" className="btn btn--secondary">搜尋</button>
      </form>
      <ApiErrorAlert error={list.error} />
      <div className="table-wrap section">
        <table aria-label="Prompt 範本">
          <thead><tr><th>標題</th><th>tag</th><th>可見範圍</th><th>建立者</th><th>操作</th></tr></thead>
          <tbody>
            {(list.data ?? []).map((p) => (
              <tr key={p.id}>
                <th scope="row">{p.title}</th><td>{p.tags.join('、')}</td><td>{p.visibility === 'public' ? '公開' : '個人'}</td><td>{p.owner}</td>
                <td><button type="button" className="btn btn--small btn--danger" onClick={() => void llm!.deletePrompt(p.id).then(list.reload, setError)}>刪除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form aria-label="新增 Prompt" className="card section" onSubmit={create} noValidate>
        <h2>新增 Prompt</h2>
        {done && <Alert tone="success">{done}</Alert>}
        <ApiErrorAlert error={error} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="prompt-title">標題（必填）</label>
            <input id="prompt-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
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
        </div>
        <div className="field">
          <label htmlFor="prompt-content">內容（必填，可用 {'{input}'} 代表使用者輸入）</label>
          <textarea id="prompt-content" className="input" rows={4} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
        </div>
        <button type="submit" className="btn btn--primary">新增 Prompt</button>
      </form>
    </>
  );
}
