// 試呼叫：以目前登入的帳號經 Gateway 呼叫已分享模型的程式呼叫端點（POST /api/inference/{name}/predict），
// 看回應長什麼樣子。授權與稽核和程式呼叫完全相同：不在分享對象中的帳號會收到 403，並留下拒絕的稽核紀錄。
import { useState, type FormEvent } from 'react';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { FileInput } from '../../components/FileInput';
import type { Model } from '../inference/api';
import type { Deployment, OnlinePrediction, TrainingApi } from '../training/api';

const titleOf = (d: Deployment) => d.title || d.name;
const isImage = (d: Deployment, model?: Model) => (d.model_kind ?? model?.kind ?? '').startsWith('image_');

/** 結構式模型的範例輸入：模型的每個特徵一欄，值留空讓使用者填。 */
export function sampleRows(model?: Model): string {
  const names = model?.card.inputs?.map((i) => i.name) ?? model?.card.features ?? ['欄位名稱'];
  return JSON.stringify({ rows: [Object.fromEntries(names.map((n) => [n, null]))] }, null, 2);
}

/** 解析輸入的 JSON；格式不對時丟出看得懂的錯誤。 */
export function parseRows(text: string): { rows: Record<string, unknown>[] } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('輸入不是有效的 JSON，請檢查括號與引號');
  }
  const rows = (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || !rows.length || !rows.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    throw new Error('請以 {"rows": [{欄位: 值}, …]} 的格式輸入，至少一筆');
  }
  return { rows: rows as Record<string, unknown>[] };
}

export function TryCall({ api, deployments, modelOf }: { api: TrainingApi; deployments: Deployment[]; modelOf: (id: number) => Model | undefined }) {
  const { me } = useSession();
  const [selectedId, setSelectedId] = useState(deployments[0]?.id ?? 0);
  const deployment = deployments.find((d) => d.id === selectedId) ?? deployments[0];
  const model = deployment ? modelOf(deployment.model_id) : undefined;
  const [text, setText] = useState(() => sampleRows(model));
  const [files, setFiles] = useState<File[]>([]);
  const [reply, setReply] = useState<OnlinePrediction | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!deployment) return null;
  const image = isImage(deployment, model);
  const allowed = !!me && deployment.allowed_users.includes(me.username);

  function choose(id: number) {
    const next = deployments.find((d) => d.id === id);
    setSelectedId(id);
    setText(sampleRows(next ? modelOf(next.model_id) : undefined));
    setFiles([]);
    setReply(null);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setReply(null);
    setBusy(true);
    try {
      if (image && !files.length) throw new Error('請選擇至少一個影像檔');
      setReply(await api.callDeployment(deployment.endpoint, image ? files : parseRows(text)));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="試呼叫" className="stack" onSubmit={submit} noValidate>
      <h3>試呼叫</h3>
      <p className="text-muted">
        以你目前登入的帳號呼叫上面的端點，和資訊人員用程式呼叫完全相同（也會留下稽核紀錄、記在預測紀錄）。只有「分享給」名單中的帳號會成功。
      </p>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="call-deployment">要呼叫的分享</label>
          <select id="call-deployment" className="select" value={String(deployment.id)} onChange={(e) => choose(Number(e.target.value))}>
            {deployments.map((d) => (
              <option key={d.id} value={d.id}>
                {titleOf(d)}（{d.name}）
              </option>
            ))}
          </select>
        </div>
      </div>
      {allowed ? null : (
        <Alert tone="warning">
          你（{me?.username}）不在「{titleOf(deployment)}」的分享對象中，呼叫會被拒絕（403）。要試呼叫，請先在「修改分享對象」把自己加入。
        </Alert>
      )}
      {image ? (
        <div className="field">
          <label htmlFor="call-files">影像檔（DICOM、PNG、NIfTI…，可選多個）</label>
          <FileInput id="call-files" multiple onFiles={setFiles} />
        </div>
      ) : (
        <div className="field">
          <label htmlFor="call-body">送出的 JSON</label>
          <textarea id="call-body" className="input training-log" rows={6} value={text} spellCheck={false}
            onChange={(e) => setText(e.target.value)} />
          <span className="field__hint">把 null 換成病人的數值；可以放多筆，一次最多 1000 筆。</span>
        </div>
      )}
      <ApiErrorAlert error={error} />
      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? '呼叫中…' : `送出試呼叫（POST ${deployment.endpoint}）`}
        </button>
      </div>
      {reply ? (
        <div className="stack">
          <Alert tone="success">呼叫成功（推論紀錄 #{reply.inference_id}）。</Alert>
          <pre className="training-log" aria-label="試呼叫的回應">{JSON.stringify(reply, null, 2)}</pre>
        </div>
      ) : null}
    </form>
  );
}
