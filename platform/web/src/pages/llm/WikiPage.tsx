import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert, Card, Icon, SegmentedTabs, SidePanel, SlideOver, tabPanelId } from '../../components/ui';
import type { WikiAnswer, WikiPage as Page, WikiPageSummary, WikiVersion } from './api';
import { LlmHeader } from './LlmLayout';
import { MarkdownToolbar, renderMarkdown } from './markdown';
import { fmtDateTime } from './parts';
import { useLlm } from './useLlm';

const ACTION: Record<string, string> = { initial: '建立文件', edit: '修改內容', updated: '修改內容', moved: '移動頁面', move: '移動頁面' };

const EMPTY = { path: '', title: '', content: '' };

export function WikiPage() {
  const { llm } = useLlm();
  const pages = useResource(() => llm!.wikiPages(), [llm]);
  const [open, setOpen] = useState<Page | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<WikiPageSummary[] | null>(null);
  const [history, setHistory] = useState<WikiVersion[]>([]);
  const [old, setOld] = useState<{ no: number; version: WikiVersion; title: string; content: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<WikiAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState('');
  const [auto, setAuto] = useState(true);
  const editor = useRef<HTMLTextAreaElement>(null);

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
      setSaved('');
    });

  // 第一次載入時自動打開第一頁
  useEffect(() => {
    if (auto && pages.data && pages.data.length > 0 && !open) {
      setAuto(false);
      void select(pages.data[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.data]);

  function newPage() {
    setAuto(false);
    setOpen(null);
    setDraft(EMPTY);
    setHistory([]);
    setOld(null);
    setSaved('');
    setView('edit');
  }

  function save(e: FormEvent) {
    e.preventDefault();
    void guard(async () => {
      const page = open ? await llm!.updateWikiPage(open.id, { title: draft.title, content: draft.content }) : await llm!.createWikiPage(draft);
      setAuto(false);
      pages.reload();
      await select(page.id);
      setSaved(`已儲存（${fmtDateTime(new Date())}）`);
    });
  }

  // 版本：依 version_id 由舊到新編號；目前內容＝最新一版
  const ordered = [...history].sort((a, b) => a.version_id - b.version_id);
  const currentNo = ordered.length + 1;
  const shownPages = hits ?? pages.data ?? [];

  const versions = open && (
    <SidePanel title="版本紀錄">
      <ol className="llm-versions" aria-label="版本紀錄">
        <li className="llm-version llm-version--current">
          <span className="llm-version__no">
            第 {currentNo} 版<span className="llm-version__tag">（目前）</span>
          </span>
          {open.updated_at && <span className="llm-version__meta">{fmtDateTime(open.updated_at)}</span>}
          {open.updated_by && <span className="llm-version__meta">{open.updated_by}</span>}
        </li>
        {ordered
          .map((v, i) => ({ v, no: i + 1 }))
          .reverse()
          .map(({ v, no }) => (
            <li key={v.version_id}>
              <button
                type="button"
                className="llm-version"
                onClick={() =>
                  void guard(async () => {
                    const page = await llm!.wikiVersion(open.id, v.version_id);
                    setOld({ no, version: v, title: page.title, content: page.content });
                  })
                }
              >
                <span className="llm-version__no">第 {no} 版</span>
                <span className="llm-version__meta">{fmtDateTime(v.date)}</span>
                <span className="llm-version__meta">{v.author}</span>
                <span className="llm-version__action">{ACTION[v.action] ?? v.action}</span>
              </button>
            </li>
          ))}
      </ol>
      {ordered.length === 0 && <p className="text-muted">還沒有舊版本。每次儲存都會留下前一版。</p>}
      <p className="field__hint">舊版本只能查看，不能比較或還原。</p>
    </SidePanel>
  );

  return (
    <>
      <LlmHeader title="團隊文件（Wiki）" subtitle="維護研究流程、標註規則等團隊文件，可供工作流程與問答引用。" />
      <ApiErrorAlert error={pages.error ?? error} />
      <div className={`llm-wiki ${open ? 'llm-wiki--with-side' : ''}`}>
        <Card className="llm-wiki__list">
          <form
            role="search"
            aria-label="Wiki 全文檢索"
            className="llm-search"
            onSubmit={(e) => {
              e.preventDefault();
              if (!query.trim()) {
                setHits(null);
                return;
              }
              void guard(async () => setHits(await llm!.wikiSearch(query)));
            }}
          >
            <label htmlFor="wiki-q" className="visually-hidden">
              全文檢索
            </label>
            <Icon name="search" className="llm-search__icon" />
            <input id="wiki-q" className="input" type="search" placeholder="搜尋文件標題或內容…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button type="submit" className="visually-hidden">
              檢索
            </button>
          </form>
          {hits && (
            <p className="llm-filter">
              檢索結果 {hits.length} 筆
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  setHits(null);
                  setQuery('');
                }}
              >
                清除
              </button>
            </p>
          )}
          <ul aria-label={hits ? '檢索結果' : '頁面'} className="llm-wiki__pages">
            {hits && hits.length === 0 && <li className="text-muted">找不到符合的頁面</li>}
            {shownPages.map((p) => (
              <li key={p.id}>
                <button type="button" className="llm-wiki__page" aria-current={open?.id === p.id ? 'page' : undefined} title={p.path} onClick={() => void select(p.id)}>
                  <Icon name="doc" />
                  <span>{p.title}</span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn--secondary llm-block-btn" onClick={newPage}>
            ＋ 新增頁面
          </button>
        </Card>

        <Card className="llm-wiki__editor">
          <form aria-label={open ? '編輯頁面' : '新增頁面'} className="stack" onSubmit={save}>
            {saved && <Alert tone="success">{saved}</Alert>}
            <div className="llm-load-form__row">
              <label htmlFor="wiki-title">標題</label>
              <input id="wiki-title" className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <div className="llm-load-form__row">
              <label htmlFor="wiki-path">頁面路徑</label>
              <input id="wiki-path" className="input" placeholder="例：sop/visiting" value={draft.path} disabled={!!open} onChange={(e) => setDraft({ ...draft, path: e.target.value })} />
            </div>
            <SegmentedTabs
              label="編輯或預覽"
              idPrefix="wiki-view"
              value={view}
              onChange={setView}
              items={[
                { key: 'edit', label: '編輯' },
                { key: 'preview', label: '預覽' },
              ]}
            />
            <div role="tabpanel" id={tabPanelId('wiki-view', view)} aria-labelledby={`wiki-view-${view}-tab`} className="llm-md">
              {view === 'edit' ? (
                <>
                  <MarkdownToolbar target={editor} value={draft.content} onChange={(content) => setDraft({ ...draft, content })} />
                  <label htmlFor="wiki-content" className="visually-hidden">
                    內容（Markdown）
                  </label>
                  <textarea
                    id="wiki-content"
                    ref={editor}
                    className="input llm-md__editor"
                    rows={14}
                    value={draft.content}
                    onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  />
                </>
              ) : (
                <div className="llm-md__preview" aria-label="預覽內容">
                  {draft.content.trim() ? renderMarkdown(draft.content) : <p className="text-muted">還沒有內容。</p>}
                </div>
              )}
            </div>
            <div className="row-actions">
              <button type="submit" className="btn btn--primary">
                <Icon name="check" /> 儲存文件
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={!open}
                title={open ? undefined : '先儲存這一頁才能提問'}
                onClick={() => {
                  setAnswer(null);
                  setAsking(true);
                }}
              >
                <Icon name="chat" /> 以這頁提問
              </button>
            </div>
          </form>
        </Card>

        {versions}
      </div>

      <SlideOver open={old !== null} title={old ? `第 ${old.no} 版（唯讀）` : ''} onClose={() => setOld(null)}>
        {old && (
          <div className="stack">
            <p className="text-muted">
              {fmtDateTime(old.version.date)} · {old.version.author} · {old.title}
            </p>
            <pre className="llm-pre llm-old" aria-label="舊版內容">
              {old.content}
            </pre>
          </div>
        )}
      </SlideOver>

      <SlideOver open={asking && !!open} title="以這頁提問" onClose={() => setAsking(false)}>
        {open && (
          <form
            aria-label="以這頁提問"
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void guard(async () => setAnswer(await llm!.wikiAsk(question, open.id)));
            }}
          >
            <p className="text-muted">平台經 Wiki API 取回「{open.title}」交給模型，不經過向量檢索。</p>
            <div className="field">
              <label htmlFor="wiki-question">問題</label>
              <textarea id="wiki-question" className="input" rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} />
            </div>
            <button type="submit" className="btn btn--primary" disabled={!question.trim()}>
              送出
            </button>
            <ApiErrorAlert error={error} />
            {answer && (
              <Alert tone="info" title={`回答（脈絡來源 ${answer.context_source}）`}>
                {answer.answer}
              </Alert>
            )}
          </form>
        )}
      </SlideOver>
    </>
  );
}
