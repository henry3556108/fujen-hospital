// 使用模型（B-06）：合併原「AI 模型部署」與「推論服務管理」。模型清單（已完成的訓練＝模型）→ 單一模型四個分頁：
// 模型結果、預測新資料、預測紀錄、分享與服務（再分分享與服務／模型下載／呼叫說明）。網址用訓練編號（/models/:runId/...）。
// 模型清單與預測只需要 Prediction；結果的完整內容、分享、下載模型檔另需 Training（API 的規則）。
import { useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { LineChart } from '../../components/charts/LineChart';
import { formatTime } from '../../components/format';
import { Badge, Card, CodeBlock, Icon, PageHeader, Tabs } from '../../components/ui';
import { CallGuide, SharePanel } from '../deployment/DeploymentPage';
import { KIND_NAMES, displayName, isImageModel, useInferenceApi, type InferenceApi, type Model } from '../inference/api';
import { ModelPanel } from '../inference/InferencePage';
import { ModelName } from '../inference/ModelName';
import { saveFile, useTrainingApi, type Charts, type TrainingApi, type TrainingRun } from '../training/api';
import { downloadAndSave, useHasPermission } from '../training/ModelExport';
import { MetricTiles, type MetricTile } from '../training/MetricTiles';
import { countText, primaryScore, primaryText } from '../training/metrics';
import { ResultView, countsOf, useRunCharts } from '../training/ResultView';
import { FEW_TESTS, dataVersionText, keyMetrics, sameTestData, testCount, type KeyMetric } from './keyMetrics';
import '../training/training.css';
import '../inference/inference.css';

export type ModelTab = 'result' | 'predict' | 'history' | 'share' | 'download' | 'call';

/** 頁面上方四個分頁（設計稿 A07）；模型下載、呼叫說明是「分享與服務」底下的分頁（設計稿 B11）。 */
const TABS: { tab: ModelTab; label: string }[] = [
  { tab: 'result', label: '模型結果' },
  { tab: 'predict', label: '預測新資料' },
  { tab: 'history', label: '預測紀錄' },
  { tab: 'share', label: '分享與服務' },
];
const SHARE_GROUP: ModelTab[] = ['share', 'download', 'call'];
const TAB_TITLES: Record<ModelTab, string> = {
  result: '模型結果', predict: '預測新資料', history: '預測紀錄', share: '分享與服務', download: '模型下載', call: '呼叫說明',
};

/** 從契約入口（/deployment、/inference）轉來時的一行說明。 */
export const ENTRY_NOTES: Record<string, string> = {
  deployment: '「AI 模型部署」已併入這裡：打開模型後在「分享與服務」分享給同事、設定授權、查看 API 端點與試呼叫；「模型下載」可取得模型檔。',
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
      <PageHeader title="使用模型" subtitle="每一次完成的訓練就是一個模型。打開模型可以查看結果、預測新資料、分享給同事或下載模型檔。" />
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
        這個專案還沒有訓練完成的模型。{canTrain ? <Link to="/training/new">建立訓練</Link> : '請有訓練權限的成員建立訓練'}，完成後會出現在這裡。
      </Alert>
    );
  }
  const list = [...models.data].sort((a, b) => b.id - a.id);
  return (
    <Card title="模型清單" flush>
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
    </Card>
  );
}

/** 單一模型：標題、分頁與目前分頁的內容。 */
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
        <PageHeader title="使用模型" />
        <Alert tone="info">
          找不到訓練 #{runId} 的模型（可能還沒完成或已刪除）。<Link to="/models">回模型清單</Link>
        </Alert>
      </>
    );
  }
  const inShare = SHARE_GROUP.includes(tab);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: '使用模型', to: '/models' }, { label: TAB_TITLES[tab] }]}
        title={<ModelName model={model} />}
        subtitle={`${KIND_NAMES[model.kind]}・訓練 #${id}・${model.created_by}，${formatTime(model.created_at)}`}
        actions={<HeaderActions runId={id} tab={tab} />}
      />
      <nav aria-label="模型分頁" className="tabs">
        {TABS.map((t) => {
          const active = t.tab === tab || (t.tab === 'share' && inShare);
          return (
            <Link key={t.tab} to={`/models/${id}/${t.tab}`} className="tabs__item" aria-current={active ? 'page' : undefined}>
              {t.label}
            </Link>
          );
        })}
      </nav>
      {inShare ? (
        <Tabs label="分享與服務分頁" items={[
          { to: `/models/${id}/share`, label: '分享與服務' },
          { to: `/models/${id}/download`, label: '模型下載' },
          { to: `/models/${id}/call`, label: '呼叫說明' },
        ]} />
      ) : null}
      {tab === 'result' ? <ResultTab model={model} runId={id} /> : null}
      {tab === 'predict' ? <ModelPanel key={`p${model.id}`} inference={inference} model={model} part="predict" /> : null}
      {tab === 'history' ? <ModelPanel key={`h${model.id}`} inference={inference} model={model} part="history" /> : null}
      {tab === 'share' ? <SharePanel modelId={model.id} /> : null}
      {tab === 'download' ? <DownloadTab model={model} runId={id} /> : null}
      {tab === 'call' ? <CallGuide modelId={model.id} /> : null}
    </>
  );
}

/** 標題右側：用新資料測試（主要動作）、下載報告（需要 Training，沿用現有的 HTML 報表）。 */
function HeaderActions({ runId, tab }: { runId: number; tab: ModelTab }) {
  const api = useTrainingApi();
  const canTrain = useHasPermission('training');
  const [state, setState] = useState<{ done: string; error: unknown }>({ done: '', error: null });
  async function report() {
    if (!api) return;
    setState({ done: '', error: null });
    try {
      setState({ done: await downloadAndSave(() => api.report(runId)), error: null });
    } catch (err) {
      setState({ done: '', error: err });
    }
  }
  return (
    <div className="stack">
      <div className="row-actions">
        {tab !== 'predict' ? (
          <Link className="btn btn--primary" to={`/models/${runId}/predict`}>
            用新資料測試
            <Icon name="arrow" />
          </Link>
        ) : null}
        {canTrain && api ? (
          <button type="button" className="btn btn--secondary" onClick={() => void report()}>
            <Icon name="download" />
            下載報告
          </button>
        ) : null}
      </div>
      {state.done ? <Alert tone="success">{state.done}</Alert> : null}
      <ApiErrorAlert error={state.error} />
    </div>
  );
}

/** 指標方塊下方的白話說明（設計稿 A07） */
const PLAIN: Record<string, string> = {
  sensitivity: '有異常時辨識出的比例',
  specificity: '沒有異常時正確排除的比例',
  auc: '整體判別能力',
  accuracy: '預測正確的比例',
  mae: '預測值與實際值平均差多少',
  rmse: '預測值平均偏離實際值多少（大錯加重計算）',
  r2: '模型能解釋的高低差異比例',
  dice: '預測範圍與標註範圍的重疊程度',
};

/** 指標的來源（與 keyMetrics 相同：測試集優先，再驗證集） */
function scoreSubset(metrics: Record<string, unknown> | undefined | null): Charts['subset'] | null {
  const m = metrics ?? {};
  for (const key of ['test', 'validation'] as const) {
    const v = m[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) return key;
  }
  return null;
}

/** 主要指標轉成指標方塊；有混淆矩陣且來源相同時加上計數（F3）。 */
export function metricTiles(keys: KeyMetric[], counts: Record<string, [number, number]>): MetricTile[] {
  return keys.map((k) => ({
    name: k.name,
    label: k.label,
    value: k.value,
    text: k.text,
    count: k.value === null ? undefined : countText(k.name, k.value, counts) || undefined,
    plain: PLAIN[k.name],
  }));
}

function KeyMetricCards({ model, metrics, counts = {} }: { model: Model; metrics: Record<string, unknown> | undefined; counts?: Record<string, [number, number]> }) {
  const keys = keyMetrics(model.kind, metrics, model.card.classes ?? model.card.label_names);
  if (!keys.length) return <p className="text-muted">這個模型沒有記錄指標。</p>;
  return (
    <div data-testid="key-metrics">
      <MetricTiles label="主要指標" tiles={metricTiles(keys, counts)} />
    </div>
  );
}

/** ROC 曲線：結構式與影像分類的 charts.json，否則 metrics.roc（fpr、tpr 陣列）。 */
function rocPoints(charts: Charts | null | undefined, metrics: Record<string, unknown> | undefined): [number, number][] | null {
  if (charts?.roc?.points.length) return charts.roc.points;
  const roc = (metrics?.roc ?? (metrics?.test as Record<string, unknown> | undefined)?.roc) as { fpr?: number[]; tpr?: number[] } | undefined;
  if (!roc?.fpr?.length || roc.fpr.length !== roc.tpr?.length) return null;
  return roc.fpr.map((x, i) => [x, roc.tpr![i]] as [number, number]);
}

function RocCard({ points, runId }: { points: [number, number][] | null; runId: number }) {
  if (!points) return null;
  return (
    <Card title={`ROC 曲線（訓練 #${runId}）`}>
      <LineChart title="ROC 曲線（測試資料）" series={[{ name: '模型', points }]} xLabel="偽陽性率（1 − 特異度）" yLabel="真陽性率（敏感度）" yRange={[0, 1]} diagonal />
    </Card>
  );
}

function ResultTab({ model, runId }: { model: Model; runId: number }) {
  const api = useTrainingApi();
  const canTrain = useHasPermission('training');
  if (!canTrain || !api) return <CardResult model={model} runId={runId} note="完整的結果、圖表與報表需要 Training 權限。" />;
  return <RunResult api={api} model={model} runId={runId} />;
}

/** 只用模型卡上的指標（沒有 Training，或讀不到訓練紀錄）。 */
function CardResult({ model, runId, note }: { model: Model; runId: number; note: string }) {
  const count = testCount(null, model.card.metrics);
  return (
    <section className="stack" aria-labelledby="model-result-title">
      <h2 id="model-result-title" className="visually-hidden">模型結果</h2>
      {count !== null ? <p className="text-muted">測試資料 {count} 筆</p> : null}
      {count !== null && count < FEW_TESTS ? <Alert tone="warning">測試筆數少，結果僅供參考。</Alert> : null}
      <KeyMetricCards model={model} metrics={model.card.metrics} />
      <RocCard points={rocPoints(null, model.card.metrics)} runId={runId} />
      <p className="text-muted">{note}</p>
    </section>
  );
}

function RunResult({ api, model, runId }: { api: TrainingApi; model: Model; runId: number }) {
  const run = useResource(() => api.run(runId), [api, runId]);
  const runs = useResource(() => api.runs(), [api]);
  if (run.error) return <CardResult model={model} runId={runId} note="這個模型的訓練紀錄讀不到，只顯示模型記錄的指標。" />;
  if (!run.data) return <p role="status">載入中…</p>;
  const others = (runs.data ?? [])
    .filter((x) => x.status === 'succeeded' && x.kind === run.data!.kind && x.id !== run.data!.id && (run.data!.setting_id === null || x.setting_id === run.data!.setting_id))
    .sort((a, b) => b.id - a.id)
    .slice(0, 4);
  return <RunResultView api={api} model={model} run={run.data} others={others} />;
}

function RunResultView({ api, model, run, others }: { api: TrainingApi; model: Model; run: TrainingRun; others: TrainingRun[] }) {
  const charts = useRunCharts(api, run);
  const c = charts.data?.charts;
  // 計數只在圖表與指標用同一份資料時顯示
  const counts = c && c.subset === scoreSubset(run.metrics) ? countsOf(run, c) : {};
  const count = testCount(run);
  return (
    <div className="stack">
      <section className="stack" aria-labelledby="model-result-title">
        <h2 id="model-result-title" className="visually-hidden">模型結果</h2>
        <p className="text-muted" data-testid="result-data">
          資料版本：{dataVersionText(run)}・測試筆數：{count ?? '—'}{count !== null ? ' 筆' : ''}
        </p>
        {count !== null && count < FEW_TESTS ? <Alert tone="warning">測試筆數少，結果僅供參考。</Alert> : null}
        <KeyMetricCards model={model} metrics={run.metrics} counts={counts} />
      </section>
      <div className="trn-chart-grid">
        <Compare model={model} run={run} others={others} />
        <RocCard points={rocPoints(c, run.metrics)} runId={run.id} />
      </div>
      <details className="card section training-details trn-full">
        <summary>
          <Icon name="gear" />
          完整設定（模型參數、影像前處理等）與詳細結果
        </summary>
        <ResultView api={api} run={run} hideReport />
        <p>
          <Link to={`/training/runs/${run.id}`}>到建立模型查看這次訓練（日誌、依原版本重跑、另存設定）</Link>
        </p>
      </details>
    </div>
  );
}

function Compare({ model, run, others }: { model: Model; run: TrainingRun; others: TrainingRun[] }) {
  // 由舊到新排列，這個模型標成目前
  const rows = [run, ...others].sort((a, b) => a.id - b.id);
  const differs = others.some((o) => !sameTestData(run, o));
  const classes = model.card.classes ?? model.card.label_names;
  const heads = keyMetrics(run.kind, run.metrics, classes);
  const count = testCount(run);
  const title = differs || count === null ? '歷次訓練結果比較' : `歷次訓練結果比較（相同測試資料：${count} 筆）`;
  return (
    <Card title={title} flush={!differs}>
      {differs ? (
        <Alert tone="warning" title="測試資料不同，不宜直接排名">
          下列訓練的資料版本、切分或亂數種子不同，用來評分的測試資料不一樣。
        </Alert>
      ) : null}
      <div className="table-wrap">
        <table className="table trn-compare" aria-label="訓練比較">
          <thead>
            <tr>
              <th scope="col">訓練次數</th>
              <th scope="col">訓練完成日期</th>
              <th scope="col">資料版本</th>
              <th scope="col">測試筆數</th>
              {heads.map((k) => (
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
                  <td>{x.finished_at ? formatTime(x.finished_at) : '—'}</td>
                  <td>{dataVersionText(x)}</td>
                  <td>{testCount(x) ?? '—'}</td>
                  {heads.map((h) => (
                    <td key={h.name}>{keys.find((k) => k.name === h.name)?.text ?? '—'}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Python 載入範例：PKL 用 joblib、H5 用 Keras（設計稿 B11 F8）。 */
export function loadExample(model: Pick<Model, 'format' | 'filename' | 'card'>): string {
  if (model.format === 'pkl') {
    const cols = (model.card.features ?? ['欄位1', '欄位2']).slice(0, 3);
    return [
      '# 1. 載入必要套件',
      'import joblib',
      'import pandas as pd',
      '',
      '# 2. 載入模型',
      `model = joblib.load("${model.filename}")`,
      '',
      '# 3. 準備資料並預測（欄位要與訓練時相同）',
      `rows = pd.DataFrame([{${cols.map((c) => `"${c}": ...`).join(', ')}}])`,
      'print(model.predict(rows))',
    ].join('\n');
  }
  const size = model.card.input?.resize ?? [32, 32];
  return [
    '# 1. 載入必要套件',
    'from tensorflow import keras',
    'import numpy as np',
    '',
    '# 2. 載入模型',
    `model = keras.models.load_model("${model.filename}")`,
    '',
    '# 3. 影像預測',
    `x = np.zeros((1, ${size[0]}, ${size[1]}, 1), dtype="float32")  # 影像先縮放成 ${size[0]}×${size[1]}`,
    'print(model.predict(x))',
  ].join('\n');
}

/** 平台訓練環境的套件（platform/api/app/training/bundle.py 的 REQUIREMENTS）；模型卡沒有記錄版本時使用。 */
const FALLBACK_REQUIREMENTS: Record<Model['format'], string[]> = {
  h5: ['numpy', 'scipy', 'pydicom', 'nibabel', 'SimpleITK', 'pillow', 'h5py', 'keras==3.15.1', 'tensorflow>=2.17,<2.22'],
  pkl: ['numpy', 'pandas', 'scikit-learn', 'statsmodels', 'lifelines'],
};

/** 依賴套件清單：模型卡記錄的實際版本（libraries），否則平台訓練環境的套件清單。 */
export function requirementsOf(model: Pick<Model, 'format' | 'card'>): { text: string; recorded: boolean } {
  const libs = Object.entries(model.card.libraries ?? {}).filter(([, v]) => Boolean(v));
  if (libs.length) return { text: libs.map(([name, v]) => `${name}==${v}`).join('\n'), recorded: true };
  return { text: FALLBACK_REQUIREMENTS[model.format].join('\n'), recorded: false };
}

/** 下載範例與環境說明（文字檔）。 */
export function guideText(model: Pick<Model, 'format' | 'filename' | 'card' | 'sha256' | 'name'>): string {
  const req = requirementsOf(model);
  return [
    `模型：${model.name}`,
    `模型檔：${model.filename}（${model.format === 'h5' ? 'Keras H5' : 'PKL（scikit-learn）'}）`,
    `SHA-256：${model.sha256}`,
    '',
    '== 安裝依賴套件 ==',
    '把下列內容存成 requirements.txt，執行 pip install -r requirements.txt',
    req.recorded ? '（版本為平台訓練時實際使用的版本）' : '（平台訓練環境的套件；這個模型沒有記錄版本）',
    req.text,
    '',
    '== Python 使用範例 ==',
    loadExample(model),
    '',
  ].join('\n');
}

function saveText(text: string, filename: string) {
  saveFile({ blob: new Blob([text], { type: 'text/plain;charset=utf-8' }), filename, sha256: null });
}

/** 模型下載（設計稿 B11）：模型資訊、依格式下載、Python 範例與依賴套件。 */
function DownloadTab({ model, runId }: { model: Model; runId: number }) {
  const api = useTrainingApi();
  const canTrain = useHasPermission('training');
  const canCode = useHasPermission('coding');
  const [done, setDone] = useState('');
  const [error, setError] = useState<unknown>(null);
  const image = isImageModel(model.kind);
  const req = requirementsOf(model);
  const base = model.filename.replace(/\.[^.]+$/, '') || 'model';
  async function act(load: () => Promise<{ blob: Blob; filename: string; sha256: string | null }>) {
    setError(null);
    setDone('');
    try {
      setDone(await downloadAndSave(load));
    } catch (err) {
      setError(err);
    }
  }
  const formats = [
    { format: 'pkl' as const, title: '表格模型（.pkl）', hint: '適用於結構式資料的模型（scikit-learn）', icon: 'doc' as const },
    { format: 'h5' as const, title: '影像模型（Keras .h5）', hint: '適用於影像的模型（Keras）', icon: 'lungs' as const },
  ];
  return (
    <div className="stack">
      <Card>
        <div className="trn-model-head">
          <Icon name={image ? 'lungs' : 'doc'} className="trn-model-head__icon" />
          <div>
            <p className="trn-model-head__name">
              <strong>{displayName(model)}</strong>
              <Badge tone="success">已完成訓練</Badge>
            </p>
            <dl className="trn-facts-row">
              <div>
                <dt>模型類型</dt>
                <dd>{KIND_NAMES[model.kind]}</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd>訓練 #{runId}</dd>
              </div>
              <div>
                <dt>建立</dt>
                <dd>
                  {model.created_by}，{formatTime(model.created_at)}
                </dd>
              </div>
              {model.card.target ? (
                <div>
                  <dt>要預測的結果</dt>
                  <dd>{model.card.target}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>
      </Card>
      <div className="trn-chart-grid">
        <section className="ui-card" aria-labelledby="model-download-title">
          <div className="ui-card__head">
            <h2 id="model-download-title" className="ui-card__title">下載模型檔</h2>
          </div>
          <div className="ui-card__body stack">
            <p className="text-muted">依模型類型下載，並參考右側範例程式使用。結果報表請在「模型結果」分頁上方下載。</p>
            {done ? <Alert tone="success">{done}</Alert> : null}
            <ApiErrorAlert error={error} />
            {!canTrain || !api ? <Alert tone="info">下載模型檔需要 Training 權限；如需使用，請聯絡專案負責人或系統管理者。</Alert> : null}
            <div className="trn-formats">
              {formats.map((f) => {
                const active = f.format === model.format;
                return (
                  <div key={f.format} className={`trn-format ${active ? 'trn-format--active' : ''}`}>
                    <div className="trn-format__title">
                      <Icon name={f.icon} />
                      <span>
                        <strong>{f.title}</strong>
                        <span className="field__hint">{f.hint}</span>
                      </span>
                    </div>
                    <dl className="trn-params">
                      <dt>檔案格式</dt>
                      <dd>.{f.format}</dd>
                      {active ? (
                        <>
                          <dt>檔名</dt>
                          <dd>{model.filename}</dd>
                        </>
                      ) : null}
                    </dl>
                    {active && canTrain && api ? (
                      <button type="button" className="btn btn--primary" aria-label={`下載模型「${displayName(model)}」`}
                        onClick={() => void act(() => api.downloadModel(model.id))}>
                        <Icon name="download" />
                        下載模型
                      </button>
                    ) : !active ? (
                      <p className="field__hint">這個模型不是這個格式。</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="row-actions">
              <button type="button" className="btn btn--secondary" onClick={() => saveText(guideText(model), `${base}-使用說明.txt`)}>
                <Icon name="doc" />
                下載範例與環境說明
              </button>
              {canTrain && canCode && api ? (
                <button type="button" className="btn btn--secondary" onClick={() => void act(() => api.exportSource(runId))}>
                  匯出訓練原始碼
                </button>
              ) : null}
            </div>
            <p className="field__hint">
              說明檔包含依賴套件清單、環境設定與使用範例。模型檔 SHA-256：<code>{model.sha256.slice(0, 16)}…</code>
            </p>
          </div>
        </section>
        <Card title={`Python 使用範例（${model.format === 'h5' ? 'Keras .h5' : 'scikit-learn .pkl'}）`}>
          <div className="stack">
            <CodeBlock code={loadExample(model)} title="Python 載入範例" language="python" />
            <h3 className="trn-section__title">依賴套件版本</h3>
            <p className="field__hint">{req.recorded ? '平台訓練這個模型時實際使用的版本。' : '這個模型沒有記錄版本，以下是平台訓練環境的套件。'}</p>
            <CodeBlock code={req.text} title="requirements.txt" lineNumbers={false} />
            <div className="row-actions">
              <button type="button" className="btn btn--secondary btn--small" onClick={() => saveText(`${req.text}\n`, 'requirements.txt')}>
                <Icon name="download" />
                下載依賴清單
              </button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
