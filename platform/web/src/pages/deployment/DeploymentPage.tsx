// AI 模型部署（B-06 部署）：模型清單與下載、分享給同事使用（顯示名稱、分享對象；技術名稱由伺服器產生）、
// 修改分享對象、停止分享；端點、curl、Token 收在「給資訊人員：程式呼叫方式」。
// 入口規則是 Prediction（看模型清單）；分享、下載模型的 API 需要 Training，沒有時只顯示清單與說明。
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { KIND_NAMES, isImageModel, type Model } from '../inference/api';
import { parseUsers, useTrainingApi, type Deployment, type TrainingApi } from '../training/api';
import { downloadAndSave, useHasPermission } from '../training/ModelExport';
import { TryPredict } from './TryPredict';
import '../training/training.css';

/** 由模型名稱建議顯示名稱：模型名稱是「訓練設定名稱-run編號」，預設用訓練設定名稱。 */
export function suggestTitle(name: string): string {
  return name.replace(/-run\d+$/, '') || name;
}

export function DeploymentPage() {
  const api = useTrainingApi();
  return (
    <>
      <h1>AI 模型部署</h1>
      {api ? <Deployments key={api.projectId} api={api} /> : <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>}
    </>
  );
}

function Deployments({ api }: { api: TrainingApi }) {
  const canTrain = useHasPermission('training');
  const models = useResource(() => api.models(), [api]);
  const deployments = useResource(() => (canTrain ? api.deployments() : Promise.resolve([])), [api, canTrain]);
  const [done, setDone] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [params] = useSearchParams();
  const wanted = Number(params.get('model')) || null;
  const [form, setForm] = useState({ model: wanted ? String(wanted) : '', title: '', users: '' });
  const formRef = useRef<HTMLFormElement>(null);
  const [prefilled, setPrefilled] = useState(false);
  // 從建模管理「分享給同事使用」進來：預選模型、建議顯示名稱、捲到分享表單
  useEffect(() => {
    if (!wanted || prefilled || !models.data) return;
    const m = models.data.find((x) => x.id === wanted);
    if (!m) return;
    setPrefilled(true);
    setForm((f) => ({ ...f, model: String(m.id), title: f.title || suggestTitle(m.name) }));
    window.setTimeout(() => {
      formRef.current?.scrollIntoView?.({ block: 'start' });
      formRef.current?.querySelector<HTMLInputElement>('#dep-users')?.focus();
    }, 0);
  }, [wanted, prefilled, models.data]);
  const [editing, setEditing] = useState<{ id: number; users: string } | null>(null);
  const [removing, setRemoving] = useState<Deployment | null>(null);

  if (models.error) return <ApiErrorAlert error={models.error} />;
  if (!models.data) return <p role="status">載入中…</p>;
  const modelOf = (id: number) => models.data!.find((m) => m.id === id);
  const selected = modelOf(Number(form.model)) ?? models.data[0] ?? null;

  async function act(call: () => Promise<string>) {
    setError(null);
    setDone('');
    try {
      setDone(await call());
    } catch (err) {
      setError(err);
    }
  }

  function deploy(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const users = parseUsers(form.users);
    if (!users.length) {
      setDone('');
      return setError(new Error('請填要分享的同事帳號，例如 md01'));
    }
    void act(async () => {
      const d = await api.deploy({ model_id: selected.id, title: form.title.trim() || suggestTitle(selected.name), allowed_users: users });
      deployments.reload();
      setForm({ model: '', title: '', users: '' });
      return sharedMessage(d, selected);
    });
  }

  function saveAccess(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    void act(async () => {
      const d = await api.setAccess(editing.id, parseUsers(editing.users));
      deployments.reload();
      setEditing(null);
      return `已更新「${titleOf(d)}」的分享對象：${d.allowed_users.join('、') || '（無）'}。` + outsideNote(d);
    });
  }

  function undeploy() {
    const target = removing;
    setRemoving(null);
    if (!target) return;
    void act(async () => {
      await api.undeploy(target.id);
      deployments.reload();
      return `已停止分享「${titleOf(target)}」。專案成員仍可在「推論服務管理」使用這個模型，但程式呼叫的端點不再接受呼叫。`;
    });
  }

  return (
    <div className="stack">
      {!canTrain ? (
        <Alert tone="info">分享模型、下載模型需要 Training 權限；如需使用，請聯絡專案負責人或系統管理者。要用模型預測，請到左側「推論服務管理」。</Alert>
      ) : null}
      {done ? <Alert tone="success">{done}</Alert> : null}
      <ApiErrorAlert error={error} />

      <section className="card section" aria-labelledby="dep-models-title">
        <h2 id="dep-models-title">模型</h2>
        {models.data.length === 0 ? (
          <Alert tone="info">
            這個專案還沒有訓練完成的模型。請先到<Link to="/training">建模管理</Link>訓練。
          </Alert>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label="可部署的模型">
              <thead>
                <tr>
                  <th scope="col">名稱</th>
                  <th scope="col">種類</th>
                  <th scope="col">建立</th>
                  {canTrain ? <th scope="col">操作</th> : null}
                </tr>
              </thead>
              <tbody>
                {models.data.map((m) => (
                  <tr key={m.id}>
                    <th scope="row">{m.name}</th>
                    <td>{KIND_NAMES[m.kind]}</td>
                    <td>
                      {m.created_by}，{formatTime(m.created_at)}
                    </td>
                    {canTrain ? (
                      <td className="row-actions">
                        <button type="button" className="btn btn--small btn--secondary" onClick={() => void act(() => downloadAndSave(() => api.downloadModel(m.id)))}>
                          下載模型「{m.name}」
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canTrain && models.data.length > 0 ? (
        <form ref={formRef} aria-label="分享給同事使用" className="card section stack" onSubmit={deploy} noValidate>
          <h2>分享給同事使用</h2>
          {prefilled ? <Alert tone="info">已選好剛訓練完成的模型「{selected?.name}」，請填要分享的同事帳號後按「分享給同事使用」。</Alert> : null}
          <p data-testid="share-explain">
            分享後，同事（例如 md01）登入平台，點左側「推論服務管理」，在模型清單找到「{selected?.name ?? '這個模型'}」（標示「分享給你」）按「選擇」，
            就能上傳病人資料（CSV）或選測試資料做預測。
          </p>
          <p className="field__hint">同一個專案中有「推論」權限的成員都看得到這個專案的模型；分享會把模型標示為「分享給你」，並允許資訊人員用程式呼叫。</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="dep-model">模型</label>
              <select id="dep-model" className="select" value={selected ? String(selected.id) : ''}
                onChange={(e) => {
                  const m = modelOf(Number(e.target.value));
                  setForm({ ...form, model: e.target.value, title: m ? suggestTitle(m.name) : form.title });
                }}>
                {models.data.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}（{KIND_NAMES[m.kind]}）
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="dep-title">顯示名稱（同事看到的名稱，可用中文）</label>
              <input id="dep-title" className="input" value={form.title} maxLength={128} placeholder={selected ? suggestTitle(selected.name) : ''}
                onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="dep-users">分享給（同事的帳號，以逗號分隔）</label>
              <input id="dep-users" className="input" value={form.users} placeholder="例如 md01" onChange={(e) => setForm({ ...form, users: e.target.value })} />
            </div>
          </div>
          <div className="row-actions">
            <button type="submit" className="btn btn--primary">
              分享給同事使用
            </button>
          </div>
        </form>
      ) : null}

      <TryPredict models={models.data} initial={wanted ?? undefined} />

      {canTrain ? (
        <section className="card section" aria-labelledby="dep-list-title">
          <h2 id="dep-list-title">已分享的模型</h2>
          <ApiErrorAlert error={deployments.error} />
          {deployments.data && deployments.data.length === 0 ? <p className="text-muted">還沒有分享任何模型。</p> : null}
          {deployments.data && deployments.data.length > 0 ? (
            <div className="table-wrap">
              <table className="table" aria-label="已分享的模型">
                <thead>
                  <tr>
                    <th scope="col">名稱</th>
                    <th scope="col">模型</th>
                    <th scope="col">分享給</th>
                    <th scope="col">建立</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {deployments.data.map((d) => (
                    <tr key={d.id}>
                      <th scope="row">{titleOf(d)}</th>
                      <td>{modelOf(d.model_id)?.name ?? `#${d.model_id}`}</td>
                      <td>
                        {d.allowed_users.join('、') || '（無）'}
                        {d.cannot_use_in_platform?.length ? (
                          <span className="field__hint">（{d.cannot_use_in_platform.join('、')} 不是本專案有推論權限的成員，平台上看不到）</span>
                        ) : null}
                      </td>
                      <td>
                        {d.created_by}，{formatTime(d.created_at)}
                      </td>
                      <td className="row-actions">
                        <button type="button" className="btn btn--small btn--secondary"
                          onClick={() => setEditing({ id: d.id, users: d.allowed_users.join(', ') })}>
                          修改分享對象「{titleOf(d)}」
                        </button>
                        <button type="button" className="btn btn--small btn--danger" onClick={() => setRemoving(d)}>
                          停止分享「{titleOf(d)}」
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {editing ? (
            <form aria-label="修改分享對象" onSubmit={saveAccess} className="stack" noValidate>
              <div className="field">
                <label htmlFor="dep-access">
                  「{titleOf(deployments.data?.find((d) => d.id === editing.id))}」分享給（同事的帳號，以逗號分隔）
                </label>
                <input id="dep-access" className="input" value={editing.users} onChange={(e) => setEditing({ ...editing, users: e.target.value })} />
              </div>
              <div className="row-actions">
                <button type="submit" className="btn btn--primary">
                  儲存分享對象
                </button>
                <button type="button" className="btn btn--secondary" onClick={() => setEditing(null)}>
                  取消
                </button>
              </div>
            </form>
          ) : null}
          {deployments.data && deployments.data.length > 0 ? (
            <details className="training-details" data-testid="it-details">
              <summary>給資訊人員：程式呼叫方式</summary>
              <div className="stack">
                <p className="text-muted">
                  每個分享都有一個程式呼叫端點，經 Gateway 呼叫；呼叫者以「分享給」名單中的帳號登入取得 Token，其他帳號會收到 403（拒絕）並留下稽核紀錄。
                </p>
                <div className="table-wrap">
                  <table className="table" aria-label="程式呼叫端點">
                    <thead>
                      <tr>
                        <th scope="col">名稱</th>
                        <th scope="col">技術名稱</th>
                        <th scope="col">呼叫端點</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deployments.data.map((d) => (
                        <tr key={d.id}>
                          <th scope="row">{titleOf(d)}</th>
                          <td>
                            <code>{d.name}</code>
                          </td>
                          <td className="training-endpoint">
                            <code>POST {d.endpoint}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <CallExample deployment={deployments.data[0]} model={modelOf(deployments.data[0].model_id)} />
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      {removing ? (
        <ConfirmDialog title="停止分享" confirmLabel="停止分享" onConfirm={undeploy} onCancel={() => setRemoving(null)}>
          確定要停止分享「{titleOf(removing)}」嗎？專案成員仍可在「推論服務管理」使用這個模型，但程式呼叫的端點會立即停止接受呼叫。
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

const titleOf = (d?: Deployment) => (d ? d.title || d.name : '');

function outsideNote(d: Deployment): string {
  return d.cannot_use_in_platform?.length
    ? `注意：${d.cannot_use_in_platform.join('、')} 不是本專案有推論權限的成員，登入後在「推論服務管理」看不到這個模型；需要時請專案負責人把他加入專案。`
    : '';
}

function sharedMessage(d: Deployment, model?: Model): string {
  const people = d.allowed_users.join('、');
  return `已把「${titleOf(d)}」分享給 ${people}。他們登入後點左側「推論服務管理」，選模型「${model?.name ?? titleOf(d)}」就能預測。` + outsideNote(d);
}

/** 呼叫方式範例：結構式送 JSON rows，影像以 multipart 上傳 files。 */
function CallExample({ deployment, model }: { deployment: Deployment; model?: Model }) {
  const image = model ? isImageModel(model.kind) : false;
  const features = model?.card.features ?? ['欄位名稱'];
  const example = image
    ? `curl -X POST "$GATEWAY${deployment.endpoint}" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -F "files=@IM0001.dcm"`
    : `curl -X POST "$GATEWAY${deployment.endpoint}" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ rows: [Object.fromEntries(features.map((f) => [f, '…']))] })}'`;
  return (
    <div className="stack">
      <h3>呼叫範例（{deployment.name}）</h3>
      <pre className="training-log" aria-label={`「${deployment.name}」的呼叫範例`}>{example}</pre>
    </div>
  );
}
