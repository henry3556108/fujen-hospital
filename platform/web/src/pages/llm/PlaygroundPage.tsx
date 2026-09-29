import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { PARAM_FIELDS, isRetryable, type ChatMessage, type GenerationParams } from './api';
import { useLlm } from './useLlm';

type Mode = 'free' | 'kb';

interface Turn {
  key: number;
  role: 'user' | 'assistant';
  content: string;
  sources: ChatMessage['sources'];
  seconds?: number;
}

function ParamsForm() {
  const { llm } = useLlm();
  const { data, error, setData } = useResource(() => llm!.getParams(), [llm]);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  if (error) return <ApiErrorAlert error={error} />;
  if (!data) return <p role="status" className="loading">載入生成參數…</p>;

  const set = (key: keyof GenerationParams, value: string | number) => {
    setSaved(false);
    setData({ ...data, [key]: value });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSaveError(null);
    try {
      setData(await llm!.putParams(data!));
      setSaved(true);
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="生成參數" className="card section" onSubmit={submit} noValidate>
      <h2>生成參數</h2>
      <ApiErrorAlert error={saveError} />
      {saved && <Alert tone="success">已儲存生成參數</Alert>}
      <div className="form-grid">
        {PARAM_FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`param-${f.key}`}>{f.label}</label>
            <input
              id={`param-${f.key}`}
              className="input"
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={data[f.key]}
              onChange={(e) => set(f.key, Number(e.target.value))}
            />
          </div>
        ))}
      </div>
      <div className="field">
        <label htmlFor="param-system">System Prompt</label>
        <textarea id="param-system" className="input" rows={3} value={data.system_prompt} onChange={(e) => set('system_prompt', e.target.value)} />
      </div>
      <button type="submit" className="btn btn--secondary" disabled={busy}>
        儲存生成參數
      </button>
    </form>
  );
}

export function PlaygroundPage() {
  const { llm } = useLlm();
  const kbs = useResource(() => llm!.knowledgeBases(), [llm]);
  const prompts = useResource(() => llm!.prompts(), [llm]);
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
    const started = performance.now();
    try {
      const reply = await llm.chat({ mode, message, kb_id: mode === 'kb' ? kbId : null, session_id: sessionId, prompt_id: promptId });
      const seconds = (performance.now() - started) / 1000;
      setSessionId(reply.session_id);
      setTurns((t) => [
        ...t,
        { key: nextKey.current++, role: 'user', content: message, sources: [] },
        { key: nextKey.current++, role: 'assistant', content: reply.message.content, sources: reply.message.sources, seconds },
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

  return (
    <>
      <section className="card section" aria-labelledby="playground-title">
        <h2 id="playground-title">Playground</h2>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="chat-mode">對話模式</label>
            <select id="chat-mode" className="select" value={mode} onChange={(e) => newConversation(e.target.value as Mode, kbId)}>
              <option value="free">Free Chat</option>
              <option value="kb">Chat with Knowledge Base</option>
            </select>
          </div>
          {mode === 'kb' && (
            <div className="field">
              <label htmlFor="chat-kb">知識庫</label>
              <select
                id="chat-kb"
                className="select"
                value={kbId ?? ''}
                onChange={(e) => newConversation('kb', e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">請選擇</option>
                {(kbs.data ?? []).map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}（{k.documents} 份文件）
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="chat-prompt">Prompt 範本</label>
            <select id="chat-prompt" className="select" value={promptId ?? ''} onChange={(e) => setPromptId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">不使用</option>
              {(prompts.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                  {p.visibility === 'personal' ? '（個人）' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <ApiErrorAlert error={kbs.error} />

        <ol className="chat-log" aria-label="對話內容" aria-live="polite">
          {turns.map((t) => (
            <li key={t.key} className={`chat-log__turn chat-log__turn--${t.role}`} data-role={t.role}>
              <strong>{t.role === 'user' ? '你' : '模型'}</strong>
              <p>{t.content}</p>
              {t.sources.length > 0 && (
                <p className="text-muted">
                  出處：{t.sources.map((s) => s.filename).filter((v, i, a) => a.indexOf(v) === i).join('、')}
                </p>
              )}
              {t.seconds !== undefined && <p className="text-muted">回應時間 {t.seconds.toFixed(1)} 秒</p>}
            </li>
          ))}
          {pending !== null && (
            <li className="chat-log__turn chat-log__turn--user" data-role="pending">
              <strong>你</strong>
              <p>{pending}</p>
              <p role="status" className="text-muted">
                模型回應中…
              </p>
            </li>
          )}
        </ol>
        <div ref={logEnd} />

        {failed && (
          <div className="stack" data-testid="chat-failed">
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

        <form aria-label="送出訊息" className="stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor="chat-input">訊息</label>
            <textarea
              id="chat-input"
              className="input"
              rows={3}
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
            <p className="field__hint">Enter 送出，Shift + Enter 換行。</p>
          </div>
          {needsKb && <Alert tone="info">請先選擇知識庫。</Alert>}
          <div className="row-actions">
            <button type="submit" className="btn btn--primary" disabled={pending !== null || needsKb || !draft.trim()}>
              送出
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => newConversation(mode, kbId)} disabled={pending !== null}>
              開新對話
            </button>
          </div>
        </form>
      </section>
      <ParamsForm />
    </>
  );
}
