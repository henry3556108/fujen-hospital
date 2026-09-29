import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { ApiErrorAlert } from '../../components/Alert';
import type { WorkflowRun } from './api';
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

export function WorkflowsPage() {
  const { llm } = useLlm();
  const flows = useResource(() => llm!.workflows(), [llm]);
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState(EXAMPLE);
  const [input, setInput] = useState('{"question": "夜間門診是星期幾"}');
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await llm!.createWorkflow(name, JSON.parse(definition));
      setName('');
      flows.reload();
    } catch (err) {
      setError(err instanceof SyntaxError ? new Error(`定義不是合法的 JSON：${err.message}`) : err);
    }
  }

  async function start(id: number) {
    setError(null);
    try {
      setRun(await llm!.runWorkflow(id, JSON.parse(input)));
    } catch (err) {
      setError(err instanceof SyntaxError ? new Error(`輸入不是合法的 JSON：${err.message}`) : err);
    }
  }

  return (
    <>
      <ApiErrorAlert error={flows.error ?? error} />
      <div className="field section">
        <label htmlFor="wf-input">執行輸入（JSON）</label>
        <input id="wf-input" className="input" value={input} onChange={(e) => setInput(e.target.value)} />
      </div>
      <div className="table-wrap section">
        <table aria-label="工作流列表">
          <thead><tr><th>名稱</th><th>節點</th><th>操作</th></tr></thead>
          <tbody>
            {(flows.data ?? []).map((w) => (
              <tr key={w.id}>
                <th scope="row">{w.name}</th><td>{w.definition.nodes.map((n) => n.id).join(' → ')}</td>
                <td className="row-actions">
                  <button type="button" className="btn btn--small btn--primary" onClick={() => void start(w.id)}>執行</button>
                  <button type="button" className="btn btn--small btn--danger" onClick={() => void llm!.deleteWorkflow(w.id).then(flows.reload, setError)}>刪除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {run && (
        <section className="card section" aria-label="執行紀錄">
          <h2>執行紀錄 #{run.id}：{run.status === 'succeeded' ? '成功' : `失敗（${run.error}）`}</h2>
          <ol>
            {run.nodes.map((n) => (
              <li key={n.seq}>
                {n.node}（{n.type}）：{n.status}{n.context_source ? `，脈絡來源 ${n.context_source}` : ''}{n.error ? `，${n.error}` : ''}
              </li>
            ))}
          </ol>
          {run.final_state && <pre className="llm-pre">{JSON.stringify(run.final_state, null, 2)}</pre>}
        </section>
      )}
      <form aria-label="新增工作流" className="card section" onSubmit={create}>
        <h2>新增工作流</h2>
        <div className="field">
          <label htmlFor="wf-name">名稱</label>
          <input id="wf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="wf-def">定義（JSON：state、nodes、edges；節點種類 template、retrieve、wiki、llm、condition）</label>
          <textarea id="wf-def" className="input" rows={14} value={definition} onChange={(e) => setDefinition(e.target.value)} />
        </div>
        <button type="submit" className="btn btn--primary">新增工作流</button>
      </form>
    </>
  );
}
