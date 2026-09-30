// AI 模型部署（B-06 部署）：模型清單與下載、線上部署（名稱、授權帳號）、呼叫端點、修改授權帳號、取消部署。
// 入口規則是 Prediction（看模型清單）；部署、下載模型、授權帳號的 API 需要 Training，沒有時只顯示清單與說明。
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { KIND_NAMES, isImageModel, type Model } from '../inference/api';
import { parseUsers, useTrainingApi, type Deployment, type TrainingApi } from '../training/api';
import { downloadAndSave, useHasPermission } from '../training/ModelExport';
import '../training/training.css';

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
  const [form, setForm] = useState({ model: '', name: '', users: '' });
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
    void act(async () => {
      const d = await api.deploy({ model_id: selected.id, name: form.name.trim(), allowed_users: parseUsers(form.users) });
      deployments.reload();
      setForm({ model: '', name: '', users: '' });
      return `已部署「${d.name}」：POST ${d.endpoint}`;
    });
  }

  function saveAccess(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    void act(async () => {
      const d = await api.setAccess(editing.id, parseUsers(editing.users));
      deployments.reload();
      setEditing(null);
      return `已更新「${d.name}」的授權帳號：${d.allowed_users.join('、') || '（無）'}`;
    });
  }

  function undeploy() {
    const target = removing;
    setRemoving(null);
    if (!target) return;
    void act(async () => {
      await api.undeploy(target.id);
      deployments.reload();
      return `已取消部署「${target.name}」，端點不再接受呼叫。`;
    });
  }

  return (
    <div className="stack">
      {!canTrain ? (
        <Alert tone="info">部署模型、下載模型與管理授權帳號需要 Training 權限；如需使用，請聯絡專案負責人或系統管理者。</Alert>
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
                  <th scope="col">格式</th>
                  <th scope="col">建立</th>
                  {canTrain ? <th scope="col">操作</th> : null}
                </tr>
              </thead>
              <tbody>
                {models.data.map((m) => (
                  <tr key={m.id}>
                    <th scope="row">{m.name}</th>
                    <td>{KIND_NAMES[m.kind]}</td>
                    <td>{m.format.toUpperCase()}</td>
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
        <form aria-label="部署模型" className="card section" onSubmit={deploy} noValidate>
          <h2>部署模型</h2>
          <p className="text-muted">部署後只有授權帳號可以經 Gateway 呼叫這個模型（不看專案角色）。其他帳號呼叫一律被拒絕並留下稽核紀錄。</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="dep-model">模型</label>
              <select id="dep-model" className="select" value={selected ? String(selected.id) : ''} onChange={(e) => setForm({ ...form, model: e.target.value })}>
                {models.data.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}（{KIND_NAMES[m.kind]}，{m.format.toUpperCase()}）
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="dep-name">部署名稱（小寫英數字與 -）</label>
              <input id="dep-name" className="input" value={form.name} maxLength={63} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="dep-users">授權帳號（以逗號分隔）</label>
              <input id="dep-users" className="input" value={form.users} onChange={(e) => setForm({ ...form, users: e.target.value })} />
            </div>
          </div>
          <div className="row-actions">
            <button type="submit" className="btn btn--primary">
              部署
            </button>
          </div>
        </form>
      ) : null}

      {canTrain ? (
        <section className="card section" aria-labelledby="dep-list-title">
          <h2 id="dep-list-title">線上部署</h2>
          <ApiErrorAlert error={deployments.error} />
          {deployments.data && deployments.data.length === 0 ? <p className="text-muted">還沒有線上部署。</p> : null}
          {deployments.data && deployments.data.length > 0 ? (
            <div className="table-wrap">
              <table className="table" aria-label="線上部署清單">
                <thead>
                  <tr>
                    <th scope="col">名稱</th>
                    <th scope="col">模型</th>
                    <th scope="col">呼叫端點</th>
                    <th scope="col">授權帳號</th>
                    <th scope="col">建立</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {deployments.data.map((d) => (
                    <tr key={d.id}>
                      <th scope="row">{d.name}</th>
                      <td>{modelOf(d.model_id)?.name ?? `#${d.model_id}`}</td>
                      <td className="training-endpoint">
                        <code>POST {d.endpoint}</code>
                      </td>
                      <td>{d.allowed_users.join('、') || '（無）'}</td>
                      <td>
                        {d.created_by}，{formatTime(d.created_at)}
                      </td>
                      <td className="row-actions">
                        <button type="button" className="btn btn--small btn--secondary"
                          onClick={() => setEditing({ id: d.id, users: d.allowed_users.join(', ') })}>
                          管理授權「{d.name}」
                        </button>
                        <button type="button" className="btn btn--small btn--danger" onClick={() => setRemoving(d)}>
                          取消部署「{d.name}」
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {editing ? (
            <form aria-label="修改授權帳號" onSubmit={saveAccess} className="stack" noValidate>
              <div className="field">
                <label htmlFor="dep-access">
                  「{deployments.data?.find((d) => d.id === editing.id)?.name}」的授權帳號（以逗號分隔）
                </label>
                <input id="dep-access" className="input" value={editing.users} onChange={(e) => setEditing({ ...editing, users: e.target.value })} />
              </div>
              <div className="row-actions">
                <button type="submit" className="btn btn--primary">
                  儲存授權帳號
                </button>
                <button type="button" className="btn btn--secondary" onClick={() => setEditing(null)}>
                  取消
                </button>
              </div>
            </form>
          ) : null}
          {deployments.data && deployments.data.length > 0 ? <CallExample deployment={deployments.data[0]} model={modelOf(deployments.data[0].model_id)} /> : null}
        </section>
      ) : null}

      {removing ? (
        <ConfirmDialog title="取消部署" confirmLabel="取消部署" onConfirm={undeploy} onCancel={() => setRemoving(null)}>
          確定要取消部署「{removing.name}」嗎？端點 <code>{removing.endpoint}</code> 會立即停止接受呼叫。
        </ConfirmDialog>
      ) : null}
    </div>
  );
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
      <h3>呼叫方式（{deployment.name}）</h3>
      <p className="text-muted">以授權帳號登入取得的 Token 經 Gateway 呼叫；未授權的帳號會收到 403。</p>
      <pre className="training-log" aria-label={`「${deployment.name}」的呼叫範例`}>{example}</pre>
    </div>
  );
}
