// 影像標註首頁：研究清單（含標註數）、CSV 自動分類標註、標註後直接訓練。
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { useLabelingApi, type LabelingApi, type TrainingJob } from './api';
import { formatDate } from './parts';
import { KIND_LABELS, type AnnotationKind, type CsvKey, type CsvResult, type CsvRowStatus, type LabelSummary } from './types';
import './labeling.css';
import { FileInput } from '../../components/FileInput';

const STATUS_LABELS: Record<CsvRowStatus, string> = {
  matched: '已標註',
  unmatched: '找不到研究',
  conflict: '診斷衝突',
  invalid: '資料不完整',
};

export function LabelingPage() {
  const labeling = useLabelingApi();
  if (!labeling) {
    return (
      <>
        <h1>影像標註</h1>
        <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>
      </>
    );
  }
  return <Labeling key={labeling.projectId} labeling={labeling} />;
}

function Labeling({ labeling }: { labeling: LabelingApi }) {
  const { project } = useSession();
  const summary = useResource(() => labeling.summary(), [labeling]);
  const data = summary.data;
  return (
    <>
      <h1>影像標註</h1>
      <p className="text-muted">
        專案：<strong>{project?.name}</strong>。選一個研究開啟標註工作台；也可以用 CSV 診斷結果一次完成分類標註。
      </p>
      <ApiErrorAlert error={summary.error} />
      {data ? (
        <p data-testid="label-totals">
          共 {data.studies.length} 個研究、{data.total} 筆標註（分類 {data.by_kind.classification}、分割 {data.by_kind.segmentation}、偵測{' '}
          {data.by_kind.detection}），已評分 {data.rated} 筆。
        </p>
      ) : null}

      <section className="section" aria-labelledby="studies-title">
        <h2 id="studies-title">研究清單</h2>
        {summary.loading && !data ? (
          <p role="status" className="loading">
            載入中…
          </p>
        ) : data && data.studies.length === 0 ? (
          <Alert tone="info">這個專案還沒有影像。請先到「數據管理」匯入影像。</Alert>
        ) : data ? (
          <div className="table-wrap">
            <table aria-label="研究清單">
              <thead>
                <tr>
                  <th scope="col">影像編號</th>
                  <th scope="col">病歷號</th>
                  <th scope="col">檢查日期</th>
                  <th scope="col">檢查說明</th>
                  <th scope="col">分類</th>
                  <th scope="col">分割</th>
                  <th scope="col">偵測</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.studies.map((s) => (
                  <tr key={s.study_instance_uid} data-study={s.study_instance_uid}>
                    <th scope="row">{s.accession_number || '（無）'}</th>
                    <td>{s.patient_id}</td>
                    <td>{formatDate(s.study_date)}</td>
                    <td>{s.study_description}</td>
                    <td>{s.by_kind.classification}</td>
                    <td>{s.by_kind.segmentation}</td>
                    <td>{s.by_kind.detection}</td>
                    <td>
                      <Link to={`/labeling/studies/${s.study_instance_uid}`} aria-label={`開啟 ${s.accession_number || s.study_instance_uid} 的標註工作台`}>
                        開啟標註
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <CsvPanel labeling={labeling} onDone={summary.reload} />
      <TrainingPanel labeling={labeling} summary={data} />
    </>
  );
}

function CsvPanel({ labeling, onDone }: { labeling: LabelingApi; onDone: () => void }) {
  const [key, setKey] = useState<CsvKey>('patient_id');
  const [result, setResult] = useState<CsvResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = fileRef.current?.files?.[0];
    if (!file || file.size === 0) {
      setError(new Error('請先選擇 CSV 檔'));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const keyColumn = String(form.get('key_column') ?? '').trim();
      const labelColumn = String(form.get('label_column') ?? '').trim();
      setResult(await labeling.classifyCsv(file, key, keyColumn || undefined, labelColumn || undefined));
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const problems = result?.results.filter((r) => r.status !== 'matched') ?? [];
  return (
    <section className="card section" aria-labelledby="csv-title">
      <h2 id="csv-title">以 CSV 診斷結果自動分類標註</h2>
      <p className="text-muted">
        CSV 第一列是欄名，需有一個鍵欄（病歷號或影像編號）與一個診斷欄（diagnosis、診斷、診斷結果）。每個對到的研究會得到一筆研究層級的分類標註；重新上傳會更新，不會重複。
      </p>
      <ApiErrorAlert error={error} />
      <form aria-label="CSV 自動分類標註" onSubmit={submit} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="csv-file">CSV 檔（必填）</label>
            <FileInput id="csv-file" ref={fileRef} name="file" accept=".csv,text/csv" aria-required="true" onFiles={() => undefined} />
          </div>
          <div className="field">
            <label htmlFor="csv-key">對齊依據</label>
            <select id="csv-key" className="select" value={key} onChange={(e) => setKey(e.target.value as CsvKey)}>
              <option value="patient_id">病歷號（Patient ID）</option>
              <option value="accession_number">影像編號（Accession Number）</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="csv-key-column">鍵欄名稱</label>
            <input id="csv-key-column" name="key_column" className="input" aria-describedby="csv-key-column-hint" />
            <span id="csv-key-column-hint" className="field__hint">
              留空則自動辨識
            </span>
          </div>
          <div className="field">
            <label htmlFor="csv-label-column">診斷欄名稱</label>
            <input id="csv-label-column" name="label_column" className="input" aria-describedby="csv-label-column-hint" />
            <span id="csv-label-column-hint" className="field__hint">
              留空則自動辨識
            </span>
          </div>
        </div>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? '處理中…' : '上傳並標註'}
        </button>
      </form>
      {result ? (
        <div className="stack" data-testid="csv-result">
          <Alert tone={problems.length === 0 ? 'success' : 'warning'}>
            共 {result.rows} 列：已標註 {result.matched} 列（{result.annotated_studies} 個研究；新增 {result.created}、更新 {result.updated}、未變動{' '}
            {result.unchanged}），找不到研究 {result.unmatched} 列，診斷衝突 {result.conflict} 列，資料不完整 {result.invalid} 列。
          </Alert>
          {problems.length > 0 ? (
            <div className="table-wrap">
              <table aria-label="未標註的資料列">
                <thead>
                  <tr>
                    <th scope="col">行號</th>
                    <th scope="col">鍵值</th>
                    <th scope="col">診斷</th>
                    <th scope="col">狀態</th>
                    <th scope="col">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {problems.map((r) => (
                    <tr key={r.row}>
                      <th scope="row">{r.row}</th>
                      <td>{r.key || '（空白）'}</td>
                      <td>{r.label || '（空白）'}</td>
                      <td>{STATUS_LABELS[r.status]}</td>
                      <td>{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function TrainingPanel({ labeling, summary }: { labeling: LabelingApi; summary: LabelSummary | null }) {
  const { project } = useSession();
  const canTrain = project?.permissions.includes('training') ?? false;
  const [type, setType] = useState<AnnotationKind>('classification');
  const [jobs, setJobs] = useState<TrainingJob[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const available = Object.keys(summary?.labels[type] ?? {});
  const count = summary?.by_kind[type] ?? 0;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const labels = form.getAll('labels').map(String);
    const resize = Number(form.get('resize'));
    const validation = Number(form.get('validation'));
    const test = Number(form.get('test'));
    const seed = Number(form.get('seed'));
    if (labels.length === 0) return setError(new Error('請至少選一個 Label'));
    if (!Number.isInteger(resize) || resize < 16 || resize > 1024) return setError(new Error('Resize 必須是 16 到 1024 的整數'));
    if (!(validation >= 0 && test >= 0 && validation + test < 100)) return setError(new Error('驗證與測試比例合計必須小於 100%'));
    if (!Number.isInteger(seed) || seed < 0) return setError(new Error('隨機種子必須是 0 以上的整數'));
    setBusy(true);
    setError(null);
    try {
      const job = await labeling.train({
        trainingType: type,
        labels,
        resize,
        validationSplit: validation / 100,
        testSplit: test / 100,
        seed,
      });
      setJobs((list) => [...list, job]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card section" id="training" aria-labelledby="training-title">
      <h2 id="training-title">標註後直接訓練</h2>
      {!canTrain ? (
        <Alert tone="info">建立訓練任務需要 Training 權限；如需使用，請聯絡專案負責人或系統管理者。</Alert>
      ) : (
        <>
          <p className="text-muted">選訓練型態與參數後送出，不需要寫程式。任務會進入專案綁定的 GPU 群組排隊，進度在「建模管理」查看。</p>
          <ApiErrorAlert error={error} />
          <form aria-label="建立訓練任務" onSubmit={submit} noValidate key={type}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="train-type">訓練型態</label>
                <select id="train-type" className="select" value={type} onChange={(e) => setType(e.target.value as AnnotationKind)}>
                  <option value="classification">影像分類</option>
                  <option value="segmentation">影像分割</option>
                  <option value="detection">物件偵測</option>
                </select>
                <span className="field__hint">
                  目前有 {count} 筆{KIND_LABELS[type]}標註
                </span>
              </div>
              <div className="field">
                <label htmlFor="train-resize">Resize（像素）</label>
                <input id="train-resize" name="resize" className="input" type="number" min={16} max={1024} step={1} defaultValue={224} />
              </div>
              <div className="field">
                <label htmlFor="train-validation">驗證資料比例（%）</label>
                <input id="train-validation" name="validation" className="input" type="number" min={0} max={90} step={1} defaultValue={20} />
              </div>
              <div className="field">
                <label htmlFor="train-test">測試資料比例（%）</label>
                <input id="train-test" name="test" className="input" type="number" min={0} max={90} step={1} defaultValue={10} />
              </div>
              <div className="field">
                <label htmlFor="train-seed">隨機種子</label>
                <input id="train-seed" name="seed" className="input" type="number" min={0} step={1} defaultValue={42} />
              </div>
            </div>
            <fieldset className="field">
              <legend>Label</legend>
              {available.length === 0 ? (
                <span className="field__hint">還沒有{KIND_LABELS[type]}標註，請先標註。</span>
              ) : (
                available.map((l) => (
                  <label key={l} className="checkbox-row">
                    <input type="checkbox" className="checkbox" name="labels" value={l} defaultChecked />
                    {l}（{summary?.labels[type][l]} 筆）
                  </label>
                ))
              )}
            </fieldset>
            <button type="submit" className="btn btn--primary" disabled={busy || available.length === 0}>
              {busy ? '建立中…' : '建立訓練任務'}
            </button>
          </form>
          {jobs.length > 0 ? (
            <div className="table-wrap section">
              <table aria-label="已建立的訓練任務">
                <thead>
                  <tr>
                    <th scope="col">任務編號</th>
                    <th scope="col">狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id}>
                      <th scope="row">#{j.id}</th>
                      <td>{j.status === 'queued' ? '排隊中' : j.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
