// 標註資料集：清單、建立、匯入診斷結果，以及單一資料集（分布、逐筆列表、用這份資料建立模型）。
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { StatusBadge } from '../../components/StatusBadge';
import { useProjectAccess } from '../data/access';
import { useLabelingApi, type LabelingApi } from './api';
import { CsvImport } from './CsvImport';
import { LabelingNav } from './LabelingNav';
import { useScopes } from './pending';
import { SOURCE_LABELS, STATUS_LABELS, TASK_LABELS, type AnnotationKind, type AnnotationSource, type LabelDataset } from './types';
import './labeling.css';

/** 逐筆列表每頁筆數 */
export const ITEMS_PAGE = 50;

function NoProject() {
  return <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>;
}

/** 類別或來源分布：「normal 12、abnormal 8」 */
function distribution(counts: Record<string, number>, names?: Record<string, string>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${names?.[k] ?? k} ${n}`);
  return parts.join('、') || '—';
}

export function LabelDatasetsPage() {
  const labeling = useLabelingApi();
  return (
    <>
      <h1>影像標註</h1>
      <LabelingNav />
      {labeling ? <Datasets key={labeling.projectId} labeling={labeling} /> : <NoProject />}
    </>
  );
}

function Datasets({ labeling }: { labeling: LabelingApi }) {
  const { project } = useProjectAccess();
  const datasets = useResource(() => labeling.datasets(), [labeling]);
  const summary = useResource(() => labeling.summary(), [labeling]);
  const list = datasets.data ?? [];
  const reload = () => {
    datasets.reload();
    summary.reload();
  };
  return (
    <>
      <p className="text-muted">
        專案：<strong>{project?.name}</strong>。標註資料集是一組「要拿去訓練的標註」：選任務、資料範圍與類別，內容會隨標註增加。送出訓練時系統自動記下版本，不用自己管。
      </p>
      <ApiErrorAlert error={datasets.error} />
      <section className="section" aria-labelledby="ds-title">
        <h2 id="ds-title">標註資料集</h2>
        {datasets.loading && !datasets.data ? (
          <p role="status" className="loading">
            載入中…
          </p>
        ) : list.length === 0 ? (
          <Alert tone="info">還沒有標註資料集。專案第一次有標註時會自動建立一份；也可以在下方自己建立，或匯入診斷結果。</Alert>
        ) : (
          <div className="table-wrap">
            <table aria-label="標註資料集">
              <thead>
                <tr>
                  <th scope="col">名稱</th>
                  <th scope="col">任務</th>
                  <th scope="col">已確認標註</th>
                  <th scope="col">研究數</th>
                  <th scope="col">待確認（不納入）</th>
                  <th scope="col">類別分布</th>
                  <th scope="col">最新版本</th>
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id} data-dataset={d.id}>
                    <th scope="row">
                      <Link to={`/labeling/datasets/${d.id}`}>{d.name}</Link>
                    </th>
                    <td>{TASK_LABELS[d.task]}</td>
                    <td>{d.current.annotations}</td>
                    <td>{d.current.studies}</td>
                    <td>{d.current.drafts_excluded}</td>
                    <td>{distribution(d.current.by_class)}</td>
                    <td>{d.latest_version ? `第 ${d.latest_version.version} 版` : '尚未建版'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <CreateDataset labeling={labeling} existing={list} onCreated={reload} />
      <CsvImport labeling={labeling} studies={summary.data?.studies ?? []} datasets={list} onDone={reload} />
    </>
  );
}

function CreateDataset({ labeling, existing, onCreated }: { labeling: LabelingApi; existing: LabelDataset[]; onCreated: () => void }) {
  const scopes = useScopes();
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<LabelDataset | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const name = String(form.get('name') ?? '').trim();
    if (!name) return setError(new Error('請輸入資料集名稱'));
    if (existing.some((d) => d.name === name)) return setError(new Error(`已經有名為「${name}」的資料集，請換一個名稱。`));
    const scope = String(form.get('scope') ?? '');
    const classes = String(form.get('classes') ?? '')
      .split(/[,，、\s]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      const d = await labeling.createDataset({
        name,
        task: String(form.get('task')) as AnnotationKind,
        scope_id: scope ? Number(scope) : null,
        classes,
      });
      setCreated(d);
      formEl.reset();
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card section">
      <summary>建立標註資料集</summary>
      <ApiErrorAlert error={error} />
      {created ? (
        <Alert tone="success">
          已建立「{created.name}」。<Link to={`/labeling/datasets/${created.id}`}>開啟這份資料集</Link>
        </Alert>
      ) : null}
      <form aria-label="建立標註資料集" onSubmit={submit} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ds-name">名稱（必填）</label>
            <input id="ds-name" name="name" className="input" aria-required="true" />
          </div>
          <div className="field">
            <label htmlFor="ds-task">任務</label>
            <select id="ds-task" name="task" className="select" defaultValue="classification">
              {(Object.keys(TASK_LABELS) as AnnotationKind[]).map((k) => (
                <option key={k} value={k}>
                  {TASK_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ds-scope">資料範圍</label>
            <select id="ds-scope" name="scope" className="select" defaultValue="">
              <option value="">全部影像</option>
              {(scopes.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.study_count} 筆）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ds-classes">要用的類別</label>
            <input id="ds-classes" name="classes" className="input" aria-describedby="ds-classes-hint" />
            <span id="ds-classes-hint" className="field__hint">
              以逗號分隔，例如 normal, abnormal；留空代表全部類別
            </span>
          </div>
        </div>
        <button type="submit" className="btn btn--secondary" disabled={busy}>
          {busy ? '建立中…' : '建立'}
        </button>
      </form>
    </details>
  );
}

export function LabelDatasetPage() {
  const labeling = useLabelingApi();
  const { datasetId = '' } = useParams();
  return (
    <>
      <h1>影像標註</h1>
      <LabelingNav />
      {labeling ? <Dataset key={`${labeling.projectId}/${datasetId}`} labeling={labeling} id={Number(datasetId)} /> : <NoProject />}
    </>
  );
}

function Dataset({ labeling, id }: { labeling: LabelingApi; id: number }) {
  const { can, project } = useProjectAccess();
  const [offset, setOffset] = useState(0);
  const dataset = useResource(() => labeling.dataset(id), [labeling, id]);
  const items = useResource(() => labeling.datasetItems(id, offset, ITEMS_PAGE), [labeling, id, offset]);
  const d = dataset.data;
  const total = items.data?.total ?? 0;

  return (
    <>
      <p>
        <Link to="/labeling/datasets">← 回標註資料集</Link>
      </p>
      <ApiErrorAlert error={dataset.error} />
      {dataset.loading && !d ? (
        <p role="status" className="loading">
          載入中…
        </p>
      ) : d ? (
        <>
          <h2>{d.name}</h2>
          <dl className="kv" data-testid="dataset-summary">
            <div>
              <dt>任務</dt>
              <dd>{TASK_LABELS[d.task]}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>{d.latest_version ? `第 ${d.latest_version.version} 版（${d.latest_version.annotations} 筆）` : '尚未建版，送出訓練時自動建立第 1 版'}</dd>
            </div>
            <div>
              <dt>已確認標註</dt>
              <dd>
                {d.current.annotations} 筆、{d.current.studies} 個研究
              </dd>
            </div>
            <div>
              <dt>類別分布</dt>
              <dd>{distribution(d.current.by_class)}</dd>
            </div>
            <div>
              <dt>來源分布</dt>
              <dd>{distribution(d.current.by_source, SOURCE_LABELS as Record<AnnotationSource, string>)}</dd>
            </div>
            <div>
              <dt>待確認</dt>
              <dd>
                {d.current.drafts_excluded} 筆{d.current.drafts_excluded > 0 ? '（訓練不會用到，請到工作台確認）' : ''}
              </dd>
            </div>
          </dl>
          <div className="row-actions section">
            {can('training') ? (
              <Link className="btn btn--primary" to={`/training/new?labelDataset=${d.id}`}>
                用這份資料建立模型
              </Link>
            ) : (
              <span className="text-muted">建立模型需要 Training 權限；如需使用，請聯絡專案「{project?.name}」的負責人。</span>
            )}
          </div>

          <section className="section" aria-labelledby="items-title">
            <h3 id="items-title">標註（{total} 筆，含待確認）</h3>
            <ApiErrorAlert error={items.error} />
            {items.data && items.data.items.length === 0 ? (
              <p className="text-muted">還沒有符合這份資料集的標註。</p>
            ) : items.data ? (
              <div className="table-wrap">
                <table aria-label="資料集內的標註">
                  <thead>
                    <tr>
                      <th scope="col">編號</th>
                      <th scope="col">影像編號</th>
                      <th scope="col">類別</th>
                      <th scope="col">來源</th>
                      <th scope="col">狀態</th>
                      <th scope="col">最後修改</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.data.items.map((it) => (
                      <tr key={it.annotation_id}>
                        <th scope="row">#{it.annotation_id}</th>
                        <td>{it.accession_number || it.study_instance_uid}</td>
                        <td>{it.label}</td>
                        <td>{SOURCE_LABELS[it.source]}</td>
                        <td>
                          <StatusBadge tone={it.status === 'draft' ? 'warning' : 'success'}>{STATUS_LABELS[it.status]}</StatusBadge>
                        </td>
                        <td>
                          {it.updated_by}　{it.updated_at.slice(0, 16).replace('T', ' ')}
                        </td>
                        <td>
                          <Link
                            to={`/labeling/studies/${encodeURIComponent(it.study_instance_uid)}?annotation=${it.annotation_id}`}
                            aria-label={`開啟標註 #${it.annotation_id}`}
                          >
                            開啟
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {total > ITEMS_PAGE ? (
              <div className="row-actions section">
                <button type="button" className="btn btn--secondary btn--small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - ITEMS_PAGE))}>
                  上一頁
                </button>
                <span>
                  第 {offset + 1}–{Math.min(total, offset + ITEMS_PAGE)} 筆
                </span>
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  disabled={offset + ITEMS_PAGE >= total}
                  onClick={() => setOffset(offset + ITEMS_PAGE)}
                >
                  下一頁
                </button>
              </div>
            ) : null}
          </section>
        </>
      ) : null}
    </>
  );
}
