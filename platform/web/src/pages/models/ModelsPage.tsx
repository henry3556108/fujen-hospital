// 使用模型（B-06）：合併原「AI 模型部署」與「推論服務管理」。模型清單（已完成的訓練＝模型）→ 單一模型五個分頁：
// 結果、預測新資料、預測紀錄、分享與服務、下載。網址用訓練編號（/models/:runId/...）。
// 模型清單與預測只需要 Prediction；結果的完整內容、分享、下載模型檔另需 Training（API 的規則）。
import { useState } from 'react';
import { Link, NavLink, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { LineChart } from '../../components/charts/LineChart';
import { formatTime } from '../../components/format';
import { SharePanel } from '../deployment/DeploymentPage';
import { KIND_NAMES, displayName, useInferenceApi, type InferenceApi, type Model } from '../inference/api';
import { ModelPanel } from '../inference/InferencePage';
import { ModelName } from '../inference/ModelName';
import { useTrainingApi, type TrainingApi, type TrainingRun } from '../training/api';
import { downloadAndSave, useHasPermission } from '../training/ModelExport';
import { primaryScore, primaryText } from '../training/metrics';
import { ResultView } from '../training/ResultView';
import { FEW_TESTS, dataVersionText, keyMetrics, sameTestData, testCount } from './keyMetrics';
import '../training/training.css';
import '../inference/inference.css';

export type ModelTab = 'result' | 'predict' | 'history' | 'share' | 'download';

const TABS: { tab: ModelTab; label: string }[] = [
  { tab: 'result', label: '結果' },
  { tab: 'predict', label: '預測新資料' },
  { tab: 'history', label: '預測紀錄' },
  { tab: 'share', label: '分享與服務' },
  { tab: 'download', label: '下載' },
];

/** 從契約入口（/deployment、/inference）轉來時的一行說明。 */
export const ENTRY_NOTES: Record<string, string> = {
  deployment: '「AI 模型部署」已併入這裡：打開模型後在「分享與服務」分享給同事、設定授權、查看 API 端點與試呼叫；「下載」可取得模型檔。',
  inference: '「推論服務管理」已併入這裡：打開模型後在「預測新資料」用測試資料或上傳新檔預測，「預測紀錄」可查看與下載過去的結果。',
};

const modelHref = (m: Model, tab: ModelTab = 'result') => (m.run_id ? `/models/${m.run_id}/${tab}` : null);

/** 模型清單。 */
export function ModelListPage() {
  const inference = useInferenceApi();
  const [params] = useSearchParams();
  const entry = params.get('entry');
  return (
    <>
      <h1>使用模型</h1>
      {entry && ENTRY_NOTES[entry] ? (
        <p className="text-muted" data-testid="entry-note">
          {ENTRY_NOTES[entry]}
        </p>
      ) : null}
      {inference ? <ModelList key={inference.projectId} inference={inference} /> : <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>}
    </>
  );
}

function ModelList({ inference }: { inference: InferenceApi }) {
  const models = useResource(() => inference.models(), [inference]);
  const canTrain = useHasPermission('training');
  const [params] = useSearchParams();
  const wanted = Number(params.get('model')) || null;
  if (models.error) return <ApiErrorAlert error={models.error} />;
  if (!models.data) return <p role="status">載入中…</p>;
  // 舊連結 /inference?model=ID、/deployment?model=ID：直接打開那個模型的對應分頁
  const legacy = wanted ? models.data.find((m) => m.id === wanted) : null;
  if (legacy?.run_id) return <Navigate to={`/models/${legacy.run_id}/${params.get('entry') === 'deployment' ? 'share' : 'predict'}`} replace />;
  if (models.data.length === 0) {
    return (
      <Alert tone="info">
        這個專案還沒有訓練完成的模型。{canTrain ? <Link to="/training/new">建立訓練</Link> : '請請有訓練權限的成員建立訓練'}，完成後會出現在這裡。
      </Alert>
    );
  }
  const list = [...models.data].sort((a, b) => b.id - a.id);
  return (
    <section className="card section" aria-labelledby="models-title">
      <h2 id="models-title">模型清單</h2>
      <p className="text-muted">每一次完成的訓練就是一個模型。</p>
      <div className="table-wrap">
        <table className="table" aria-label="模型清單">
          <thead>
            <tr>
              <th scope="col">名稱</th>
              <th scope="col">任務</th>
              <th scope="col">版本</th>
              <th scope="col">主要指標</th>
              <th scope="col">完成時間</th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => {
              const href = modelHref(m);
              // 主要指標與首頁、訓練紀錄、單次訓練共用同一個判定（03 規格 3.5）
              const main = primaryScore({ kind: m.kind, metrics: m.card.metrics });
              return (
                <tr key={m.id}>
                  <th scope="row">
                    {href ? (
                      <Link to={href}>
                        <ModelName model={m} />
                      </Link>
                    ) : (
                      <ModelName model={m} />
                    )}
                    {m.shared_with_me ? <span className="badge status-badge status-badge--success inference-shared">{m.shared_by} 分享給你</span> : null}
                  </th>
                  <td>{KIND_NAMES[m.kind]}</td>
                  <td>{m.run_id ? `訓練 #${m.run_id}` : '—'}</td>
                  <td>{main ? primaryText(main.name, main.value) : '—'}</td>
                  <td>{formatTime(m.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 單一模型：標題、五個分頁與目前分頁的內容。 */
export function ModelPage({ tab }: { tab: ModelTab }) {
  const inference = useInferenceApi();
  const { runId } = useParams();
  const id = Number(runId);
  const models = useResource(() => (inference ? inference.models() : Promise.resolve([] as Model[])), [inference]);
  if (!inference) return <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>;
  if (models.error) return <ApiErrorAlert error={models.error} />;
  if (!models.data) return <p role="status">載入中…</p>;
  const model = models.data.find((m) => m.run_id === id);
  if (!model) {
    return (
      <>
        <h1>使用模型</h1>
        <Alert tone="info">
          找不到訓練 #{runId} 的模型（可能還沒完成或已刪除）。<Link to="/models">回模型清單</Link>
        </Alert>
      </>
    );
  }
  return (
    <>
      <p>
        <Link to="/models">← 模型清單</Link>
      </p>
      <h1>
        <ModelName model={model} />
      </h1>
      <p className="page-subtitle">
        {KIND_NAMES[model.kind]}・訓練 #{id}・{model.created_by}，{formatTime(model.created_at)}
      </p>
      <nav aria-label="模型分頁" className="tabs">
        {TABS.map((t) => (
          <NavLink key={t.tab} to={`/models/${id}/${t.tab}`} className="tabs__item">
            {t.label}
          </NavLink>
        ))}
      </nav>
      {tab === 'result' ? <ResultTab model={model} runId={id} /> : null}
      {tab === 'predict' ? <ModelPanel key={`p${model.id}`} inference={inference} model={model} part="predict" /> : null}
      {tab === 'history' ? <ModelPanel key={`h${model.id}`} inference={inference} model={model} part="history" /> : null}
      {tab === 'share' ? <SharePanel modelId={model.id} /> : null}
      {tab === 'download' ? <DownloadTab model={model} runId={id} /> : null}
    </>
  );
}

function KeyMetricCards({ model, metrics }: { model: Model; metrics: Record<string, unknown> | undefined }) {
  const keys = keyMetrics(model.kind, metrics, model.card.classes ?? model.card.label_names);
  if (!keys.length) return <p className="text-muted">這個模型沒有記錄指標。</p>;
  return (
    <dl className="training-facts" data-testid="key-metrics" aria-label="主要指標">
      {keys.map((k) => (
        <div key={k.name} className="stack">
          <dt>{k.label}</dt>
          <dd>
            <strong>{k.text}</strong>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** ROC 曲線：影像分類的 metrics.roc（fpr、tpr 陣列，第二期）。結構式的 ROC 在詳細結果的圖表裡。 */
function MetricsRoc({ metrics }: { metrics: Record<string, unknown> | undefined }) {
  const roc = (metrics?.roc ?? (metrics?.test as Record<string, unknown> | undefined)?.roc) as { fpr?: number[]; tpr?: number[] } | undefined;
  if (!roc?.fpr?.length || roc.fpr.length !== roc.tpr?.length) return null;
  const points = roc.fpr.map((x, i) => [x, roc.tpr![i]] as [number, number]);
  return (
    <LineChart title="ROC 曲線（測試資料）" series={[{ name: '模型', points }]} xLabel="偽陽性率（1 − 特異度）" yLabel="真陽性率（敏感度）" yRange={[0, 1]} diagonal />
  );
}

function ResultTab({ model, runId }: { model: Model; runId: number }) {
  const api = useTrainingApi();
  const canTrain = useHasPermission('training');
  if (!canTrain || !api) return <CardResult model={model} note="完整的結果、圖表與報表需要 Training 權限。" />;
  return <RunResult api={api} model={model} runId={runId} />;
}

/** 只用模型卡上的指標（沒有 Training，或讀不到訓練紀錄）。 */
function CardResult({ model, note }: { model: Model; note: string }) {
  const count = testCount(null, model.card.metrics);
  return (
    <section className="card section stack" aria-labelledby="model-result-title">
      <h2 id="model-result-title">結果</h2>
      {count !== null ? <p>測試資料 {count} 筆</p> : null}
      {count !== null && count < FEW_TESTS ? <Alert tone="warning">測試筆數少，結果僅供參考。</Alert> : null}
      <KeyMetricCards model={model} metrics={model.card.metrics} />
      <MetricsRoc metrics={model.card.metrics} />
      <p className="text-muted">{note}</p>
    </section>
  );
}

function RunResult({ api, model, runId }: { api: TrainingApi; model: Model; runId: number }) {
  const run = useResource(() => api.run(runId), [api, runId]);
  const runs = useResource(() => api.runs(), [api]);
  if (run.error) return <CardResult model={model} note="這個模型的訓練紀錄讀不到，只顯示模型記錄的指標。" />;
  if (!run.data) return <p role="status">載入中…</p>;
  const r = run.data;
  const count = testCount(r);
  const others = (runs.data ?? [])
    .filter((x) => x.status === 'succeeded' && x.kind === r.kind && x.id !== r.id && (r.setting_id === null || x.setting_id === r.setting_id))
    .sort((a, b) => b.id - a.id)
    .slice(0, 4);
  return (
    <div className="stack">
      <section className="card section stack" aria-labelledby="model-result-title">
        <h2 id="model-result-title">結果</h2>
        <dl className="training-facts" data-testid="result-data">
          <dt>資料版本</dt>
          <dd>{dataVersionText(r)}</dd>
          <dt>測試筆數</dt>
          <dd>{count ?? '—'}</dd>
        </dl>
        {count !== null && count < FEW_TESTS ? <Alert tone="warning">測試筆數少，結果僅供參考。</Alert> : null}
        <KeyMetricCards model={model} metrics={r.metrics} />
        <MetricsRoc metrics={r.metrics} />
        <div className="row-actions">
          <Link className="btn btn--primary" to={`/models/${runId}/predict`}>
            用新資料測試
          </Link>
        </div>
      </section>
      {others.length ? <Compare model={model} run={r} others={others} /> : null}
      <details className="card section training-details">
        <summary>詳細結果、圖表與完整設定</summary>
        <ResultView api={api} run={r} />
        <p>
          <Link to={`/training/runs/${r.id}`}>到建立模型查看這次訓練（日誌、依原版本重跑、另存設定）</Link>
        </p>
      </details>
    </div>
  );
}

function Compare({ model, run, others }: { model: Model; run: TrainingRun; others: TrainingRun[] }) {
  const rows = [run, ...others];
  const differs = others.some((o) => !sameTestData(run, o));
  const classes = model.card.classes ?? model.card.label_names;
  const names = keyMetrics(run.kind, run.metrics, classes).map((k) => k.name);
  return (
    <section className="card section stack" aria-labelledby="compare-title">
      <h2 id="compare-title">與其他次訓練比較</h2>
      {differs ? (
        <Alert tone="warning" title="測試資料不同，不宜直接排名">
          下列訓練的資料版本、切分或亂數種子不同，用來評分的測試資料不一樣。
        </Alert>
      ) : null}
      <div className="table-wrap">
        <table className="table" aria-label="訓練比較">
          <thead>
            <tr>
              <th scope="col">訓練</th>
              <th scope="col">資料版本</th>
              <th scope="col">測試筆數</th>
              {keyMetrics(run.kind, run.metrics, classes).map((k) => (
                <th key={k.name} scope="col">
                  {k.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => {
              const keys = keyMetrics(x.kind, x.metrics, classes);
              return (
                <tr key={x.id} aria-current={x.id === run.id ? 'true' : undefined}>
                  <th scope="row">
                    #{x.id}
                    {x.id === run.id ? '（這個模型）' : ''}
                    {x.id !== run.id && !sameTestData(run, x) ? <span className="field__hint">測試資料不同</span> : null}
                  </th>
                  <td>{dataVersionText(x)}</td>
                  <td>{testCount(x) ?? '—'}</td>
                  {names.map((n) => (
                    <td key={n}>{keys.find((k) => k.name === n)?.text ?? '—'}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Python 載入範例：PKL 用 joblib、H5 用 Keras。 */
export function loadExample(model: Pick<Model, 'format' | 'filename' | 'card'>): string {
  if (model.format === 'pkl') {
    const cols = (model.card.features ?? ['欄位1', '欄位2']).slice(0, 3);
    return [
      'import joblib',
      'import pandas as pd',
      '',
      `model = joblib.load("${model.filename}")`,
      `rows = pd.DataFrame([{${cols.map((c) => `"${c}": ...`).join(', ')}}])`,
      'print(model.predict(rows))',
    ].join('\n');
  }
  const size = model.card.input?.resize ?? [32, 32];
  return [
    'from tensorflow import keras',
    'import numpy as np',
    '',
    `model = keras.models.load_model("${model.filename}")`,
    `x = np.zeros((1, ${size[0]}, ${size[1]}, 1), dtype="float32")  # 影像先縮放成 ${size[0]}×${size[1]}`,
    'print(model.predict(x))',
  ].join('\n');
}

function DownloadTab({ model, runId }: { model: Model; runId: number }) {
  const api = useTrainingApi();
  const canTrain = useHasPermission('training');
  const canCode = useHasPermission('coding');
  const [done, setDone] = useState('');
  const [error, setError] = useState<unknown>(null);
  const format = model.format === 'h5' ? 'Keras H5' : 'PKL（scikit-learn）';
  async function act(load: () => Promise<{ blob: Blob; filename: string; sha256: string | null }>) {
    setError(null);
    setDone('');
    try {
      setDone(await downloadAndSave(load));
    } catch (err) {
      setError(err);
    }
  }
  return (
    <section className="card section stack" aria-labelledby="model-download-title">
      <h2 id="model-download-title">下載模型檔</h2>
      <p className="text-muted">
        模型檔格式：{format}。下載後可在平台外載入使用；SHA-256：<code>{model.sha256.slice(0, 16)}…</code>。結果報表請在「結果」分頁下載。
      </p>
      {done ? <Alert tone="success">{done}</Alert> : null}
      <ApiErrorAlert error={error} />
      {canTrain && api ? (
        <div className="row-actions">
          <button type="button" className="btn btn--primary" onClick={() => void act(() => api.downloadModel(model.id))}>
            下載模型「{displayName(model)}」
          </button>
          {canCode ? (
            <button type="button" className="btn btn--secondary" onClick={() => void act(() => api.exportSource(runId))}>
              匯出訓練原始碼
            </button>
          ) : null}
        </div>
      ) : (
        <Alert tone="info">下載模型檔需要 Training 權限；如需使用，請聯絡專案負責人或系統管理者。</Alert>
      )}
      <h3>Python 載入範例</h3>
      <pre className="training-log" aria-label="Python 載入範例">
        {loadExample(model)}
      </pre>
    </section>
  );
}
