import { useEffect, useState } from 'react';
import { useResource } from '../../api/useResource';
import { useMe } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import type { CatalogModel, Download, LoadConfig } from './api';
import { useLlm } from './useLlm';

const STATUS: Record<Download['status'], string> = {
  pending: '待審核', approved: '已核准', rejected: '已駁回', downloading: '下載中', completed: '完成', failed: '失敗',
};

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function downloadStatus(d: Download) {
  const label = STATUS[d.status] ?? d.status;
  if (d.status === 'downloading' && d.progress) {
    const { done, total } = d.progress;
    return total ? `${label} ${Math.floor((done / total) * 100)}%（${megabytes(done)} / ${megabytes(total)}）` : `${label} ${megabytes(done)}`;
  }
  return `${label}${d.mode === 'offline' ? '（離線預載）' : ''}`;
}

function RuntimeStatus({ name, version }: { name: string; version: number }) {
  const { llm } = useLlm();
  const { data } = useResource(() => llm!.modelRuntime(name), [llm, name, version]);
  const rt = data?.runtime;
  if (!rt) return null;
  const parts = [
    `量化 ${rt.quantization_level ?? rt.quantization ?? '—'}`,
    `CPU 執行緒 ${rt.num_thread ?? '—'}`,
    rt.processor === 'gpu' ? '在 GPU 上執行' : rt.processor === 'cpu' ? '在 CPU 上執行' : '未在執行',
  ];
  if (rt.vram_bytes) parts.push(`顯示記憶體 ${megabytes(rt.vram_bytes)}`);
  return <p className="text-muted" aria-label={`${name} 執行狀態`}>模型服務回報：{parts.join('、')}</p>;
}

function LoadConfigForm({ model, onChange }: { model: CatalogModel; onChange: () => void }) {
  const { llm } = useLlm();
  const { data, error, setData } = useResource(() => llm!.getLoadConfig(model.name), [llm, model.name]);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: unknown } | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  if (error) return <ApiErrorAlert error={error} />;
  if (!data) return null;
  const set = <K extends keyof LoadConfig>(k: K, v: LoadConfig[K]) => setData({ ...data, [k]: v });
  const id = (k: string) => `load-${model.name}-${k}`;
  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await work();
      setMessage({ tone: 'success', text: done });
      onChange();
    } catch (e) {
      setMessage({ tone: 'error', text: e });
    } finally {
      setBusy(false);
      setVersion((v) => v + 1);
    }
  }
  return (
    <form aria-label={`${model.name} 載入設定`} className="stack" onSubmit={(e) => { e.preventDefault(); void run(() => llm!.putLoadConfig(model.name, data), '已儲存載入設定'); }}>
      {message?.tone === 'success' && <Alert tone="success">{String(message.text)}</Alert>}
      {message?.tone === 'error' && <ApiErrorAlert error={message.text} />}
      <div className="form-grid">
        <div className="field">
          <label htmlFor={id('q')}>量化</label>
          <select id={id('q')} className="select" value={data.quantization} onChange={(e) => set('quantization', e.target.value as LoadConfig['quantization'])}>
            <option value="none">不量化</option>
            <option value="4bit">4-bit</option>
            <option value="8bit">8-bit</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={id('cpu')}>CPU</label>
          <input id={id('cpu')} className="input" type="number" min={1} value={data.cpu} onChange={(e) => set('cpu', Number(e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor={id('mem')}>記憶體（GB）</label>
          <input id={id('mem')} className="input" type="number" min={1} value={data.memory_gb} onChange={(e) => set('memory_gb', Number(e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor={id('gpu')}>GPU 類型</label>
          <select id={id('gpu')} className="select" value={data.gpu_type} onChange={(e) => set('gpu_type', e.target.value as LoadConfig['gpu_type'])}>
            <option value="gpu-exclusive">獨占 GPU</option>
            <option value="gpu-shared">共享 GPU</option>
            <option value="cpu">只用 CPU</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={id('count')}>GPU 張數</label>
          <input id={id('count')} className="input" type="number" min={0} value={data.gpu_count} onChange={(e) => set('gpu_count', Number(e.target.value))} />
        </div>
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn--secondary">儲存載入設定</button>
        {model.installed && (
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void run(() => (model.loaded ? llm!.unloadModel(model.name) : llm!.loadModel(model.name)), model.loaded ? '已卸載' : '已載入')}>
            {busy ? '處理中…' : model.loaded ? '卸載' : '載入'}
          </button>
        )}
        {model.installed && model.loaded && (
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void run(() => llm!.putLoadConfig(model.name, data).then(() => llm!.loadModel(model.name)), '已依新設定重新載入')}>
            套用並重新載入
          </button>
        )}
      </div>
      {model.loaded && <RuntimeStatus name={model.name} version={version} />}
    </form>
  );
}

export function ModelsPage() {
  const me = useMe();
  const { llm } = useLlm();
  const catalog = useResource(() => llm!.catalog(), [llm]);
  const downloads = useResource(() => llm!.downloads(), [llm]);

  const [token, setToken] = useState('');
  const [error, setError] = useState<unknown>(null);
  const reload = () => { catalog.reload(); downloads.reload(); };
  async function act(work: () => Promise<unknown>) {
    setError(null);
    try {
      await work();
      reload();
    } catch (e) {
      setError(e);
    }
  }
  const ready = (downloads.data ?? []).filter((d) => d.status === 'approved');
  const running = (downloads.data ?? []).filter((d) => d.status === 'downloading');
  const waiting = (downloads.data ?? []).filter((d) => d.status === 'pending');
  // 大檔在背景下載：有下載中的項目就每 3 秒更新進度
  useEffect(() => {
    if (running.length === 0) return;
    const timer = window.setInterval(reload, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running.length]);
  return (
    <>
      <section className="card section" aria-labelledby="catalog-title">
        <h2 id="catalog-title">可下載模型（白名單）</h2>
        <p className="text-muted">只有白名單內的模型可以下載；下載前需管理者在「系統管理 › 稽核與審核」核准，夾帶程式碼的模型需另外核准才能載入。</p>
        <ApiErrorAlert error={catalog.error ?? error} />
        <div className="field">
          <label htmlFor="model-token">下載 Token（需要時填寫，不會被儲存）</label>
          <input id="model-token" className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table aria-label="白名單模型">
            <thead><tr><th>名稱</th><th>來源</th><th>授權</th><th>狀態</th><th>操作</th></tr></thead>
            <tbody>
              {(catalog.data ?? []).map((m) => {
                const approved = ready.find((d) => d.name === m.name);
                const active = running.find((d) => d.name === m.name);
                const requested = waiting.find((d) => d.name === m.name);
                return (
                  <tr key={m.name}>
                    <th scope="row">{m.name}</th>
                    <td>{m.repo}@{m.revision.slice(0, 8)}</td>
                    <td>{m.license || '—'}{m.has_remote_code ? '（夾帶程式碼）' : ''}</td>
                    <td>{m.loaded ? '已載入' : m.installed ? '已下載' : active ? downloadStatus(active) : approved ? '已核准，待下載' : requested ? '已申請，待核准' : '未下載'}</td>
                    <td className="row-actions">
                      {!m.installed && !approved && !active && !requested && <button type="button" className="btn btn--small btn--secondary" onClick={() => void act(() => llm!.requestDownload(m.name))}>申請下載</button>}
                      {approved && <button type="button" className="btn btn--small btn--primary" onClick={() => void act(() => llm!.executeDownload(approved.id, token))}>下載</button>}
                      {m.installed && <button type="button" className="btn btn--small btn--danger" onClick={() => void act(() => llm!.deleteModel(m.name))}>刪除</button>}
                      {me.account_type === 'admin' && m.has_remote_code && !m.remote_code_approved && (
                        <button type="button" className="btn btn--small btn--secondary" onClick={() => void act(() => llm!.approveRemoteCode(m.name))}>核准程式碼</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card section" aria-labelledby="records-title">
        <h2 id="records-title">下載紀錄</h2>
        <div className="table-wrap">
          <table aria-label="下載紀錄">
            <thead><tr><th>模型</th><th>狀態</th><th>申請人</th><th>審核人</th><th>commit</th><th>hash</th><th>時間</th></tr></thead>
            <tbody>
              {(downloads.data ?? []).map((d) => (
                <tr key={d.id}>
                  <th scope="row">{d.name}</th><td>{downloadStatus(d)}</td><td>{d.user}</td>
                  <td>{d.reviewer ?? '—'}</td><td>{d.commit?.slice(0, 8) ?? '—'}</td><td>{d.hash?.slice(0, 12) ?? '—'}</td><td>{d.time ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {(catalog.data ?? []).filter((m) => m.installed).map((m) => (
        <section key={m.name} className="card section" aria-label={`${m.name} 資源設定`}>
          <h2>{m.name} 載入與資源</h2>
          <LoadConfigForm model={m} onChange={catalog.reload} />
        </section>
      ))}
    </>
  );
}
