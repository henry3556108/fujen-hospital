import { useEffect, useState, type ChangeEvent } from 'react';
import { useResource } from '../../api/useResource';
import { useMe } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert, Badge, Card, ConfirmDialog, EmptyState, SegmentedTabs, SidePanel, SplitLayout, tabPanelId, type BadgeTone } from '../../components/ui';
import type { CatalogModel, Download, LoadConfig, ModelInspection } from './api';
import { LlmHeader } from './LlmLayout';
import { fmtDateTime } from './parts';
import { useLlm } from './useLlm';

const STATUS: Record<Download['status'], string> = {
  pending: '待審核', approved: '已核准', rejected: '已駁回', downloading: '下載中', completed: '完成', failed: '失敗',
};

const STATUS_TONE: Record<Download['status'], BadgeTone> = {
  pending: 'warning', approved: 'info', rejected: 'neutral', downloading: 'info', completed: 'success', failed: 'error',
};

type Tab = 'catalog' | 'downloads' | 'load';

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export function downloadStatus(d: Download) {
  const label = STATUS[d.status] ?? d.status;
  if (d.status === 'downloading' && d.progress) {
    const { done, total } = d.progress;
    return total ? `${label} ${Math.floor((done / total) * 100)}%（${megabytes(done)} / ${megabytes(total)}）` : `${label} ${megabytes(done)}`;
  }
  return `${label}${d.mode === 'offline' ? '（離線預載）' : ''}`;
}

/** 白名單模型在清單上的狀態徽章（設計稿 B13：已下載、申請中、可申請） */
export function modelState(m: CatalogModel, downloads: Download[]): { label: string; tone: BadgeTone } {
  const mine = downloads.filter((d) => d.name === m.name);
  const active = mine.find((d) => d.status === 'downloading');
  if (m.loaded) return { label: '已載入', tone: 'success' };
  if (m.installed) return { label: '已下載', tone: 'info' };
  if (active) return { label: downloadStatus(active), tone: 'info' };
  if (mine.some((d) => d.status === 'approved')) return { label: '已核准，待下載', tone: 'info' };
  if (mine.some((d) => d.status === 'pending')) return { label: '申請中', tone: 'warning' };
  return { label: '可申請', tone: 'neutral' };
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

function Radios<V extends string>({ name, legend, value, options, onChange }: { name: string; legend: string; value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  return (
    <fieldset className="llm-radios">
      <legend>{legend}</legend>
      <div className="llm-radios__opts">
        {options.map((o) => (
          <label key={o.value} className="llm-radios__opt">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** 右側「載入設定」表單：量化、CPU、記憶體、GPU 類型與張數；已載入時「套用並重新載入」（設計稿 B13）。 */
function LoadConfigForm({ model, onChange }: { model: CatalogModel; onChange: () => void }) {
  const { llm } = useLlm();
  const { data, error, setData } = useResource(() => llm!.getLoadConfig(model.name), [llm, model.name]);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: unknown } | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  if (error) return <ApiErrorAlert error={error} />;
  if (!data) return <p role="status" className="loading">載入設定…</p>;
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
    <form
      aria-label={`${model.name} 載入設定`}
      className="llm-load-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => llm!.putLoadConfig(model.name, data), '已儲存載入設定');
      }}
    >
      {message?.tone === 'success' && <Alert tone="success">{String(message.text)}</Alert>}
      {message?.tone === 'error' && <ApiErrorAlert error={message.text} />}
      <div className="llm-load-form__row">
        <label htmlFor={id('name')}>模型名稱</label>
        <input id={id('name')} className="input" value={model.name} readOnly />
      </div>
      <Radios
        name={id('q')}
        legend="量化設定"
        value={data.quantization}
        onChange={(v) => set('quantization', v)}
        options={[
          { value: 'none', label: '不量化' },
          { value: '4bit', label: '4-bit' },
          { value: '8bit', label: '8-bit' },
        ]}
      />
      <div className="llm-load-form__row">
        <label htmlFor={id('cpu')}>CPU 核心數</label>
        <input id={id('cpu')} className="input" type="number" min={1} value={data.cpu} onChange={(e) => set('cpu', Number(e.target.value))} />
      </div>
      <div className="llm-load-form__row">
        <label htmlFor={id('mem')}>記憶體（GB）</label>
        <input id={id('mem')} className="input" type="number" min={1} value={data.memory_gb} onChange={(e) => set('memory_gb', Number(e.target.value))} />
      </div>
      <Radios
        name={id('gpu')}
        legend="GPU 類型"
        value={data.gpu_type}
        onChange={(v) => set('gpu_type', v)}
        options={[
          { value: 'gpu-exclusive', label: '獨占' },
          { value: 'gpu-shared', label: '共享' },
          { value: 'cpu', label: '只用 CPU' },
        ]}
      />
      <div className="llm-load-form__row">
        <label htmlFor={id('count')}>GPU 張數</label>
        <input id={id('count')} className="input" type="number" min={0} value={data.gpu_count} onChange={(e) => set('gpu_count', Number(e.target.value))} />
      </div>
      {model.loaded ? (
        <>
          <button
            type="button"
            className="btn btn--primary llm-block-btn"
            disabled={busy}
            onClick={() => void run(() => llm!.putLoadConfig(model.name, data).then(() => llm!.loadModel(model.name)), '已依新設定重新載入')}
          >
            {busy ? '處理中…' : '套用並重新載入'}
          </button>
          <div className="llm-btn-pair">
            <button type="submit" className="btn btn--secondary" disabled={busy}>
              儲存載入設定
            </button>
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void run(() => llm!.unloadModel(model.name), '已卸載')}>
              卸載
            </button>
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn btn--primary llm-block-btn"
            disabled={busy}
            onClick={() => void run(() => llm!.putLoadConfig(model.name, data).then(() => llm!.loadModel(model.name)), '已載入')}
          >
            {busy ? '處理中…' : '載入'}
          </button>
          <button type="submit" className="btn btn--secondary llm-block-btn" disabled={busy}>
            儲存載入設定
          </button>
        </>
      )}
      <p className="field__hint">修改資源後要重新載入才會生效。</p>
      {model.loaded && <RuntimeStatus name={model.name} version={version} />}
    </form>
  );
}

function LoadPanel({ model, onClose, onChange }: { model: CatalogModel; onClose: () => void; onChange: () => void }) {
  return (
    <SidePanel title="載入設定" onClose={onClose}>
      <section aria-label={`${model.name} 資源設定`} className="stack">
        {model.loaded ? (
          <Alert tone="success" title="已載入">
            {model.name} 目前已載入，可開始使用。
          </Alert>
        ) : (
          <Alert tone="info" title="已下載，尚未載入">
            確認下面的設定後按「載入」。
          </Alert>
        )}
        <LoadConfigForm model={model} onChange={onChange} />
      </section>
    </SidePanel>
  );
}

/** 右側「新增模型」（限管理者）：輸入 Hugging Face 模型名稱與 Token，系統查出版本與內容後加入白名單。 */
function AddModelPanel({ onClose, onAdded }: { onClose: () => void; onAdded: (name: string) => void }) {
  const { llm } = useLlm();
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [patterns, setPatterns] = useState('');
  const [seen, setSeen] = useState<ModelInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const files = patterns.split(/[,，\s]+/).filter(Boolean);
  const name = repo.trim().split('/').pop() ?? '';
  // 改了內容就要重新檢查，才不會把舊的查詢結果加進白名單
  const edit = (set: (v: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    setSeen(null);
  };
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SidePanel title="新增模型" onClose={onClose}>
      <form
        aria-label="新增模型"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => setSeen(await llm!.inspectModel(repo.trim(), token, files)));
        }}
      >
        <div className="field">
          <label htmlFor="add-model-repo">Hugging Face 模型名稱</label>
          <input id="add-model-repo" className="input" required pattern="[^\s/]+/[^\s/]+" title="格式：組織/模型" placeholder="例如 ggml-org/gemma-3-4b-it-GGUF" value={repo} onChange={edit(setRepo)} />
        </div>
        <div className="field">
          <label htmlFor="add-model-token">Token（選填）</label>
          <input id="add-model-token" className="input" type="password" autoComplete="off" placeholder="需要授權的模型才要填，不會被儲存" value={token} onChange={edit(setToken)} />
        </div>
        <div className="field">
          <label htmlFor="add-model-files">只下載這些檔案（選填）</label>
          <input id="add-model-files" className="input" placeholder="例如 *Q4_K_M.gguf" value={patterns} onChange={edit(setPatterns)} />
          <p className="field__hint">不填就下載整個模型。多個條件用空白或逗號分開。</p>
        </div>
        <button type="submit" className="btn btn--secondary llm-block-btn" disabled={busy}>
          檢查模型
        </button>
      </form>
      <ApiErrorAlert error={error} />
      {seen && (
        <section aria-label="檢查結果" className="stack">
          <Alert tone="success" title="檢查完成">
            {name}：版本 {seen.commit.slice(0, 8)}，{seen.files.length} 個檔案，共 {megabytes(seen.total_bytes)}
            {seen.gated ? '，下載時需要 Token' : ''}
            {seen.has_remote_code ? '，夾帶程式碼，需另外核准才能載入' : ''}。
          </Alert>
          {!seen.files.some((f) => f.toLowerCase().endsWith('.gguf')) && (
            <Alert tone="warning">這個模型沒有 GGUF 檔案，下載後可能無法載入。</Alert>
          )}
          <button
            type="button"
            className="btn btn--primary llm-block-btn"
            disabled={busy}
            onClick={() => void run(async () => {
              await llm!.addModel(name, seen, files);
              onAdded(name);
            })}
          >
            加入白名單
          </button>
        </section>
      )}
    </SidePanel>
  );
}

export function ModelsPage() {
  const me = useMe();
  const { llm } = useLlm();
  const catalog = useResource(() => llm!.catalog(), [llm]);
  const downloads = useResource(() => llm!.downloads(), [llm]);
  const [tab, setTab] = useState<Tab>('catalog');
  const [q, setQ] = useState('');
  const [recordsOf, setRecordsOf] = useState('');
  // undefined＝還沒選，自動開第一個已載入（或已下載）的模型
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<unknown>(null);
  const reload = () => {
    catalog.reload();
    downloads.reload();
  };
  async function act(work: () => Promise<unknown>) {
    setError(null);
    try {
      await work();
      reload();
    } catch (e) {
      setError(e);
    }
  }
  const list = downloads.data ?? [];
  const models = catalog.data ?? [];
  const running = list.filter((d) => d.status === 'downloading');
  // 大檔在背景下載：有下載中的項目就每 3 秒更新進度
  useEffect(() => {
    if (running.length === 0) return;
    const timer = window.setInterval(reload, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running.length]);

  const auto = models.find((m) => m.loaded) ?? models.find((m) => m.installed);
  const openName = selected === undefined ? auto?.name : selected;
  const open = models.find((m) => m.name === openName && m.installed) ?? null;
  const shown = models.filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase()) || m.repo.toLowerCase().includes(q.toLowerCase()));
  const records = list.filter((d) => !recordsOf || d.name === recordsOf);
  const installed = models.filter((m) => m.installed);

  const showRecords = (name: string) => {
    setRecordsOf(name);
    setTab('downloads');
  };

  return (
    <>
      <LlmHeader
        title="語言模型管理"
        subtitle="管理可用的語言模型，申請下載並設定載入參數。下載前需管理者核准。"
        actions={me.account_type === 'admin' && (
          <button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>
            新增模型
          </button>
        )}
      />
      <div className="llm-stretch">
        <SplitLayout
          side={
            adding ? (
              <AddModelPanel
                onClose={() => setAdding(false)}
                onAdded={(name) => {
                  setAdding(false);
                  setAdded(name);
                  setTab('catalog');
                  reload();
                }}
              />
            ) : open ? (
              <LoadPanel key={open.name} model={open} onClose={() => setSelected(null)} onChange={catalog.reload} />
            ) : undefined
          }
        >
          <SegmentedTabs
            label="語言模型管理分頁"
            idPrefix="llm-models"
            value={tab}
            onChange={setTab}
            items={[
              { key: 'catalog', label: '可用模型' },
              { key: 'downloads', label: '下載申請' },
              { key: 'load', label: '載入設定' },
            ]}
          />
          <ApiErrorAlert error={catalog.error ?? downloads.error ?? error} />
          {added && <Alert tone="success">已將 {added} 加入白名單，可以在清單上按「申請下載」。</Alert>}
          <div role="tabpanel" id={tabPanelId('llm-models', tab)} aria-labelledby={`llm-models-${tab}-tab`} className="stack llm-fill">
            {tab === 'catalog' && (
              <>
                <p className="text-muted">只有白名單內的模型可以下載，要用清單外的模型請由管理者按「新增模型」；下載前需管理者在「系統管理 › 稽核與審核」核准，夾帶程式碼的模型需另外核准才能載入。</p>
                <div className="llm-model-filters">
                  <div className="field">
                    <label htmlFor="model-q">搜尋模型</label>
                    <input id="model-q" className="input" type="search" placeholder="搜尋模型名稱或來源" value={q} onChange={(e) => setQ(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="model-token">下載 Token（選填）</label>
                    <input id="model-token" className="input" type="password" autoComplete="off" placeholder="需要時填寫，不會被儲存" value={token} onChange={(e) => setToken(e.target.value)} />
                  </div>
                </div>
                <Card flush>
                  <div className="table-wrap">
                    <table aria-label="白名單模型">
                      <thead>
                        <tr>
                          <th>模型名稱</th>
                          <th>來源與授權</th>
                          <th>狀態</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((m) => {
                          const mine = list.filter((d) => d.name === m.name);
                          const approved = mine.find((d) => d.status === 'approved');
                          const active = mine.find((d) => d.status === 'downloading');
                          const requested = mine.find((d) => d.status === 'pending');
                          const state = modelState(m, list);
                          return (
                            <tr key={m.name} className={open?.name === m.name ? 'llm-row--selected' : undefined}>
                              <th scope="row" className="llm-nowrap">
                                {m.name}
                              </th>
                              <td>
                                {m.repo}@{m.revision.slice(0, 8)}
                                <span className="llm-cell-note">
                                  授權 {m.license || '—'}
                                  {m.has_remote_code ? '（夾帶程式碼）' : ''}
                                </span>
                              </td>
                              <td>
                                <Badge tone={state.tone}>{state.label}</Badge>
                              </td>
                              <td>
                                <div className="row-actions">
                                  {m.installed && (
                                    <button type="button" className="btn btn--small btn--secondary" aria-pressed={open?.name === m.name} onClick={() => setSelected(m.name)}>
                                      載入設定
                                    </button>
                                  )}
                                  {!m.installed && !approved && !active && !requested && (
                                    <button type="button" className="btn btn--small btn--secondary" onClick={() => void act(() => llm!.requestDownload(m.name))}>
                                      申請下載
                                    </button>
                                  )}
                                  {approved && (
                                    <button type="button" className="btn btn--small btn--primary" onClick={() => void act(() => llm!.executeDownload(approved.id, token))}>
                                      下載
                                    </button>
                                  )}
                                  {me.account_type === 'admin' && m.has_remote_code && !m.remote_code_approved && (
                                    <button type="button" className="btn btn--small btn--secondary" onClick={() => void act(() => llm!.approveRemoteCode(m.name))}>
                                      核准程式碼
                                    </button>
                                  )}
                                  <button type="button" className="btn btn--small btn--ghost" onClick={() => showRecords(m.name)}>
                                    下載紀錄
                                  </button>
                                  {m.installed && (
                                    <button type="button" className="btn btn--small btn--danger" onClick={() => setRemoving(m.name)}>
                                      刪除模型
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {catalog.data && shown.length === 0 && (
                          <tr>
                            <td colSpan={4} className="llm-empty-row">
                              {q ? '沒有符合的模型。' : '白名單內還沒有模型。'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </>
            )}

            {tab === 'downloads' && (
              <>
                {recordsOf && (
                  <p className="llm-filter">
                    只看「{recordsOf}」
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => setRecordsOf('')}>
                      顯示全部
                    </button>
                  </p>
                )}
                <p className="text-muted">申請由管理者在「系統管理 › 稽核與審核」核准或駁回；核准後回到「可用模型」按「下載」。</p>
                <Card flush>
                  <div className="table-wrap">
                    <table aria-label="下載紀錄">
                      <thead>
                        <tr>
                          <th>模型</th>
                          <th>狀態</th>
                          <th>申請人</th>
                          <th>審核人</th>
                          <th>commit</th>
                          <th>hash</th>
                          <th>時間</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((d) => (
                          <tr key={d.id}>
                            <th scope="row">{d.name}</th>
                            <td>
                              <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{downloadStatus(d)}</Badge>
                              {d.message && <span className="llm-cell-note">{d.message}</span>}
                            </td>
                            <td>{d.user}</td>
                            <td>{d.reviewer ?? '—'}</td>
                            <td>{d.commit?.slice(0, 8) ?? '—'}</td>
                            <td>{d.hash?.slice(0, 12) ?? '—'}</td>
                            <td>{d.time ? fmtDateTime(d.time) : '—'}</td>
                          </tr>
                        ))}
                        {downloads.data && records.length === 0 && (
                          <tr>
                            <td colSpan={7} className="llm-empty-row">
                              還沒有下載申請。
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </>
            )}

            {tab === 'load' &&
              (installed.length === 0 ? (
                <EmptyState icon="cube" title="還沒有下載的模型" description="先在「可用模型」申請下載，核准並下載後才能設定載入。" />
              ) : (
                <Card flush>
                  <div className="table-wrap">
                    <table aria-label="已下載的模型">
                      <thead>
                        <tr>
                          <th>模型名稱</th>
                          <th>狀態</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {installed.map((m) => (
                          <tr key={m.name} className={open?.name === m.name ? 'llm-row--selected' : undefined}>
                            <th scope="row">{m.name}</th>
                            <td>
                              <Badge tone={m.loaded ? 'success' : 'info'}>{m.loaded ? '已載入' : '已下載'}</Badge>
                            </td>
                            <td>
                              <div className="row-actions">
                                <button type="button" className="btn btn--small btn--secondary" aria-pressed={open?.name === m.name} onClick={() => setSelected(m.name)}>
                                  載入設定
                                </button>
                                <button type="button" className="btn btn--small btn--danger" onClick={() => setRemoving(m.name)}>
                                  刪除模型
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ))}
          </div>
        </SplitLayout>
      </div>
      {removing && (
        <ConfirmDialog
          title="刪除模型"
          confirmLabel="刪除模型"
          onConfirm={() => {
            const name = removing;
            setRemoving(null);
            void act(() => llm!.deleteModel(name));
          }}
          onCancel={() => setRemoving(null)}
        >
          刪除「{removing}」的模型檔案？刪除後若要再使用，需要重新下載。
        </ConfirmDialog>
      )}
    </>
  );
}
