import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { ApiErrorAlert, Alert, Badge, Card, CodeBlock, ConfirmDialog, EmptyState, Icon, SegmentedTabs, SlideOver, tabPanelId, type BadgeTone, type IconName } from '../../components/ui';
import type { Workflow, WorkflowNode, WorkflowRun } from './api';
import { LlmHeader } from './LlmLayout';
import { fmtDateTime } from './parts';
import { useLlm } from './useLlm';

const EXAMPLE = JSON.stringify(
  {
    state: { question: '' },
    nodes: [
      { id: 'retrieve', type: 'retrieve', kb_id: 1, query: '{question}', output: 'context' },
      { id: 'draft', type: 'llm', prompt: '請回答：{question}', context: 'context', output: 'draft' },
      { id: 'final', type: 'template', template: '答覆：{draft}', output: 'answer' },
    ],
    edges: [['retrieve', 'draft'], ['draft', 'final']],
  },
  null,
  2,
);

/** 節點種類的白話名稱與圖示 */
export const NODE_KIND: Record<string, { label: string; icon: IconName }> = {
  template: { label: '套用文字範本', icon: 'doc' },
  retrieve: { label: '查參考文件', icon: 'search' },
  wiki: { label: '讀團隊文件', icon: 'doc' },
  llm: { label: '產生回答', icon: 'chat' },
  condition: { label: '條件判斷', icon: 'swap' },
};

const NODE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  succeeded: { label: '完成', tone: 'success' },
  failed: { label: '失敗', tone: 'error' },
  running: { label: '執行中', tone: 'info' },
  skipped: { label: '略過', tone: 'neutral' },
};

const nodeStatus = (s: string) => NODE_STATUS[s] ?? { label: s, tone: 'neutral' as BadgeTone };

type Definition = { state?: Record<string, unknown>; entry?: string; nodes?: WorkflowNode[]; edges?: unknown[] };

/**
 * 流程圖的方塊順序：從 entry 沿著連線走到 END；條件節點先走「符合」再走「不符合」，
 * 走不到的節點照定義順序接在後面。
 */
export function flowOrder(def: Definition): WorkflowNode[] {
  const nodes = Array.isArray(def.nodes) ? def.nodes.filter((n) => n && typeof n.id === 'string') : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const next = new Map<string, string>();
  for (const e of Array.isArray(def.edges) ? def.edges : []) {
    if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && !next.has(e[0])) next.set(e[0], e[1]);
  }
  const out: WorkflowNode[] = [];
  const seen = new Set<string>();
  const stack = [def.entry && byId.has(def.entry) ? def.entry : nodes[0]?.id].filter(Boolean) as string[];
  while (stack.length) {
    const id = stack.shift()!;
    const node = byId.get(id);
    if (!node || seen.has(id)) continue;
    seen.add(id);
    out.push(node);
    if (node.type === 'condition') stack.unshift(...[node.then, node.else].filter((x): x is string => typeof x === 'string'));
    else if (next.has(id)) stack.unshift(next.get(id)!);
  }
  for (const n of nodes) if (!seen.has(n.id)) out.push(n);
  return out;
}

/** 依 state 產生執行輸入的範例 JSON */
export function sampleInput(def: Definition): string {
  const state = def.state && typeof def.state === 'object' ? def.state : {};
  return JSON.stringify(Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v ?? ''])), null, 2);
}

function parse(text: string): Definition | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Definition) : null;
  } catch {
    return null;
  }
}

/** 節點流程圖預覽（方塊＋箭頭，唯讀；設計稿 B15） */
export function FlowChart({ def, statuses, describe }: { def: Definition; statuses?: Map<string, string>; describe?: (n: WorkflowNode) => string }) {
  const order = flowOrder(def);
  if (order.length === 0) return <p className="text-muted">定義裡還沒有節點。</p>;
  return (
    <ol className="llm-flow" aria-label="節點流程圖">
      {order.map((n, i) => {
        const kind = NODE_KIND[n.type] ?? { label: n.type, icon: 'cube' as IconName };
        const status = statuses?.get(n.id);
        return (
          <li key={n.id} className="llm-flow__step">
            {i > 0 && <span className="llm-flow__arrow" aria-hidden="true" />}
            <div className={`llm-flow__node llm-flow__node--${n.type} ${status === 'failed' ? 'llm-flow__node--failed' : ''}`}>
              <span className="llm-flow__icon" aria-hidden="true">
                <Icon name={kind.icon} />
              </span>
              <span className="llm-flow__text">
                <span className="llm-flow__title">{n.id}</span>
                <span className="llm-flow__kind">
                  {kind.label}
                  {describe?.(n) ? `：${describe(n)}` : ''}
                </span>
                {n.type === 'condition' && (
                  <span className="llm-flow__branch">
                    符合 → {String(n.then ?? '—')}；不符合 → {String(n.else ?? '—')}
                  </span>
                )}
              </span>
              {status && <Badge tone={nodeStatus(status).tone}>{nodeStatus(status).label}</Badge>}
            </div>
          </li>
        );
      })}
      <li className="llm-flow__step">
        <span className="llm-flow__arrow" aria-hidden="true" />
        <span className="llm-flow__end">結束</span>
      </li>
    </ol>
  );
}

/** 最終回答：最後一個節點的輸出欄位；找不到就列出整個 state */
function finalAnswer(run: WorkflowRun, def: Definition): string | null {
  const last = run.nodes?.[run.nodes.length - 1];
  const node = last && def.nodes?.find((n) => n.id === last.node);
  const key = node && typeof node.output === 'string' ? node.output : null;
  const value = key ? run.final_state?.[key] : undefined;
  if (typeof value === 'string') return value;
  if (value !== undefined) return JSON.stringify(value, null, 2);
  return null;
}

function RunSummary({ run, def }: { run: WorkflowRun; def: Definition }) {
  const answer = finalAnswer(run, def);
  return (
    <section className="llm-run" aria-label="上次執行結果">
      <div className="llm-run__head">
        <h3>上次執行結果</h3>
        <span className="text-muted">
          #{run.id}
          {run.started_at ? ` · ${fmtDateTime(run.started_at)}` : ''}
        </span>
        <Badge tone={run.status === 'succeeded' ? 'success' : 'error'}>{run.status === 'succeeded' ? '執行成功' : '執行失敗'}</Badge>
      </div>
      {run.status === 'failed' && run.error && <Alert tone="error">{run.error}</Alert>}
      <ol className="llm-run__nodes" aria-label="執行紀錄">
        {(run.nodes ?? []).map((n) => (
          <li key={n.seq} className={`llm-run__node llm-run__node--${n.status}`}>
            <Icon name={n.status === 'succeeded' ? 'success' : n.status === 'failed' ? 'error' : 'info'} />
            <strong>{n.node}</strong>
            <span>
              {nodeStatus(n.status).label}
              {n.context_source ? `（脈絡來源 ${n.context_source}）` : ''}
              {n.error ? `：${n.error}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {answer !== null && (
        <div className="llm-run__answer">
          <h4>最終回答</h4>
          <p className="llm-pre">{answer}</p>
        </div>
      )}
    </section>
  );
}

function RunDetail({ run }: { run: WorkflowRun }) {
  return (
    <div className="stack">
      <p>
        執行 #{run.id}：{run.status === 'succeeded' ? '成功' : `失敗（${run.error}）`}
        {run.finished_at ? ` · 結束於 ${fmtDateTime(run.finished_at)}` : ''}
      </p>
      <ol className="llm-node-results" aria-label="逐節點結果">
        {(run.nodes ?? []).map((n) => (
          <li key={n.seq} className="llm-node-result">
            <div className="llm-node-result__head">
              <span className="llm-node-result__seq">{n.seq}</span>
              <strong>{n.node}</strong>
              <span className="text-muted">{NODE_KIND[n.type]?.label ?? n.type}</span>
              <Badge tone={nodeStatus(n.status).tone}>{nodeStatus(n.status).label}</Badge>
            </div>
            {n.error && <Alert tone="error">{n.error}</Alert>}
            {n.context_source && <p className="text-muted">脈絡來源：{n.context_source}</p>}
            <CodeBlock title="節點輸出" language="json" code={JSON.stringify(n.state_out ?? {}, null, 2)} maxHeight="16rem" />
            {(n.llm_request != null || n.llm_response != null) && (
              <details>
                <summary>模型請求與回應</summary>
                <CodeBlock title="請求" language="json" code={JSON.stringify(n.llm_request, null, 2)} maxHeight="16rem" />
                <CodeBlock title="回應" language="json" code={JSON.stringify(n.llm_response, null, 2)} maxHeight="16rem" />
              </details>
            )}
          </li>
        ))}
      </ol>
      {run.final_state && <CodeBlock title="最後的 state" language="json" code={JSON.stringify(run.final_state, null, 2)} maxHeight="20rem" />}
    </div>
  );
}

type Tab = 'settings' | 'input' | 'result';

export function WorkflowsPage() {
  const { llm } = useLlm();
  const flows = useResource(() => llm!.workflows(), [llm]);
  const kbs = useResource(() => llm!.knowledgeBases(), [llm]);
  const pages = useResource(() => llm!.wikiPages(), [llm]);
  // undefined＝還沒選（載入後自動選第一個）；null＝新增流程
  const [selectedId, setSelectedId] = useState<number | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('settings');
  const [form, setForm] = useState({ name: '', description: '', definition: EXAMPLE });
  const [input, setInput] = useState('{"question": ""}');
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Workflow | null>(null);
  const [showDef, setShowDef] = useState(false);

  const list = flows.data ?? [];
  const currentId = selectedId === undefined ? (list[0]?.id ?? null) : selectedId;
  const current = list.find((w) => w.id === currentId) ?? null;

  // 換流程時：表單帶入這個流程、執行輸入換成範例格式、讀最近一次執行
  useEffect(() => {
    setError(null);
    setDone('');
    setRun(null);
    if (!current) {
      setForm({ name: '', description: '', definition: EXAMPLE });
      setTab('settings');
      return;
    }
    setForm({ name: current.name, description: current.description ?? '', definition: JSON.stringify(current.definition, null, 2) });
    setInput(sampleInput(current.definition));
    let cancelled = false;
    llm!
      .workflowRuns(current.id)
      .then((runs) => {
        const latest = [...runs].sort((a, b) => b.id - a.id)[0];
        return latest ? llm!.workflowRun(current.id, latest.id) : null;
      })
      .then((r) => {
        if (!cancelled && r) setRun(r);
      })
      .catch(() => undefined); // 讀不到舊紀錄不影響其他操作
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llm, current?.id]);

  const draftDef = useMemo(() => parse(form.definition), [form.definition]);
  const previewDef: Definition | null = draftDef ?? current?.definition ?? null;
  const statuses = useMemo(() => new Map((run?.nodes ?? []).map((n) => [n.node, n.status])), [run]);

  const describe = (n: WorkflowNode) => {
    if (n.type === 'retrieve' && typeof n.kb_id === 'number') return kbs.data?.find((k) => k.id === n.kb_id)?.name ?? `文件集 #${n.kb_id}`;
    if (n.type === 'wiki' && typeof n.page_id === 'number') return pages.data?.find((p) => p.id === n.page_id)?.title ?? `頁面 #${n.page_id}`;
    return '';
  };
  const sources = (previewDef?.nodes ?? [])
    .filter((n) => n.type === 'retrieve' || n.type === 'wiki')
    .map((n) => (n.type === 'retrieve' ? `參考文件「${describe(n)}」` : `團隊文件「${describe(n)}」`));

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone('');
    let definition: unknown;
    try {
      definition = JSON.parse(form.definition);
    } catch (err) {
      setError(new Error(`定義不是合法的 JSON：${(err as Error).message}`));
      return;
    }
    try {
      if (current) {
        await llm!.updateWorkflow(current.id, { name: form.name, description: form.description, definition });
        setDone('已儲存流程');
        flows.reload();
      } else {
        const w = await llm!.createWorkflow(form.name, definition, form.description);
        flows.reload();
        setSelectedId(w.id);
      }
    } catch (err) {
      setError(err);
    }
  }

  async function start() {
    if (!current) return;
    setError(null);
    let body: unknown;
    try {
      body = JSON.parse(input);
    } catch (err) {
      setError(new Error(`輸入不是合法的 JSON：${(err as Error).message}`));
      return;
    }
    setBusy(true);
    try {
      setRun(await llm!.runWorkflow(current.id, body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    try {
      await llm!.deleteWorkflow(removing.id);
      setSelectedId(undefined);
      flows.reload();
    } catch (err) {
      setError(err);
    } finally {
      setRemoving(null);
    }
  }

  return (
    <>
      <LlmHeader title="工作流程（LangGraph）" subtitle="使用團隊文件與參考文件，建立多步驟的問答流程；設定與結果和一般問答分開。" />
      <ApiErrorAlert error={flows.error} />
      <div className="llm-wf">
        <Card className="llm-wf__list">
          <button type="button" className="btn btn--primary llm-block-btn" onClick={() => setSelectedId(null)}>
            ＋ 新增流程
          </button>
          {list.length === 0 ? (
            <p className="text-muted">還沒有流程。</p>
          ) : (
            <ul aria-label="工作流列表" className="llm-wf__items">
              {list.map((w) => (
                <li key={w.id}>
                  <button type="button" className="llm-wf__item" aria-pressed={w.id === currentId} onClick={() => setSelectedId(w.id)}>
                    <span className="llm-wf__name">{w.name}</span>
                    <span className="llm-wf__desc">{w.description || `${w.definition.nodes.length} 個節點`}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="流程預覽" className="llm-wf__preview">
          {previewDef ? (
            <FlowChart def={previewDef} statuses={draftDef && current && form.definition !== JSON.stringify(current.definition, null, 2) ? undefined : statuses} describe={describe} />
          ) : (
            <Alert tone="warning">定義不是合法的 JSON，無法預覽。</Alert>
          )}
          {(sources.length > 0 || form.description) && (
            <dl className="llm-wf__facts">
              {sources.length > 0 && (
                <>
                  <dt>資料來源</dt>
                  <dd>{sources.join('、')}</dd>
                </>
              )}
              {form.description && (
                <>
                  <dt>流程用途</dt>
                  <dd>{form.description}</dd>
                </>
              )}
            </dl>
          )}
        </Card>

        <Card className="llm-wf__detail">
          <SegmentedTabs
            label="工作流程分頁"
            idPrefix="wf-tab"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'settings', label: '流程設定' },
              { key: 'input', label: '執行輸入' },
              { key: 'result', label: '執行結果' },
            ]}
          />
          <ApiErrorAlert error={error} />
          <div role="tabpanel" id={tabPanelId('wf-tab', tab)} aria-labelledby={`wf-tab-${tab}-tab`} className="stack llm-wf__panel">
            {tab === 'settings' && (
              <form aria-label={current ? '流程設定' : '新增工作流'} className="stack" onSubmit={save}>
                {done && <Alert tone="success">{done}</Alert>}
                <div className="field">
                  <label htmlFor="wf-name">名稱</label>
                  <input id="wf-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="wf-desc">流程用途（選填）</label>
                  <input id="wf-desc" className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="wf-def">定義（JSON：state、nodes、edges；節點種類 template、retrieve、wiki、llm、condition）</label>
                  <textarea id="wf-def" className="input llm-mono" rows={14} spellCheck={false} value={form.definition} onChange={(e) => setForm({ ...form, definition: e.target.value })} />
                </div>
                <div className="row-actions">
                  <button type="submit" className="btn btn--primary">
                    {current ? '儲存流程' : '新增工作流'}
                  </button>
                  {current && (
                    <button type="button" className="btn btn--danger" onClick={() => setRemoving(current)}>
                      刪除流程
                    </button>
                  )}
                </div>
              </form>
            )}

            {tab === 'input' &&
              (current ? (
                <>
                  <div className="field">
                    <div className="llm-field-head">
                      <label htmlFor="wf-input">執行輸入（JSON）</label>
                      <button type="button" className="btn btn--ghost btn--small" onClick={() => setInput(sampleInput(current.definition))}>
                        範例格式
                      </button>
                    </div>
                    <textarea id="wf-input" className="input llm-mono" rows={6} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} />
                    <p className="field__hint">欄位要和定義的 state 相同。</p>
                  </div>
                  <div className="row-actions">
                    <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void start()}>
                      <Icon name="play" /> {busy ? '執行中…' : '執行流程'}
                    </button>
                    <button type="button" className="btn btn--secondary" onClick={() => setShowDef(true)}>
                      <Icon name="doc" /> 檢視定義 JSON
                    </button>
                  </div>
                  {run ? <RunSummary run={run} def={current.definition} /> : <p className="text-muted">這個流程還沒有執行過。</p>}
                </>
              ) : (
                <p className="text-muted">先在「流程設定」新增流程，才能執行。</p>
              ))}

            {tab === 'result' &&
              (run ? <RunDetail run={run} /> : <EmptyState icon="play" title="還沒有執行結果" description="在「執行輸入」按「執行流程」後，這裡會列出每個節點的結果。只保留最近一次。" />)}
          </div>
        </Card>
      </div>

      <SlideOver open={showDef && !!current} title={`${current?.name ?? ''} 定義 JSON`} onClose={() => setShowDef(false)}>
        {current && <CodeBlock title="定義" language="json" code={JSON.stringify(current.definition, null, 2)} />}
      </SlideOver>
      {removing && (
        <ConfirmDialog title="刪除流程" confirmLabel="刪除流程" onConfirm={() => void remove()} onCancel={() => setRemoving(null)}>
          確定刪除「{removing.name}」？刪除後無法復原。
        </ConfirmDialog>
      )}
    </>
  );
}
