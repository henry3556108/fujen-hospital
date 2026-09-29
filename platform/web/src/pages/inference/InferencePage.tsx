// 推論服務管理（B-06）：選模型、批次或上傳檔案推論、檢視結果（結構式新增預測欄、影像顯示結果）、歷史與下載。
import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import {
  KIND_NAMES,
  isImageModel,
  useInferenceApi,
  type ImageResult,
  type InferenceApi,
  type InferenceRecord,
  type Model,
} from './api';
import './inference.css';

const MODES = { batch: '批次', upload: '上傳檔案', online: '線上服務' } as const;
const SUBSETS = [
  ['test', '測試資料'],
  ['validation', '驗證資料'],
  ['train', '訓練資料'],
  ['all', '全部資料'],
] as const;

export function InferencePage() {
  const inference = useInferenceApi();
  return (
    <>
      <h1>推論服務管理</h1>
      {inference ? (
        <Inference key={inference.projectId} inference={inference} />
      ) : (
        <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>
      )}
    </>
  );
}

function Inference({ inference }: { inference: InferenceApi }) {
  const models = useResource(() => inference.models(), [inference]);
  const [chosen, setChosen] = useState<number | null>(null);
  const model = models.data?.find((m) => m.id === chosen) ?? models.data?.[0] ?? null;

  if (models.error) return <ApiErrorAlert error={models.error} />;
  if (!models.data) return <p role="status">載入中…</p>;
  if (models.data.length === 0) return <Alert tone="info">這個專案還沒有訓練完成的模型。請先到「建模管理」訓練。</Alert>;
  return (
    <div className="stack">
      <section className="card section" aria-labelledby="models-title">
        <h2 id="models-title">模型</h2>
        <div className="table-wrap">
          <table className="table" aria-label="模型清單">
            <thead>
              <tr>
                <th scope="col">名稱</th>
                <th scope="col">種類</th>
                <th scope="col">格式</th>
                <th scope="col">建立者</th>
                <th scope="col">選擇</th>
              </tr>
            </thead>
            <tbody>
              {models.data.map((m) => (
                <tr key={m.id} aria-current={m.id === model?.id ? 'true' : undefined}>
                  <td>{m.name}</td>
                  <td>{KIND_NAMES[m.kind]}</td>
                  <td>{m.format.toUpperCase()}</td>
                  <td>{m.created_by}</td>
                  <td>
                    <button type="button" className="btn btn--small" onClick={() => setChosen(m.id)} disabled={m.id === model?.id}>
                      {m.id === model?.id ? '已選擇' : `選擇 ${m.name}`}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {model ? <ModelPanel key={model.id} inference={inference} model={model} /> : null}
    </div>
  );
}

function ModelPanel({ inference, model }: { inference: InferenceApi; model: Model }) {
  const history = useResource(() => inference.history(model.id), [inference, model.id]);
  const [result, setResult] = useState<InferenceRecord | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const image = isImageModel(model.kind);

  async function run(call: () => Promise<InferenceRecord>) {
    setBusy(true);
    setError(null);
    try {
      setResult(await call());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      history.reload();
    }
  }

  function batch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const subset = String(new FormData(e.currentTarget).get('subset') ?? 'test');
    void run(() => inference.batch(model.id, subset));
  }

  function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (files.length === 0) return setError(new Error('請先選擇檔案'));
    void run(() => inference.upload(model.id, files));
  }

  async function open(id: number) {
    setError(null);
    try {
      setResult(await inference.record(id));
    } catch (err) {
      setError(err);
    }
  }

  async function download(id: number) {
    try {
      const { blob, filename } = await inference.download(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <>
      <section className="card section" aria-labelledby="run-title">
        <h2 id="run-title">執行推論：{model.name}</h2>
        <p className="text-muted">
          {KIND_NAMES[model.kind]}模型。
          {image ? '上傳 DICOM、NIfTI、ITK（.mha）或 PNG 影像。' : '上傳 CSV；結果會在原始資料後面新增預測欄。'}
        </p>
        <ApiErrorAlert error={error} />
        <div className="inference-forms">
          <form aria-label="批次推論" onSubmit={batch} className="inference-form">
            <div className="field">
              <label htmlFor="batch-subset">資料範圍</label>
              <select id="batch-subset" name="subset" className="select" defaultValue="test">
                {SUBSETS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              批次推論
            </button>
          </form>
          <form aria-label="上傳檔案推論" onSubmit={upload} className="inference-form">
            <div className="field">
              <label htmlFor="upload-files">{image ? '影像檔' : 'CSV 檔'}</label>
              <input
                id="upload-files"
                type="file"
                className="input"
                multiple={image}
                accept={image ? '.dcm,.nii,.gz,.mha,.png,.npy' : '.csv,text/csv'}
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </div>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              上傳並推論
            </button>
          </form>
        </div>
        {busy ? <p role="status">推論中…</p> : null}
      </section>
      {result ? <ResultView record={result} size={model.card.input?.resize} onDownload={download} /> : null}
      <section className="card section" aria-labelledby="history-title">
        <h2 id="history-title">推論歷史</h2>
        <ApiErrorAlert error={history.error} />
        {history.data && history.data.length === 0 ? <p className="text-muted">還沒有推論紀錄。</p> : null}
        {history.data && history.data.length > 0 ? (
          <div className="table-wrap">
            <table className="table" aria-label="推論歷史">
              <thead>
                <tr>
                  <th scope="col">編號</th>
                  <th scope="col">方式</th>
                  <th scope="col">筆數</th>
                  <th scope="col">結果</th>
                  <th scope="col">使用者</th>
                  <th scope="col">時間</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((h) => (
                  <tr key={h.id}>
                    <td>#{h.id}</td>
                    <td>{MODES[h.mode]}</td>
                    <td>{h.count}</td>
                    <td>{h.status === 'succeeded' ? '成功' : `失敗：${h.message}`}</td>
                    <td>{h.user}</td>
                    <td>{new Date(h.created_at).toLocaleString('zh-TW')}</td>
                    <td className="inference-actions">
                      {h.has_result ? (
                        <>
                          <button type="button" className="btn btn--small" onClick={() => void open(h.id)}>
                            檢視 #{h.id}
                          </button>
                          <button type="button" className="btn btn--small" onClick={() => void download(h.id)}>
                            下載 #{h.id}
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}

function ResultView({ record, size, onDownload }: { record: InferenceRecord; size?: number[]; onDownload: (id: number) => void }) {
  const result = record.result;
  return (
    <section className="card section" aria-labelledby="result-title">
      <div className="inference-result-head">
        <h2 id="result-title">
          推論結果 #{record.id}（{record.count} 筆）
        </h2>
        <button type="button" className="btn" onClick={() => onDownload(record.id)}>
          下載結果
        </button>
      </div>
      {!result ? <Alert tone="error">{record.message || '這次推論沒有結果'}</Alert> : null}
      {result && 'columns' in result ? <TableResult result={result} /> : null}
      {result && 'results' in result && result.blocked?.length ? (
        <Alert tone="warning">
          {result.blocked.length} 個檔案未推論：{result.blocked.map((b) => `${b.name}（${b.reason}）`).join('、')}
        </Alert>
      ) : null}
      {result && 'results' in result ? <ImageResults results={result.results} size={size ?? [32, 32]} /> : null}
    </section>
  );
}

function TableResult({ result }: { result: { columns: string[]; rows: string[][]; prediction_column: string } }) {
  const at = result.columns.indexOf(result.prediction_column);
  return (
    <div className="table-wrap inference-table">
      <table className="table" aria-label="結構式推論結果">
        <thead>
          <tr>
            {result.columns.map((c, i) => (
              <th key={c} scope="col" className={i >= at ? 'inference-prediction' : undefined}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, r) => (
            <tr key={r}>
              {row.map((v, i) => (
                <td key={i} className={i >= at ? 'inference-prediction' : undefined}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 方框座標是模型輸入（Resize 後）的像素，換算成百分比疊在預覽圖上。 */
function ImageResults({ results, size }: { results: ImageResult[]; size: number[] }) {
  const [h, w] = size;
  return (
    <ul className="inference-grid" aria-label="影像推論結果">
      {results.map((r) => (
        <li key={`${r.name}#${r.slice}`} className="inference-card" data-testid="image-result">
          <figure>
            <div className="inference-preview">
              <img src={r.preview} alt={`${r.name} 切片 ${r.slice + 1}`} />
              {r.boxes?.map((b, i) => (
                <span
                  key={i}
                  className="inference-box"
                  title={`${b.label} ${b.score}`}
                  data-testid="result-box"
                  style={{
                    left: `${(b.bbox[0] / w) * 100}%`,
                    top: `${(b.bbox[1] / h) * 100}%`,
                    width: `${(b.bbox[2] / w) * 100}%`,
                    height: `${(b.bbox[3] / h) * 100}%`,
                  }}
                />
              ))}
            </div>
            <figcaption>
              <strong className="inference-name">{r.name}</strong>
              {r.slice > 0 ? <span className="text-muted">切片 {r.slice + 1}</span> : null}
              {r.label ? (
                <span data-testid="result-label">
                  分類：{r.label}（{Math.round((r.scores?.[r.label] ?? 0) * 100)}%）
                </span>
              ) : null}
              {r.boxes ? (
                <span data-testid="result-label">
                  偵測：{r.boxes.length === 0 ? '沒有找到物件' : r.boxes.map((b) => `${b.label} ${Math.round(b.score * 100)}%`).join('、')}
                </span>
              ) : null}
              {r.mask ? (
                <span data-testid="result-label">
                  分割：
                  {Object.entries(r.mask)
                    .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
                    .join('、')}
                </span>
              ) : null}
              {r.note ? <span className="text-muted">{r.note}</span> : null}
            </figcaption>
          </figure>
        </li>
      ))}
    </ul>
  );
}
