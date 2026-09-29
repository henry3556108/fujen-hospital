import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import type { WikiAnswer, WikiPage as Page, WikiPageSummary } from './api';
import { useLlm } from './useLlm';

export function WikiPage() {
  const { llm } = useLlm();
  const pages = useResource(() => llm!.wikiPages(), [llm]);
  const [open, setOpen] = useState<Page | null>(null);
  const [draft, setDraft] = useState({ path: '', title: '', content: '' });
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<WikiPageSummary[] | null>(null);
  const [history, setHistory] = useState<{ version_id: number; date: string }[]>([]);
  const [old, setOld] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<WikiAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function guard(work: () => Promise<void>) {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err);
    }
  }

  const select = (id: number) =>
    guard(async () => {
      const page = await llm!.wikiPage(id);
      setOpen(page);
      setDraft({ path: page.path, title: page.title, content: page.content });
      setHistory(await llm!.wikiHistory(id));
      setOld(null);
      setAnswer(null);
    });

  function save(e: FormEvent) {
    e.preventDefault();
    void guard(async () => {
      const page = open ? await llm!.updateWikiPage(open.id, draft) : await llm!.createWikiPage(draft);
      pages.reload();
      await select(page.id);
    });
  }

  return (
    <>
      <ApiErrorAlert error={pages.error ?? error} />
      <form role="search" aria-label="Wiki 全文檢索" className="card section row-actions" onSubmit={(e) => { e.preventDefault(); void guard(async () => setHits(await llm!.wikiSearch(query))); }}>
        <div className="field">
          <label htmlFor="wiki-q">全文檢索</label>
          <input id="wiki-q" className="input" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="submit" className="btn btn--secondary">檢索</button>
      </form>
      {hits && (
        <ul aria-label="檢索結果" className="section">
          {hits.length === 0 && <li>找不到符合的頁面</li>}
          {hits.map((h) => <li key={h.id}><button type="button" className="btn btn--ghost btn--small" onClick={() => void select(h.id)}>{h.title}（{h.path}）</button></li>)}
        </ul>
      )}
      <section className="card section" aria-labelledby="wiki-pages-title">
        <h2 id="wiki-pages-title">頁面</h2>
        <ul>
          {(pages.data ?? []).map((p) => <li key={p.id}><button type="button" className="btn btn--ghost btn--small" onClick={() => void select(p.id)}>{p.title}（{p.path}）</button></li>)}
        </ul>
        <button type="button" className="btn btn--secondary" onClick={() => { setOpen(null); setDraft({ path: '', title: '', content: '' }); setHistory([]); }}>新增頁面</button>
      </section>
      <form aria-label={open ? '編輯頁面' : '新增頁面'} className="card section" onSubmit={save}>
        <h2>{open ? `編輯：${open.title}` : '新增頁面'}</h2>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="wiki-path">路徑</label>
            <input id="wiki-path" className="input" value={draft.path} disabled={!!open} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="wiki-title">標題</label>
            <input id="wiki-title" className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="wiki-content">內容（Markdown）</label>
          <textarea id="wiki-content" className="input" rows={8} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
        </div>
        <button type="submit" className="btn btn--primary">儲存</button>
      </form>
      {open && (
        <>
          <section className="card section" aria-labelledby="wiki-history-title">
            <h2 id="wiki-history-title">版本紀錄</h2>
            {history.length === 0 ? <p className="text-muted">還沒有舊版本</p> : (
              <ul>
                {history.map((v) => (
                  <li key={v.version_id}>
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => void guard(async () => setOld((await llm!.wikiVersion(open.id, v.version_id)).content))}>
                      版本 {v.version_id}（{v.date}）
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {old !== null && <pre className="llm-pre" aria-label="舊版內容">{old}</pre>}
          </section>
          <form aria-label="以這頁問 LLM" className="card section" onSubmit={(e) => { e.preventDefault(); void guard(async () => setAnswer(await llm!.wikiAsk(question, open.id))); }}>
            <h2>以這頁問 LLM</h2>
            <p className="text-muted">平台經 Wiki API 取回這一頁交給模型，不經過向量檢索。</p>
            <div className="field">
              <label htmlFor="wiki-question">問題</label>
              <input id="wiki-question" className="input" value={question} onChange={(e) => setQuestion(e.target.value)} />
            </div>
            <button type="submit" className="btn btn--primary" disabled={!question.trim()}>送出</button>
            {answer && <Alert tone="info" title={`回答（脈絡來源 ${answer.context_source}）`}>{answer.answer}</Alert>}
          </form>
        </>
      )}
    </>
  );
}
