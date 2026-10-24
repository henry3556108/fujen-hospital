// 標註資料集（設計稿 A04）：清單、建立、匯入診斷結果；
// 單一資料集：資料集與版本選擇、繼續確認、已確認／待確認進度、明細表與分頁、右側資料集資訊（類別統計、來源統計）。
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import {
  Badge,
  BarList,
  Card,
  ConfirmProgress,
  EmptyState,
  InfoList,
  PageHeader,
  Pagination,
  SidePanel,
  SlideOver,
  SplitLayout,
} from '../../components/ui';
import { useProjectAccess } from '../data/access';
import { useLabelingApi, type LabelingApi } from './api';
import { CsvImport } from './CsvImport';
import { LabelingNav } from './LabelingNav';
import { useScopes, workbenchPath } from './pending';
import {
  SOURCE_LABELS,
  STATUS_LABELS,
  TASK_LABELS,
  type AnnotationKind,
  type AnnotationSource,
  type LabelDataset,
  type LabelDatasetVersion,
} from './types';
import './labeling.css';

/** 明細表預設每頁筆數（設計稿 A04：每頁顯示 10 筆） */
export const ITEMS_PAGE = 10;

const DATASETS_SUBTITLE = '一份有名稱的資料集，保留標註來源與確認狀態；送出訓練時系統自動記下版本。';

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

/** BarList 用：數量由多到少 */
function bars(counts: Record<string, number>, names?: Record<string, string>) {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ label: names?.[k] ?? k, value: n }));
}

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export function LabelDatasetsPage() {
  const labeling = useLabelingApi();
  return (
    <>
      <PageHeader title="標註資料集" subtitle={DATASETS_SUBTITLE}>
        <LabelingNav />
      </PageHeader>
      {labeling ? <Datasets key={labeling.projectId} labeling={labeling} /> : <NoProject />}
    </>
  );
}

function Datasets({ labeling }: { labeling: LabelingApi }) {
  const datasets = useResource(() => labeling.datasets(), [labeling]);
  const summary = useResource(() => labeling.summary(), [labeling]);
  const list = datasets.data ?? [];
  const reload = () => {
    datasets.reload();
    summary.reload();
  };
  return (
    <>
      <ApiErrorAlert error={datasets.error} />
      <Card title="全部資料集" flush className="section">
        {datasets.loading && !datasets.data ? (
          <p role="status" className="loading lb-card-note">
            載入中…
          </p>
        ) : list.length === 0 ? (
          <EmptyState
            icon="database"
            title="還沒有標註資料集"
            description="專案第一次有標註時會自動建立一份；也可以在下方自己建立，或匯入診斷結果。"
          />
        ) : (
          <div className="table-wrap">
            <table aria-label="標註資料集">
              <thead>
                <tr>
                  <th scope="col">名稱</th>
                  <th scope="col">任務</th>
                  <th scope="col">已確認</th>
                  <th scope="col">待確認（不納入）</th>
                  <th scope="col">研究數</th>
                  <th scope="col">類別分布</th>
                  <th scope="col">最新版本</th>
                  <th scope="col">操作</th>
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
                    <td>{d.current.drafts_excluded > 0 ? <Badge tone="warning">{d.current.drafts_excluded}</Badge> : 0}</td>
                    <td>{d.current.studies}</td>
                    <td>{distribution(d.current.by_class)}</td>
                    <td>{d.latest_version ? `第 ${d.latest_version.version} 版` : '尚未建版'}</td>
                    <td>
                      <Link className="btn btn--secondary btn--small" to={`/labeling/datasets/${d.id}`} aria-label={`開啟資料集 ${d.name}`}>
                        開啟
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
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
    <details className="card section lb-create">
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
      <PageHeader title="標註資料集" subtitle={DATASETS_SUBTITLE}>
        <LabelingNav />
      </PageHeader>
      {labeling ? <Dataset key={`${labeling.projectId}/${datasetId}`} labeling={labeling} id={Number(datasetId)} /> : <NoProject />}
    </>
  );
}

function Dataset({ labeling, id }: { labeling: LabelingApi; id: number }) {
  const { can, project } = useProjectAccess();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(ITEMS_PAGE);
  const [importing, setImporting] = useState(false);
  const dataset = useResource(() => labeling.dataset(id), [labeling, id]);
  const datasets = useResource(() => labeling.datasets(), [labeling]);
  const versions = useResource(() => labeling.datasetVersions(id), [labeling, id]);
  const items = useResource(() => labeling.datasetItems(id, (page - 1) * pageSize, pageSize), [labeling, id, page, pageSize]);
  const summary = useResource(() => labeling.summary(), [labeling]);
  const scopes = useScopes();
  const d = dataset.data;
  const total = items.data?.total ?? 0;

  // 版本選擇（F5）：空字串＝目前內容；舊版只顯示版本摘要，明細仍是目前內容
  const versionNo = Number(search.get('version')) || null;
  const version: LabelDatasetVersion | undefined = versionNo !== null ? versions.data?.find((v) => v.version === versionNo) : undefined;

  const reload = () => {
    dataset.reload();
    datasets.reload();
    versions.reload();
    items.reload();
    summary.reload();
  };

  function continueConfirm() {
    if (!d) return;
    const draft = items.data?.items.find((it) => it.status === 'draft');
    if (draft) navigate(`${workbenchPath(draft.study_instance_uid, d.scope_id)}${d.scope_id !== null ? '&' : '?'}annotation=${draft.annotation_id}`);
    else navigate(`/labeling?status=pending${d.scope_id !== null ? `&scope=${d.scope_id}` : ''}`);
  }

  if (dataset.loading && !d) {
    return (
      <p role="status" className="loading">
        載入中…
      </p>
    );
  }
  if (!d) return <ApiErrorAlert error={dataset.error} />;

  const scopeName = d.scope_id === null ? '全部影像' : (scopes.data?.find((s) => s.id === d.scope_id)?.name ?? `資料範圍 #${d.scope_id}`);
  const classes = d.classes.length ? d.classes : Object.keys(d.current.by_class);
  const byClass = version ? version.by_class : d.current.by_class;

  const side = (
    <SidePanel
      title="資料集資訊"
      footer={
        can('training') ? (
          <Link className="btn btn--secondary" to={`/training/new?labelDataset=${d.id}`}>
            用這份資料建立模型
          </Link>
        ) : (
          <span className="text-muted">建立模型需要 Training 權限；如需使用，請聯絡專案「{project?.name}」的負責人。</span>
        )
      }
    >
      <div data-testid="dataset-summary">
        <InfoList
          items={[
            { label: '資料集名稱', value: `${d.name}・${version ? `第 ${version.version} 版` : '目前內容'}` },
            { label: '任務', value: TASK_LABELS[d.task] },
            { label: '來源專案', value: project?.name ?? '—' },
            { label: '資料範圍', value: scopeName },
            {
              label: version ? '建版時間' : '最新版本',
              value: version
                ? `${when(version.created_at)}（${version.created_by}）`
                : d.latest_version
                  ? `第 ${d.latest_version.version} 版（${when(d.latest_version.created_at)}，${d.latest_version.annotations} 筆）`
                  : '尚未建版，送出訓練時自動建立第 1 版',
            },
            { label: '標註類別', value: classes.length ? classes.join(' / ') : '—' },
            {
              label: '已確認標註',
              value: version ? `${version.annotations} 筆` : `${d.current.annotations} 筆、${d.current.studies} 個研究`,
            },
            {
              label: '待確認',
              value: `${d.current.drafts_excluded} 筆${d.current.drafts_excluded > 0 ? '（訓練不會用到，請到工作台確認）' : ''}`,
            },
          ]}
        />
        <div className="lb-ds-side-section">
          <h3>類別統計（依標註結果{version ? `，第 ${version.version} 版` : ''}）</h3>
          <BarList label="類別統計" items={bars(byClass)} emptyText="還沒有已確認的標註" />
        </div>
        <div className="lb-ds-side-section">
          <h3>來源統計{version ? '（目前內容）' : ''}</h3>
          <BarList label="來源統計" items={bars(d.current.by_source, SOURCE_LABELS as Record<AnnotationSource, string>)} emptyText="還沒有已確認的標註" />
        </div>
      </div>
    </SidePanel>
  );

  return (
    <>
      <ApiErrorAlert error={dataset.error ?? versions.error} />
      <div className={`lb-ds-split section ${items.data && items.data.items.length === 0 ? 'lb-ds-split--empty' : ''}`}>
        <SplitLayout side={side}>
          <Card>
            <div className="lb-ds-toolbar">
              <div className="field">
                <label htmlFor="ds-pick">資料集</label>
                <select id="ds-pick" className="select" value={d.id} onChange={(e) => navigate(`/labeling/datasets/${e.target.value}`)}>
                  {(datasets.data ?? [d]).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ds-version">版本</label>
                <select
                  id="ds-version"
                  className="select"
                  value={version ? String(version.version) : ''}
                  onChange={(e) => {
                    const q = new URLSearchParams(search);
                    if (e.target.value) q.set('version', e.target.value);
                    else q.delete('version');
                    setSearch(q, { replace: true });
                  }}
                >
                  <option value="">目前內容{d.latest_version ? '' : '（尚未建版）'}</option>
                  {(versions.data ?? []).map((v) => (
                    <option key={v.version} value={v.version}>
                      第 {v.version} 版（{when(v.created_at).slice(0, 10)}，{v.annotations} 筆）
                    </option>
                  ))}
                </select>
              </div>
              <div className="lb-ds-toolbar__actions">
                <button type="button" className="btn btn--primary" onClick={continueConfirm}>
                  繼續確認
                </button>
                {d.task === 'classification' ? (
                  <button type="button" className="btn btn--secondary" onClick={() => setImporting(true)}>
                    匯入診斷結果
                  </button>
                ) : null}
              </div>
            </div>
            {version ? (
              <Alert tone="info">
                第 {version.version} 版建立於 {when(version.created_at)}，當時有 {version.annotations} 筆已確認標註。右側是這一版的摘要；下方明細是目前內容，不是第{' '}
                {version.version} 版當時的內容。
              </Alert>
            ) : null}
            <ConfirmProgress confirmed={d.current.annotations} pending={d.current.drafts_excluded} totalLabel="筆標註" />
            {d.current.drafts_excluded > 0 ? <p className="field__hint">待確認的是自動標註的草稿，確認後才會用在訓練。診斷表匯入的標註直接算已確認。</p> : null}
          </Card>

          <Card title={`明細（${total} 筆，含待確認）`} flush className="lb-ds-detail">
            <ApiErrorAlert error={items.error} />
            {items.data && items.data.items.length === 0 ? (
              <p className="text-muted lb-card-note lb-ds-empty">還沒有符合這份資料集的標註。</p>
            ) : items.data ? (
              <>
                <div className="table-wrap">
                  <table aria-label="資料集內的標註">
                    <thead>
                      <tr>
                        <th scope="col">影像編號</th>
                        <th scope="col">來源</th>
                        <th scope="col">分類</th>
                        <th scope="col">確認狀態</th>
                        <th scope="col">最後修改</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.data.items.map((it) => (
                        <tr key={it.annotation_id} data-annotation={it.annotation_id}>
                          <th scope="row">{it.accession_number || it.study_instance_uid}</th>
                          <td>{SOURCE_LABELS[it.source]}</td>
                          <td>{it.label ? <Badge tone="info">{it.label}</Badge> : '—'}</td>
                          <td>
                            <Badge tone={it.status === 'draft' ? 'warning' : 'success'}>{STATUS_LABELS[it.status]}</Badge>
                          </td>
                          <td>
                            {it.updated_by}　{when(it.updated_at)}
                          </td>
                          <td>
                            <Link
                              className="btn btn--secondary btn--small"
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
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={total}
                  onPageChange={setPage}
                  onPageSizeChange={(n) => {
                    setPageSize(n);
                    setPage(1);
                  }}
                  label="明細分頁"
                />
              </>
            ) : null}
          </Card>
        </SplitLayout>
      </div>

      <SlideOver open={importing} title="匯入診斷結果" onClose={() => setImporting(false)} width="40rem">
        <CsvImport
          labeling={labeling}
          studies={summary.data?.studies ?? []}
          datasets={datasets.data ?? [d]}
          defaultDatasetId={d.id}
          onDone={reload}
          bare
        />
      </SlideOver>
    </>
  );
}
