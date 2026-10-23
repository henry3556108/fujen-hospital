// 影像標註首頁＝待處理清單：進度、繼續標註、篩選（文字、狀態、資料範圍）、分頁。
// CSV 診斷匯入搬到「標註資料集」；訓練改由建立模型精靈處理。
import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { StatusBadge } from '../../components/StatusBadge';
import { useLabelingApi, type LabelingApi } from './api';
import { LabelingNav } from './LabelingNav';
import { formatDate } from './parts';
import { isPendingStudy, nextPendingStudy, progressOf, useScopeStudyUids, useScopes, workbenchPath } from './pending';
import type { StudySummary } from './types';
import './labeling.css';

/** 每頁研究數 */
export const PENDING_PAGE = 20;

type StatusFilter = '' | 'pending' | 'confirmed';

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
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const summary = useResource(() => labeling.summary(), [labeling]);
  const scopes = useScopes();
  const scopeId = Number(search.get('scope')) || null;
  const scopeUids = useScopeStudyUids(scopeId);
  const text = search.get('q') ?? '';
  const status = (search.get('status') ?? '') as StatusFilter;
  const page = Math.max(1, Number(search.get('page')) || 1);
  const data = summary.data;

  const inScope = useMemo(() => {
    const all = data?.studies ?? [];
    return scopeUids.data ? all.filter((s) => scopeUids.data!.has(s.study_instance_uid)) : all;
  }, [data, scopeUids.data]);
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return inScope.filter(
      (s) =>
        (!q || [s.accession_number, s.patient_id, s.study_description].some((v) => v?.toLowerCase().includes(q))) &&
        (status === '' || (status === 'pending') === isPendingStudy(s)),
    );
  }, [inScope, text, status]);
  const lastPage = Math.max(1, Math.ceil(filtered.length / PENDING_PAGE));
  const shown = filtered.slice((page - 1) * PENDING_PAGE, page * PENDING_PAGE);
  // 有選資料範圍時進度只算範圍內；沒選就用 API 的數字
  const progress = scopeId !== null ? progressOf(inScope) : progressOf(inScope, data?.pending, data?.confirmed);
  const next = nextPendingStudy(inScope, null);

  const update = (changes: Record<string, string>) => {
    const q = new URLSearchParams(search);
    for (const [k, v] of Object.entries(changes)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    if (!('page' in changes)) q.delete('page');
    setSearch(q, { replace: true });
  };

  return (
    <>
      <h1>影像標註</h1>
      <LabelingNav />
      <p className="text-muted">
        專案：<strong>{project?.name}</strong>。待處理包括還沒標的影像，以及自動標註後等你確認的草稿。
      </p>
      <ApiErrorAlert error={summary.error ?? scopeUids.error} />
      {data ? (
        <div className="card section stack" data-testid="label-progress">
          <p>
            <strong>
              已確認 {progress.confirmed}／共 {progress.total} 個研究
            </strong>
            　待處理 <strong data-testid="pending-count">{progress.pending}</strong>
          </p>
          <p className="text-muted" data-testid="label-totals">
            共 {data.studies.length} 個研究、{data.total} 筆標註（分類 {data.by_kind.classification}、分割 {data.by_kind.segmentation}、偵測{' '}
            {data.by_kind.detection}），已評分 {data.rated} 筆。
          </p>
          <div className="row-actions">
            {next ? (
              <button type="button" className="btn btn--primary" onClick={() => navigate(workbenchPath(next.study_instance_uid, scopeId))}>
                繼續標註
              </button>
            ) : data.studies.length > 0 ? (
              <span>目前沒有待處理的影像。</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <section className="section" aria-labelledby="studies-title">
        <h2 id="studies-title">待處理清單</h2>
        <form className="form-grid" aria-label="篩選研究" onSubmit={(e) => e.preventDefault()}>
          <div className="field">
            <label htmlFor="pending-q">搜尋</label>
            <input
              id="pending-q"
              className="input"
              value={text}
              placeholder="影像編號、病歷號或檢查說明"
              onChange={(e) => update({ q: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="pending-status">標註狀態</label>
            <select id="pending-status" className="select" value={status} onChange={(e) => update({ status: e.target.value })}>
              <option value="">全部</option>
              <option value="pending">待處理</option>
              <option value="confirmed">已確認</option>
            </select>
          </div>
          {(scopes.data?.length ?? 0) > 0 ? (
            <div className="field">
              <label htmlFor="pending-scope">資料範圍</label>
              <select id="pending-scope" className="select" value={scopeId ?? ''} onChange={(e) => update({ scope: e.target.value })}>
                <option value="">全部影像</option>
                {scopes.data!.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}（{s.study_count} 筆）
                  </option>
                ))}
              </select>
              <span className="field__hint">
                範圍在「研究資料 → 影像清單」篩選後儲存。<Link to="/data/imaging">去設定</Link>
              </span>
            </div>
          ) : null}
        </form>

        {summary.loading && !data ? (
          <p role="status" className="loading">
            載入中…
          </p>
        ) : data && data.studies.length === 0 ? (
          <Alert tone="info">
            專案「{project?.name}」還沒有影像。請先到 <Link to="/data/imaging/import">研究資料 → 加入資料</Link> 匯入影像。
          </Alert>
        ) : data ? (
          <>
            <p className="text-muted" role="status">
              符合條件 {filtered.length} 個研究{filtered.length > PENDING_PAGE ? `，第 ${page}／${lastPage} 頁` : ''}
            </p>
            <StudyTable studies={shown} scopeId={scopeId} />
            {filtered.length > PENDING_PAGE ? (
              <div className="row-actions section">
                <button type="button" className="btn btn--secondary btn--small" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
                  上一頁
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  disabled={page >= lastPage}
                  onClick={() => update({ page: String(page + 1) })}
                >
                  下一頁
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </>
  );
}

function StudyTable({ studies, scopeId }: { studies: StudySummary[]; scopeId: number | null }) {
  return (
    <div className="table-wrap">
      <table aria-label="研究清單">
        <thead>
          <tr>
            <th scope="col">影像編號</th>
            <th scope="col">病歷號</th>
            <th scope="col">檢查日期</th>
            <th scope="col">檢查說明</th>
            <th scope="col">類別</th>
            <th scope="col">分割</th>
            <th scope="col">偵測</th>
            <th scope="col">待確認草稿</th>
            <th scope="col">狀態</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {studies.map((s) => {
            const pending = isPendingStudy(s);
            return (
              <tr key={s.study_instance_uid} data-study={s.study_instance_uid}>
                <th scope="row">{s.accession_number || '（無）'}</th>
                <td>{s.patient_id}</td>
                <td>{formatDate(s.study_date)}</td>
                <td>{s.study_description}</td>
                <td data-testid="study-classes">{s.classification_labels.join('、') || '—'}</td>
                <td>{s.by_kind.segmentation}</td>
                <td>{s.by_kind.detection}</td>
                <td>{s.drafts ?? 0}</td>
                <td>
                  <StatusBadge tone={pending ? 'warning' : 'success'}>{pending ? '待處理' : '已確認'}</StatusBadge>
                </td>
                <td>
                  <Link to={workbenchPath(s.study_instance_uid, scopeId)} aria-label={`開啟 ${s.accession_number || s.study_instance_uid} 的標註工作台`}>
                    開啟標註
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
