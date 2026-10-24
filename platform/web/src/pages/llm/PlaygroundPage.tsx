import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useUnsavedChanges } from '../../components/unsaved';
import { Alert, ApiErrorAlert, Card, Icon, SegmentedTabs, SidePanel, SlideOver, SplitLayout, tabPanelId } from '../../components/ui';
import { PARAM_FIELDS, isRetryable, type ChatMessage, type GenerationParams, type KnowledgeBase, type LlmApi, type PromptTemplate } from './api';
import { LlmHeader } from './LlmLayout';
import { DocumentList, DocumentUpload, FileBadge, fmtDateTime } from './parts';
import { useLlm } from './useLlm';

type Mode = 'free' | 'kb';

interface Turn {
  key: number;
  role: 'user' | 'assistant';
  content: string;
  sources: ChatMessage['sources'];
  at: Date;
  seconds?: number;
}

const MODES: { key: Mode; label: string }[] = [
  { key: 'free', label: '一般問答' },
  { key: 'kb', label: '文件問答' },
];

/** 同一份文件的同一段只列一次 */
export function uniqueSources(sources: ChatMessage['sources']): ChatMessage['sources'] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const k = `${s.document_id}:${s.chunk_index}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 回答設定的資料：放在頁面層，關掉面板再打開，未儲存的修改還在，離開時也會提醒。 */
function useParamsDraft(llm: LlmApi | null) {
  const res = useResource(() => llm!.getParams(), [llm]);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useUnsavedChanges(dirty, '回答設定還沒儲存。');
  const set = (key: keyof GenerationParams, value: string | number) => {
    if (!res.data) return;
    setSavedAt(null);
    setDirty(true);
    res.setData({ ...res.data, [key]: value });
  };
  async function save() {
    if (!res.data) return;
    setBusy(true);
    setSaveError(null);
    try {
      res.setData(await llm!.putParams(res.data));
      setSavedAt(new Date());
      setDirty(false);
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  }
  return { data: res.data, error: res.error, set, save, dirty, savedAt, saveError, busy };
}

type ParamsDraft = ReturnType<typeof useParamsDraft>;

/** 右側「回答設定」：六個生成參數＋System Prompt＋儲存設定（設計稿 B14）。 */
function ParamsForm({ draft }: { draft: ParamsDraft }) {
  const { data, error, set, save, savedAt, saveError, busy } = draft;
  if (error) return <ApiErrorAlert error={error} />;
  if (!data) return <p role="status" className="loading">載入回答設定…</p>;
  return (
    <form
      aria-label="生成參數"
      className="llm-params"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <ApiErrorAlert error={saveError} />
      {savedAt && (
        <Alert tone="success">
          已儲存生成參數（{String(savedAt.getHours()).padStart(2, '0')}:{String(savedAt.getMinutes()).padStart(2, '0')}）
        </Alert>
      )}
      {PARAM_FIELDS.map((f) => (
        <div className="llm-params__row" key={f.key}>
          <div>
            <label htmlFor={`param-${f.key}`} className="llm-params__label">
              {f.label}
            </label>
            <p id={`param-${f.key}-hint`} className="llm-params__hint">
              {f.hint}
            </p>
          </div>
          <input
            id={`param-${f.key}`}
            className="input llm-params__input"
            type="number"
            min={f.min}
            max={f.max}
            step={f.step}
            value={data[f.key]}
            aria-describedby={`param-${f.key}-hint`}
            onChange={(e) => set(f.key, Number(e.target.value))}
          />
        </div>
      ))}
      <div className="llm-params__system">
        <label htmlFor="param-system" className="llm-params__label">
          System Prompt
        </label>
        <p id="param-system-hint" className="llm-params__hint">
          設定模型的角色與回答方式。發布內部服務時也會帶入這一組設定。
        </p>
        <textarea id="param-system" className="input" rows={4} aria-describedby="param-system-hint" value={data.system_prompt} onChange={(e) => set('system_prompt', e.target.value)} />
      </div>
      <button type="submit" className="btn btn--primary llm-block-btn" disabled={busy}>
        儲存設定
      </button>
    </form>
  );
}

/** 左側「問答範本」：個人／共用、搜尋與 tag，點一下套用（設計稿 B14）。 */
function PromptPicker({ prompts, value, onChange }: { prompts: PromptTemplate[]; value: number | null; onChange: (id: number | null) => void }) {
  const [scope, setScope] = useState<'personal' | 'public'>('personal');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const inScope = prompts.filter((p) => p.visibility === scope);
  const tags = [...new Set(inScope.flatMap((p) => p.tags))];
  const shown = inScope.filter(
    (p) => (!tag || p.tags.includes(tag)) && (!q || p.title.includes(q) || p.content.includes(q) || p.tags.some((t) => t.includes(q))),
  );
  return (
    <Card
      title="問答範本"
      className="llm-chat__side"
      extra={
        <Link to="/llm/prompts" className="btn btn--small btn--secondary">
          ＋ 新增
        </Link>
      }
    >
      <SegmentedTabs
        label="範本範圍"
        idPrefix="chat-prompt-scope"
        items={[
          { key: 'personal', label: '個人範本' },
          { key: 'public', label: '共用範本' },
        ]}
        value={scope}
        onChange={(k) => {
          setScope(k);
          setTag('');
        }}
      />
      <div role="tabpanel" id={tabPanelId('chat-prompt-scope', scope)} aria-labelledby={`chat-prompt-scope-${scope}-tab`} className="llm-picker">
        <label htmlFor="chat-prompt-q" className="visually-hidden">
          搜尋範本
        </label>
        <input id="chat-prompt-q" className="input" type="search" placeholder="搜尋標題、內容或 tag" value={q} onChange={(e) => setQ(e.target.value)} />
        {tags.length > 0 && (
          <div className="llm-tags" aria-label="依 tag 篩選" role="group">
            {tags.map((t) => (
              <button key={t} type="button" className="llm-tag" aria-pressed={tag === t} onClick={() => setTag(tag === t ? '' : t)}>
                {t}
              </button>
            ))}
          </div>
        )}
        {shown.length === 0 ? (
          <p className="text-muted">{inScope.length === 0 ? (scope === 'personal' ? '還沒有個人範本。' : '還沒有共用範本。') : '沒有符合的範本。'}</p>
        ) : (
          <ul aria-label="範本清單" className="llm-picker__list">
            {shown.map((p) => (
              <li key={p.id}>
                <button type="button" className="llm-picker__item" aria-pressed={value === p.id} title={p.content} onClick={() => onChange(value === p.id ? null : p.id)}>
                  <Icon name="chat" />
                  <span>{p.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** 左側「參考文件」：選文件集、看文件與狀態、加入文件（設計稿 A08）。 */
function DocsPanel({ llm, kbs, kbId, onKb, reloadKbs }: { llm: LlmApi; kbs: KnowledgeBase[]; kbId: number | null; onKb: (id: number | null) => void; reloadKbs: () => void }) {
  const docs = useResource(() => (kbId ? llm.documents(kbId) : Promise.resolve([])), [llm, kbId]);
  const [adding, setAdding] = useState(false);
  // 外觀同 Card，但不用 aria-labelledby：標題「參考文件」只留給下拉選單當名稱（e2e 以「參考文件」找這個下拉）
  return (
    <div className="ui-card llm-chat__side">
      <div className="ui-card__head">
        <h2 className="ui-card__title">參考文件</h2>
        <div className="ui-card__extra">
          <button type="button" className="btn btn--small btn--secondary" disabled={kbId === null} onClick={() => setAdding(true)}>
            <Icon name="upload" /> 加入文件
          </button>
        </div>
      </div>
      <div className="ui-card__body">
      <div className="field">
        <label htmlFor="chat-kb" className="visually-hidden">
          參考文件
        </label>
        <select id="chat-kb" className="select" value={kbId ?? ''} onChange={(e) => onKb(e.target.value ? Number(e.target.value) : null)}>
          <option value="">請選擇文件集</option>
          {kbs.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}（{k.documents} 份文件）
            </option>
          ))}
        </select>
      </div>
      {kbs.length === 0 && (
        <p className="text-muted">
          還沒有文件集，請到 <Link to="/llm/docs">參考文件</Link> 建立。
        </p>
      )}
      <ApiErrorAlert error={docs.error} />
      {kbId !== null && docs.data && (
        <DocumentList
          llm={llm}
          kbId={kbId}
          docs={docs.data}
          onChanged={() => {
            docs.reload();
            reloadKbs();
          }}
        />
      )}
      <SlideOver open={adding && kbId !== null} title="加入文件" onClose={() => setAdding(false)}>
        {kbId !== null && (
          <DocumentUpload
            llm={llm}
            kbId={kbId}
            idPrefix="chat-kb"
            onUploaded={() => {
              docs.reload();
              reloadKbs();
            }}
          />
        )}
      </SlideOver>
      </div>
    </div>
  );
}

function SourceCards({ sources }: { sources: ChatMessage['sources'] }) {
  const list = uniqueSources(sources);
  if (list.length === 0) return null;
  return (
    <div className="llm-sources">
      <p className="llm-sources__title">參考來源：</p>
      <ul aria-label="參考來源" className="llm-sources__list">
        {list.map((s) => (
          <li key={`${s.document_id}:${s.chunk_index}`} className="llm-source" title={s.content || undefined}>
            <FileBadge name={s.filename} />
            <span className="llm-source__text">
              <span className="llm-source__name">
                {s.filename} · 段落 {s.chunk_index + 1}
              </span>
              {s.content && <span className="llm-source__excerpt">{s.content}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PlaygroundPage() {
  const { llm } = useLlm();
  const kbs = useResource(() => llm!.knowledgeBases(), [llm]);
  const prompts = useResource(() => llm!.prompts(), [llm]);
  const params = useParamsDraft(llm);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('free');
  const [kbId, setKbId] = useState<number | null>(null);
  const [promptId, setPromptId] = useState<number | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ message: string; error: unknown } | null>(null);
  const nextKey = useRef(1);
  const logEnd = useRef<HTMLDivElement | null>(null);
  const prompt = useMemo(() => (prompts.data ?? []).find((p) => p.id === promptId) ?? null, [prompts.data, promptId]);

  useEffect(() => {
    logEnd.current?.scrollIntoView?.({ block: 'nearest' });
  }, [turns, pending, failed]);

  function newConversation(nextMode: Mode, nextKb: number | null) {
    setMode(nextMode);
    setKbId(nextKb);
    setSessionId(null);
    setTurns([]);
    setFailed(null);
  }

  async function send(message: string) {
    if (!llm || !message.trim() || pending !== null) return;
    setFailed(null);
    setPending(message);
    const asked = new Date();
    const started = performance.now();
    try {
      const reply = await llm.chat({ mode, message, kb_id: mode === 'kb' ? kbId : null, session_id: sessionId, prompt_id: promptId });
      const seconds = (performance.now() - started) / 1000;
      setSessionId(reply.session_id);
      setTurns((t) => [
        ...t,
        { key: nextKey.current++, role: 'user', content: message, sources: [], at: asked },
        { key: nextKey.current++, role: 'assistant', content: reply.message.content, sources: reply.message.sources, at: new Date(), seconds },
      ]);
    } catch (error) {
      // 失敗的訊息留在畫面上，按「重試」重送；輸入框立刻可以再用
      setFailed({ message, error });
    } finally {
      setPending(null);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setDraft('');
    void send(message);
  }

  const needsKb = mode === 'kb' && kbId === null;

  const settings = settingsOpen ? (
    <div data-testid="chat-settings" id="chat-settings">
      <SidePanel title="回答設定" onClose={() => setSettingsOpen(false)}>
        <p className="field__hint">模型的載入、量化與資源在「模型」分頁設定。</p>
        <ParamsForm draft={params} />
      </SidePanel>
    </div>
  ) : undefined;

  return (
    <>
      <LlmHeader
        title="文件問答"
        subtitle="選好參考文件，再問需要查證的內容；不需要文件時用一般問答。"
        actions={
          <>
            <button type="button" className="btn btn--secondary" aria-expanded={settingsOpen} aria-controls="chat-settings" onClick={() => setSettingsOpen((o) => !o)}>
              <Icon name="gear" /> 設定
            </button>
            <Link to="/llm/services" className="btn btn--secondary">
              發布內部服務
            </Link>
          </>
        }
      />
      <SplitLayout side={settings}>
        <SegmentedTabs label="問答模式" idPrefix="chat-mode" items={MODES} value={mode} onChange={(m) => newConversation(m, kbId)} />
        <div role="tabpanel" id={tabPanelId('chat-mode', mode)} aria-labelledby={`chat-mode-${mode}-tab`} className="llm-chat">
          {mode === 'free' ? (
            <PromptPicker prompts={prompts.data ?? []} value={promptId} onChange={setPromptId} />
          ) : (
            llm && <DocsPanel llm={llm} kbs={kbs.data ?? []} kbId={kbId} onKb={(id) => newConversation('kb', id)} reloadKbs={kbs.reload} />
          )}

          <section className="llm-chat__main" aria-labelledby="chat-title">
            <h2 id="chat-title" className="visually-hidden">
              對話測試
            </h2>
            <ApiErrorAlert error={kbs.error ?? prompts.error} />
            {turns.length === 0 && pending === null && (
              <p className="chat-log__empty">
                {mode === 'kb' ? '先在左側選擇文件集，再輸入想查證的內容。回答會附上參考來源。' : '輸入問題，或從左側選一個問答範本套用。'}
              </p>
            )}
            <ol className="chat-log" aria-label="對話內容" aria-live="polite">
              {turns.map((t) => (
                <li key={t.key} className={`chat-log__turn chat-log__turn--${t.role}`} data-role={t.role}>
                  <span className="chat-log__avatar" aria-hidden="true">
                    <Icon name={t.role === 'user' ? 'user' : mode === 'kb' ? 'doc' : 'chat'} />
                  </span>
                  <div className="chat-log__body">
                    <div className="chat-log__bubble">
                      <span className="visually-hidden">{t.role === 'user' ? '你：' : '模型：'}</span>
                      <p>{t.content}</p>
                      {t.role === 'assistant' && <SourceCards sources={t.sources} />}
                    </div>
                    <p className="chat-log__meta">
                      {fmtDateTime(t.at)}
                      {t.seconds !== undefined && ` · 回應時間 ${t.seconds.toFixed(1)} 秒`}
                    </p>
                  </div>
                </li>
              ))}
              {pending !== null && (
                <li className="chat-log__turn chat-log__turn--user" data-role="pending">
                  <span className="chat-log__avatar" aria-hidden="true">
                    <Icon name="user" />
                  </span>
                  <div className="chat-log__body">
                    <div className="chat-log__bubble">
                      <p>{pending}</p>
                    </div>
                    <p role="status" className="chat-log__meta">
                      模型回應中…
                    </p>
                  </div>
                </li>
              )}
            </ol>
            <div ref={logEnd} />

            {failed && (
              <div className="stack llm-chat__failed" data-testid="chat-failed">
                <Alert tone="error" title={isRetryable(failed.error) ? '模型沒有回應' : '送出失敗'}>
                  {failed.error instanceof Error ? failed.error.message : String(failed.error)}
                  {isRetryable(failed.error) && '。你的訊息還沒送出，可以直接重試。'}
                </Alert>
                <div className="row-actions">
                  <button type="button" className="btn btn--primary" onClick={() => void send(failed.message)}>
                    重試
                  </button>
                  <button type="button" className="btn btn--secondary" onClick={() => setFailed(null)}>
                    取消
                  </button>
                </div>
              </div>
            )}

            <form aria-label="送出訊息" className="llm-composer" onSubmit={submit}>
              {needsKb && <Alert tone="info">請先選擇參考文件。</Alert>}
              {prompt && (
                <p className="llm-composer__prompt">
                  使用範本：<strong>{prompt.title}</strong>
                  <button type="button" className="btn btn--ghost btn--small" onClick={() => setPromptId(null)}>
                    不使用範本
                  </button>
                </p>
              )}
              <div className="llm-composer__row">
                <label htmlFor="chat-input" className="visually-hidden">
                  訊息
                </label>
                <textarea
                  id="chat-input"
                  className="input"
                  rows={2}
                  placeholder={mode === 'kb' ? '輸入想查證的內容…' : '輸入問題，或從左側選擇範本…'}
                  aria-describedby="chat-input-hint"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  disabled={pending !== null}
                />
                <button type="submit" className="btn btn--primary llm-composer__send" aria-label="送出" disabled={pending !== null || needsKb || !draft.trim()}>
                  <Icon name="arrow" />
                </button>
              </div>
              <div className="llm-composer__foot">
                <p id="chat-input-hint" className="field__hint">
                  Enter 送出，Shift + Enter 換行。
                </p>
                <button type="button" className="btn btn--ghost btn--small" onClick={() => newConversation(mode, kbId)} disabled={pending !== null}>
                  開新對話
                </button>
              </div>
            </form>
          </section>
        </div>
      </SplitLayout>
    </>
  );
}
