// 推論服務管理（B-06）：選模型、預測一位病人（結構式）、多位病人一起預測（資料集中的一群病人＝批次，或上傳 CSV／影像）、
// 檢視結果（結構式畫面上用中文欄名，有實際值時加「預測對／錯」）、預測紀錄與下載（下載的 CSV 欄名不變）。
// 從建模管理「用這個模型預測病人」進來（/inference?model=ID）時模型已選好。
// 批次預測在背景執行：送出後輪詢狀態，完成後顯示結果；排隊或執行中可以取消。上傳預測當場回結果。
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TryPredict } from '../deployment/TryPredict';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ModelName } from './ModelName';
import { percent, positiveChance, positiveLabel, positiveNote, sameLabel } from './positive';
import {
  KIND_NAMES,
  displayName,
  STATUS_NAMES,
  isFinished,
  isImageModel,
  useInferenceApi,
  waitForRecord,
  type ImageResult,
  type InferenceApi,
  type InferenceRecord,
  type Model,
} from './api';
import './inference.css';
import { FileInput } from '../../components/FileInput';

const MODES = { batch: '資料集中的多位（批次）', upload: '上傳檔案', online: '程式呼叫' } as const;

/** 預測紀錄的「方式」：網頁的單人試用（input.source = try）另外標示。 */
export function modeName(record: Pick<InferenceRecord, 'mode' | 'input'>): string {
  if (record.mode === 'upload' && record.input?.source === 'try') return '單人試用';
  return MODES[record.mode] ?? record.mode;
}
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
      <p className="page-subtitle">用模型預測病人</p>
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
  const [params] = useSearchParams();
  const [chosen, setChosen] = useState<number | null>(Number(params.get('model')) || null);
  // 預設選同事分享給我的模型（最新的一個），沒有時選第一個
  const sharedFirst = [...(models.data ?? [])].reverse().find((m) => m.shared_with_me);
  const model = models.data?.find((m) => m.id === chosen) ?? sharedFirst ?? models.data?.[0] ?? null;

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
                <th scope="col">建立者</th>
                <th scope="col">選擇</th>
              </tr>
            </thead>
            <tbody>
              {models.data.map((m) => (
                <tr key={m.id} aria-current={m.id === model?.id ? 'true' : undefined}>
                  <td>
                    <ModelName model={m} />
                    {m.shared_with_me ? <span className="badge status-badge status-badge--success inference-shared">{m.shared_by} 分享給你</span> : null}
                  </td>
                  <td>{KIND_NAMES[m.kind]}</td>
                  <td>{m.created_by}</td>
                  <td>
                    <button type="button" className="btn btn--small" onClick={() => setChosen(m.id)} disabled={m.id === model?.id}>
                      {m.id === model?.id ? '已選擇' : `選擇 ${displayName(m)}`}
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

/** part：使用模型頁的分頁只顯示「預測新資料」或「預測紀錄」；不給時全部顯示。 */
export function ModelPanel({ inference, model, part }: { inference: InferenceApi; model: Model; part?: 'predict' | 'history' }) {
  const predict = part !== 'history';
  const past = part !== 'predict';
  const history = useResource(() => inference.history(model.id), [inference, model.id]);
  const [result, setResult] = useState<InferenceRecord | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const watch = useRef<AbortController | null>(null);
  const image = isImageModel(model.kind);

  useEffect(() => () => watch.current?.abort(), []);

  /** 顯示一筆推論；還沒結束的批次推論持續輪詢到結束。 */
  function follow(record: InferenceRecord) {
    watch.current?.abort();
    setResult(record);
    if (isFinished(record.status)) return;
    const ctrl = new AbortController();
    watch.current = ctrl;
    waitForRecord(inference, record.id, { signal: ctrl.signal, onUpdate: setResult })
      .then((done) => {
        if (done) history.reload();
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setError(err);
      });
  }

  async function run(call: () => Promise<InferenceRecord>) {
    setBusy(true);
    setError(null);
    try {
      follow(await call());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      history.reload();
    }
  }

  async function cancel(id: number) {
    setError(null);
    try {
      const record = await inference.cancel(id);
      if (result?.id === id) {
        watch.current?.abort();
        setResult(record);
      }
    } catch (err) {
      setError(err);
    } finally {
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
      follow(await inference.record(id));
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

  const tabular = !image;
  return (
    <>
      {predict ? (<>
      <section className="card section stack" aria-labelledby="run-title">
        <h2 id="run-title">預測：{displayName(model)}</h2>
        <p className="text-muted">
          {KIND_NAMES[model.kind]}模型。
          {image ? '上傳 DICOM、NIfTI、ITK（.mha）或 PNG 影像，或選資料集中的一群影像一起預測。' : '可以預測一位病人，或多位病人一起預測。'}
        </p>
        <ApiErrorAlert error={error} />
      </section>
      {predict && tabular ? <TryPredict models={[model]} initial={model.id} fixed onDone={history.reload} /> : null}
      <section className="card section stack" aria-labelledby="many-title">
        <h2 id="many-title">{image ? '多張影像一起預測' : '多位病人一起預測'}</h2>
        <p className="field__hint">
          也叫「批次預測」：從訓練用的資料集選一群{image ? '影像' : '病人'}（例如測試資料，模型訓練時沒看過），或上傳自己的{image ? '影像檔' : ' CSV 檔（一列一位病人）'}。
          {tabular ? '資料裡有實際結果時，結果表會多一欄「預測對／錯」。' : ''}
        </p>
        <div className="inference-forms">
          <form aria-label={image ? '多張影像一起預測' : '多位病人一起預測'} onSubmit={batch} className="inference-form">
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
            {/* 每頁只有一個實心主要按鈕（03 規格 4.1）：主要動作是「上傳並預測」 */}
            <button type="submit" className="btn btn--secondary" disabled={busy}>
              {image ? '多張影像一起預測' : '多位病人一起預測'}
            </button>
          </form>
          <form aria-label={image ? '上傳影像預測' : '上傳 CSV 預測'} onSubmit={upload} className="inference-form">
            <div className="field">
              <label htmlFor="upload-files">{image ? '影像檔' : 'CSV 檔'}</label>
              <FileInput
                id="upload-files"
                multiple={image}
                accept={image ? '.dcm,.nii,.gz,.mha,.png,.npy' : '.csv,text/csv'}
                onFiles={setFiles}
                fileNames={files.map((f) => f.name)}
              />
            </div>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              上傳並預測
            </button>
          </form>
        </div>
        {busy ? <p role="status">預測中…</p> : null}
      </section>
      </>) : null}
      {!predict && error ? <ApiErrorAlert error={error} /> : null}
      {result ? (
        <ResultView record={result} model={model} onDownload={download} onCancel={cancel} />
      ) : null}
      {past ? (
      <section className="card section" aria-labelledby="history-title">
        <h2 id="history-title">預測紀錄：{displayName(model)}</h2>
        <ApiErrorAlert error={history.error} />
        {history.data && history.data.length === 0 ? <p className="text-muted">還沒有預測紀錄。</p> : null}
        {history.data && history.data.length > 0 ? (
          <div className="table-wrap">
            <table className="table" aria-label="預測紀錄">
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
                    <td>{modeName(h)}</td>
                    <td>{h.count}</td>
                    <td>{h.status === 'failed' ? `失敗：${h.message}` : STATUS_NAMES[h.status]}</td>
                    <td>{h.user}</td>
                    <td>{new Date(h.created_at).toLocaleString('zh-TW')}</td>
                    <td className="inference-actions">
                      {!isFinished(h.status) ? (
                        <>
                          <button type="button" className="btn btn--small" onClick={() => void open(h.id)}>
                            檢視 #{h.id}
                          </button>
                          <button type="button" className="btn btn--small" onClick={() => void cancel(h.id)}>
                            取消 #{h.id}
                          </button>
                        </>
                      ) : null}
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
      ) : null}
    </>
  );
}

function ResultView({
  record,
  model,
  onDownload,
  onCancel,
}: {
  record: InferenceRecord;
  model: Model;
  onDownload: (id: number) => void;
  onCancel: (id: number) => void;
}) {
  const result = record.result;
  const size = model.card.input?.resize;
  const pending = !isFinished(record.status);
  return (
    <section className="card section" aria-labelledby="result-title">
      <div className="inference-result-head">
        <h2 id="result-title">
          預測結果 #{record.id}（{record.count} 筆）：{displayName(model)}
        </h2>
        {pending ? (
          <button type="button" className="btn" onClick={() => onCancel(record.id)}>
            取消預測
          </button>
        ) : null}
        {record.has_result ? (
          <button type="button" className="btn" onClick={() => onDownload(record.id)}>
            下載結果
          </button>
        ) : null}
      </div>
      {pending ? (
        <p role="status" data-testid="batch-status">
          批次預測{STATUS_NAMES[record.status]}…在背景執行，完成後自動顯示結果；離開此頁也不影響，可稍後在預測紀錄查看。
        </p>
      ) : null}
      {record.status === 'cancelled' ? <Alert tone="info">{record.message || '這次預測已取消'}</Alert> : null}
      {!pending && record.status !== 'cancelled' && !result ? (
        <Alert tone="error">{record.message || '這次預測沒有結果'}</Alert>
      ) : null}
      {result && 'columns' in result ? <TableResult result={result} model={model} /> : null}
      {result && 'results' in result && result.blocked?.length ? (
        <Alert tone="warning">
          {result.blocked.length} 個檔案未預測：{result.blocked.map((b) => `${b.name}（${b.reason}）`).join('、')}
        </Alert>
      ) : null}
      {result && 'results' in result ? <ImageResults results={result.results} size={size ?? [32, 32]} /> : null}
    </section>
  );
}

/** 結構式推論的一句話摘要：幾位有預測、幾位補過缺值、幾位無法預測與原因。 */
export function tableSummary(result: { columns: string[]; rows: string[][]; prediction_column: string }): string {
  const at = result.columns.indexOf(result.prediction_column);
  const noteAt = result.columns.indexOf(`${result.prediction_column}_note`);
  const missing = result.rows.filter((r) => (r[at] ?? '') === '');
  const filled = result.rows.filter((r) => (r[at] ?? '') !== '' && noteAt >= 0 && (r[noteAt] ?? '').includes('缺值，已用訓練資料'));
  let text = `共 ${result.rows.length} 位，${result.rows.length - missing.length} 位有預測結果。`;
  if (filled.length) text += `其中 ${filled.length} 位有缺值，已用訓練資料的中位數或最常見的值補上後預測。`;
  if (missing.length) {
    const reasons = [...new Set(missing.map((r) => (noteAt >= 0 ? r[noteAt] : '') || '無法預測'))];
    text += `${missing.length} 位無法預測（${reasons.join('、')}）。`;
  }
  return text;
}

type Table = { columns: string[]; rows: string[][]; prediction_column: string; positive_label?: string | null };


/** 結構式分類而且資料裡有實際結果欄（例如測試資料的 diagnosis）時，每一列預測對不對；不能對照時為 null。 */
export function correctness(result: Table, model: Pick<Model, 'kind' | 'card'>): { column: string; marks: ('對' | '錯' | '')[]; right: number; total: number } | null {
  const target = model.card.target;
  if (model.kind !== 'tabular_classification' || !target) return null;
  const actual = result.columns.indexOf(target);
  const at = result.columns.indexOf(result.prediction_column);
  if (actual < 0 || at < 0 || actual >= at) return null;
  const marks = result.rows.map((r) => ((r[at] ?? '') === '' || (r[actual] ?? '') === '' ? '' : sameLabel(r[actual], r[at]) ? '對' : '錯'));
  const total = marks.filter((m) => m !== '').length;
  return { column: target, marks, right: marks.filter((m) => m === '對').length, total };
}

/**
 * 結果表的欄位順序：病歷號（第一欄）、實際值、預測結果、機率、預測對／錯、說明，其餘輸入欄位放後面。
 * 二元分類的機率欄是陽性類別的機率（表頭「diagnosis＝1 的機率」）；多類別是「預測類別的機率」。
 * 下載的 CSV 仍用英文欄名（prediction、prediction_positive_probability、prediction_probability、prediction_note），
 * 外部程式與驗收測試依賴這些名稱。
 */
type Shown = { key: string; head: string; important: boolean; value: (row: string[], r: number) => string };

export function tableColumns(result: Table, model: Model): Shown[] {
  const p = result.prediction_column;
  const at = result.columns.indexOf(p);
  const target = model.card.target;
  const check = correctness(result, model);
  const positive = positiveLabel(model, result);
  const raw = (i: number) => (row: string[]) => row[i] ?? '';
  const prob = result.columns.indexOf(`${p}_probability`);
  const noteAt = result.columns.indexOf(`${p}_note`);
  const added = new Set([p, `${p}_probability`, `${p}_positive_probability`, `${p}_note`]);
  const chance = (row: string[]) => (positive !== null ? positiveChance(row, result.columns, p, positive) : null);
  const actual = check ? result.columns.indexOf(check.column) : -1;
  const lead = [0, ...(actual > 0 ? [actual] : [])].filter((i) => i < at && !added.has(result.columns[i]));
  const out: Shown[] = lead.map((i) => ({ key: `lead${i}`, head: result.columns[i] === target ? `${result.columns[i]}（實際）` : result.columns[i], important: false, value: raw(i) }));
  out.push({ key: 'prediction', head: '預測結果', important: true, value: raw(at) });
  if (prob >= 0) {
    out.push(positive !== null && target
      ? { key: 'positive', head: `${target}＝${positive} 的機率`, important: true, value: (row) => { const c = chance(row); return c === null ? '' : percent(c); } }
      : { key: 'probability', head: '預測類別的機率', important: true, value: (row) => (row[prob] && !Number.isNaN(Number(row[prob])) ? percent(Number(row[prob])) : row[prob] ?? '') });
  }
  if (check) out.push({ key: 'check', head: '預測對／錯', important: true, value: (_, r) => check.marks[r] || '—' });
  if (noteAt >= 0) {
    out.push({ key: 'note', head: '說明', important: true,
      value: (row) => (positive !== null && target ? positiveNote(row[noteAt] ?? '', target, positive, chance(row)) : row[noteAt] ?? '') });
  }
  result.columns.forEach((c, i) => {
    if (!lead.includes(i) && !added.has(c)) out.push({ key: `c${i}`, head: c, important: false, value: raw(i) });
  });
  return out;
}

function TableResult({ result, model }: { result: Table; model: Model }) {
  const check = correctness(result, model);
  const shown = tableColumns(result, model);
  const positive = positiveLabel(model, result);
  const p = result.prediction_column;
  // 輸入的欄位放在重要欄位後面；表格比畫面寬時說出右側還有哪些欄位（使用性測試：右側被切掉卻不知道）
  const inputs = shown.filter((c) => c.key.startsWith('c') && c.key !== 'check').map((c) => c.head);
  const wrap = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [result]);
  const names = [`${p}（預測結果）`, ...(positive !== null && model.card.target ? [`${p}_positive_probability（${model.card.target}＝${positive} 的機率）`] : []),
    ...(result.columns.includes(`${p}_probability`) ? [`${p}_probability（預測類別的機率）`] : []), `${p}_note（說明）`];
  return (
    <>
      <p data-testid="table-summary">{tableSummary(result)}</p>
      {check && check.total ? (
        <p data-testid="table-correct">
          <strong>
            有實際的 {check.column} 可以對照：{check.total} 位中預測對 {check.right} 位（{Math.round((check.right / check.total) * 100)}%）。
          </strong>
        </p>
      ) : null}
      <p className="field__hint">畫面上的欄名是中文；下載的 CSV 保留英文欄名：{names.join('、')}，方便其他程式讀取。</p>
      {overflow && inputs.length ? (
        <p className="field__hint" data-testid="table-more-columns">
          右側還有 {inputs.length} 欄輸入的資料（{inputs.slice(0, 5).join('、')}{inputs.length > 5 ? ' 等' : ''}），可在表格內左右捲動查看；「下載結果」有完整內容。
        </p>
      ) : null}
      <div className="table-wrap inference-table" ref={wrap}>
        <table className="table" aria-label="預測結果">
          <thead>
            <tr>
              {shown.map((c) => (
                <th key={c.key} scope="col" className={c.important ? 'inference-prediction' : undefined}>
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, r) => (
              <tr key={r}>
                {shown.map((c) => (
                  <td key={c.key} className={[c.important ? 'inference-prediction' : '', c.key === 'note' ? 'inference-note' : ''].filter(Boolean).join(' ') || undefined}>
                    {c.value(row, r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
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
