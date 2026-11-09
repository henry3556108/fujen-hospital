import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { withQuery } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { formatDicomDate } from '../../components/format';
import { Icon } from '../../components/Icon';
import { Badge, DicomThumb, Pagination, SlideOver, type BadgeTone } from '../../components/ui';
import { useProjectAccess } from '../data/access';
import { ImagingNav } from './ImagingNav';
import { AddDataPanel, sourceOf } from './ImportPage';
import { ScopeSelect, useScopes } from './ScopeSelect';
import { EMPTY_FILTERS, SEX_LABELS, type Scope, type ScopeFilters, type Study, type StudyFilters } from './types';

const MODALITIES = ['CT', 'MR', 'CR', 'DX', 'US', 'MG', 'PT', 'NM', 'XA'];
/** 每頁研究數（API 的 limit）預設值；可在分頁列改成 20／100 */
export const STUDY_PAGE = 50;
const PAGE_SIZES = [20, 50, 100];

interface StudyPage {
  items: Study[];
  total: number;
  offset: number;
  limit: number;
}
const KEYS = Object.keys(EMPTY_FILTERS) as (keyof StudyFilters)[];

const toDicom = (date: string) => date.replaceAll('-', '');
const toInput = (dicom: string) => (/^\d{8}$/.test(dicom) ? `${dicom.slice(0, 4)}-${dicom.slice(4, 6)}-${dicom.slice(6)}` : '');

/** 起訖日期 → API 的 study_date（YYYYMMDD 或 YYYYMMDD-YYYYMMDD，可只給一邊） */
export function dateRange(from: string, to: string): string {
  const a = toDicom(from);
  const b = toDicom(to);
  if (!a && !b) return '';
  if (a && a === b) return a;
  return `${a}-${b}`;
}

function splitRange(value: string): [string, string] {
  if (!value) return ['', ''];
  if (!value.includes('-')) return [toInput(value), toInput(value)];
  const [a, b] = value.split('-', 2);
  return [toInput(a), toInput(b)];
}

/** 描述欄最多兩行，超過省略，滑過看全文 */
function Clamp({ text }: { text: string }) {
  return (
    <span className="rd-clamp" title={text}>
      {text}
    </span>
  );
}

/** 表格裡的性別用中文 */
const SEX_SHORT: Record<string, string> = { F: '女', M: '男', O: '其他' };

/** 研究的標註狀態（取自 /labels/summary；舊後端沒有 drafts／confirmed 時，有標註就當已確認） */
type LabelState = 'confirmed' | 'draft' | 'none';
const LABEL_STATE: Record<LabelState, { text: string; tone: BadgeTone }> = {
  confirmed: { text: '已確認', tone: 'success' },
  draft: { text: '待確認', tone: 'warning' },
  none: { text: '未標註', tone: 'neutral' },
};
interface LabelCounts {
  study_instance_uid: string;
  annotations: number;
  drafts?: number;
  confirmed?: number;
}
export function labelState(c: LabelCounts | undefined): LabelState {
  if (!c) return 'none';
  if ((c.drafts ?? 0) > 0) return 'draft';
  if ((c.confirmed ?? c.annotations) > 0) return 'confirmed';
  return 'none';
}

/** 目前的篩選條件（只留有值的 key）疊在範圍原本的條件上 → 要存的資料範圍 filters */
export function scopeFilters(applied: StudyFilters, base: ScopeFilters = {}): ScopeFilters {
  const out: ScopeFilters = { ...base };
  for (const k of KEYS) if (applied[k]) out[k] = applied[k];
  return out;
}

/** 把目前的篩選條件存成資料範圍（需要 Labeling 權限）；按「儲存資料範圍」後出現。 */
function SaveScope({ filters, onSaved, onCancel }: { filters: ScopeFilters; onSaved: (scope: Scope) => void; onCancel: () => void }) {
  const { api, project } = useSession();
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(new Error('請輸入資料範圍名稱'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const scope = await api.post<Scope>(`/api/projects/${project!.id}/imaging/scopes`, { name: name.trim(), filters });
      setName('');
      onSaved(scope);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="儲存資料範圍" className="card section" onSubmit={submit} noValidate>
      <ApiErrorAlert error={error} />
      <p className="text-muted">
        資料範圍存的是目前的篩選條件，之後新加入、符合條件的影像也會算在裡面。儲存資料範圍只是研究選取，不會改變專案的 Accession Number 清單。
      </p>
      <div className="field">
        <label htmlFor="scope-name">資料範圍名稱</label>
        <input id="scope-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn--secondary" disabled={busy}>
          儲存
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/**
 * TC-B01-09 影像清單（A02、B06）：5 個 DICOM 欄位篩選、縮圖、標註狀態，可選或儲存資料範圍，直接檢視或開始標註；
 * 篩選條件、頁碼、每頁筆數放在網址，重新載入或部署連結都一致。
 * adding：/data/imaging/import 時開著右側「匯入資料」滑出面板。
 */
export function StudiesPage({ adding = false }: { adding?: boolean }) {
  const { api, project } = useSession();
  const { can } = useProjectAccess();
  const navigate = useNavigate();
  const pid = project!.id;
  const [params, setParams] = useSearchParams();
  const applied = Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? ''])) as unknown as StudyFilters;
  const scopeId = params.get('scope_id') ? Number(params.get('scope_id')) : null;
  const appliedKey = KEYS.map((k) => applied[k]).join('|');
  const size = PAGE_SIZES.includes(Number(params.get('size'))) ? Number(params.get('size')) : STUDY_PAGE;
  const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
  const offset = (page - 1) * size;
  const studies = useResource(
    () =>
      api.get<StudyPage>(
        withQuery(`/api/projects/${pid}/imaging/studies`, {
          ...applied,
          scope_id: scopeId ?? undefined,
          limit: size,
          offset: offset || undefined,
        }),
      ),
    [pid, appliedKey, scopeId, offset, size],
  );
  const scopes = useScopes();
  // 標註狀態：讀不到（舊後端或錯誤）就不顯示這一欄
  const labels = useResource(
    () => api.get<{ studies: LabelCounts[] }>(`/api/projects/${pid}/labels/summary`).catch(() => null),
    [pid],
  );
  const labelOf = useMemo(() => new Map((labels.data?.studies ?? []).map((s) => [s.study_instance_uid, s])), [labels.data]);
  const showLabels = Boolean(labels.data);
  const total = studies.data?.total ?? 0;
  const shown = studies.data?.items ?? [];
  const lastPage = Math.max(1, Math.ceil(total / size));
  const scope = scopes.data?.find((s) => s.id === scopeId) ?? null;
  const [notice, setNotice] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [savingScope, setSavingScope] = useState(false);

  /** 網址上除了匯入資料來源以外的查詢字串（篩選、範圍、頁碼） */
  function listQuery(): string {
    const q = new URLSearchParams(params);
    q.delete('source');
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  // 關閉匯入資料面板後重新載入清單與標註狀態（剛匯入的影像要出現）
  const wasAdding = useRef(adding);
  useEffect(() => {
    if (wasAdding.current && !adding) {
      studies.reload();
      labels.reload();
    }
    wasAdding.current = adding;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);

  function goTo(next: number, nextSize = size) {
    const q = new URLSearchParams(params);
    if (next <= 1) q.delete('page');
    else q.set('page', String(next));
    if (nextSize === STUDY_PAGE) q.delete('size');
    else q.set('size', String(nextSize));
    setParams(q);
  }

  useEffect(() => {
    // 網址上的頁碼超過最後一頁（例如資料被刪掉）：改看最後一頁
    if (studies.data && shown.length === 0 && total > 0 && page > lastPage) goTo(lastPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studies.data]);

  const [from0, to0] = splitRange(applied.study_date);
  const [draft, setDraft] = useState({ ...applied, from: from0, to: to0 });
  const emptyDraft = { ...EMPTY_FILTERS, from: '', to: '' };

  function query(next: StudyFilters, nextScope: number | null) {
    const q: Record<string, string> = Object.fromEntries(KEYS.filter((k) => next[k].trim()).map((k) => [k, next[k].trim()]));
    if (nextScope != null) q.scope_id = String(nextScope);
    if (size !== STUDY_PAGE) q.size = String(size);
    setParams(q);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    query({ ...draft, study_date: dateRange(draft.from, draft.to) }, scopeId);
  }

  function clear() {
    setDraft(emptyDraft);
    setParams(size !== STUDY_PAGE ? { size: String(size) } : {});
  }

  function chooseScope(next: Scope | null) {
    // 換範圍時清掉手動篩選，範圍內可再自行篩選
    setDraft(emptyDraft);
    query(EMPTY_FILTERS, next?.id ?? null);
    setNotice(null);
  }

  const active = KEYS.filter((k) => applied[k]);
  const set = (k: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));
  const cols = showLabels ? 11 : 10;

  return (
    <>
      <ImagingNav />
      <div className="rd-section-head">
        <h2>影像清單</h2>
        {can('labeling') && (
          <Link to={`/data/imaging/import${listQuery()}`} className="btn btn--primary">
            <Icon name="upload" /> 匯入資料
          </Link>
        )}
      </div>

      <form aria-label="篩選影像" className="rd-filter" onSubmit={submit} noValidate>
        <div className="rd-filter__head">
          <h3 className="rd-filter__title">篩選條件</h3>
          <button
            type="button"
            className="rd-filter__toggle"
            aria-expanded={filtersOpen}
            aria-controls="study-filter-body"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            {filtersOpen ? '收合' : '展開'} <Icon name="chevron-down" />
          </button>
        </div>
        <div id="study-filter-body" className="rd-filter__body" hidden={!filtersOpen}>
          <div className="rd-filter__grid">
            {scopes.data && scopes.data.length > 0 && <ScopeSelect id="f-scope" scopes={scopes.data} value={scopeId} onChange={chooseScope} />}
            <div className="field">
              <label htmlFor="f-modality" title="DICOM 欄位 Modality">
                Modality
              </label>
              <select id="f-modality" className="select" title="DICOM 欄位 Modality" value={draft.modality} onChange={set('modality')}>
                <option value="">全部</option>
                {MODALITIES.map((mo) => (
                  <option key={mo} value={mo}>
                    {mo}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-sex">Patient's Sex</label>
              <select id="f-sex" className="select" value={draft.patient_sex} onChange={set('patient_sex')}>
                <option value="">全部</option>
                {Object.entries(SEX_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-study-desc" title="DICOM 欄位 Study Description，輸入部分文字即可">
                Study Description<span className="visually-hidden">（包含）</span>
              </label>
              <input id="f-study-desc" className="input" placeholder="Study Description" value={draft.study_description} onChange={set('study_description')} />
            </div>
            <div className="field rd-filter__wide" role="group" aria-labelledby="f-date-label">
              <span id="f-date-label" className="field__label" title="DICOM 欄位 Study Date">
                Study Date<span className="visually-hidden">（Study Date）</span>
              </span>
              <span className="rd-date-range">
                <input id="f-from" className="input" type="date" aria-label="Study Date 起" value={draft.from} onChange={set('from')} />
                <span aria-hidden="true">–</span>
                <input id="f-to" className="input" type="date" aria-label="Study Date 迄" value={draft.to} onChange={set('to')} />
              </span>
            </div>
            <div className="field">
              <label htmlFor="f-series-desc" title="DICOM 欄位 Series Description，輸入部分文字即可">
                Series Description<span className="visually-hidden">（包含）</span>
              </label>
              <input id="f-series-desc" className="input" placeholder="Series Description" value={draft.series_description} onChange={set('series_description')} />
            </div>
          </div>
          <div className="rd-filter__actions">
            <button type="submit" className="btn btn--primary">
              <Icon name="search" /> 套用篩選
            </button>
            {can('labeling') && (
              <button type="button" className="btn btn--secondary" aria-expanded={savingScope} onClick={() => setSavingScope((v) => !v)}>
                儲存資料範圍
              </button>
            )}
            <button type="button" className="btn btn--secondary" onClick={clear}>
              清除篩選
            </button>
          </div>
        </div>
      </form>

      {can('labeling') && savingScope && (
        <SaveScope
          key={`${scopeId}|${appliedKey}`}
          filters={scopeFilters(applied, scope?.filters)}
          onCancel={() => setSavingScope(false)}
          onSaved={(saved) => {
            scopes.setData([...(scopes.data ?? []), saved]);
            setDraft(emptyDraft);
            setSavingScope(false);
            query(EMPTY_FILTERS, saved.id);
            setNotice(`已儲存資料範圍「${saved.name}」，共 ${saved.study_count} 筆影像。標註時可以選這個範圍。`);
          }}
        />
      )}

      <ApiErrorAlert error={studies.error} />
      {notice && <Alert tone="success">{notice}</Alert>}
      <p role="status" className="rd-count">
        {studies.loading && !studies.data
          ? '載入中…'
          : `共 ${total} 筆影像${scope ? `（資料範圍「${scope.name}」）` : ''}${active.length ? `（已套用 ${active.length} 個篩選條件）` : ''}${shown.length ? `，第 ${offset + 1}–${offset + shown.length} 筆` : ''}`}
      </p>
      <div className="rd-table-card">
        <div className="table-wrap rd-hscroll">
          <table aria-label="影像清單" className="rd-study-table">
            <thead>
              <tr>
                <th scope="col" className="rd-nowrap">影像編號</th>
                <th scope="col" className="rd-nowrap">Study Date</th>
                <th scope="col" className="rd-nowrap">Modality</th>
                <th scope="col" className="rd-desc">Study Description</th>
                <th scope="col" className="rd-desc">Series Description</th>
                <th scope="col" className="rd-nowrap">病歷號</th>
                <th scope="col" className="rd-nowrap">Patient's Sex</th>
                <th scope="col" className="num rd-nowrap">
                  序列數
                </th>
                <th scope="col" className="num rd-nowrap">
                  影像數
                </th>
                {showLabels && <th scope="col" className="rd-nowrap">標註狀態</th>}
                <th scope="col" className="rd-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const name = s.accession_number ?? s.study_instance_uid;
                const state = LABEL_STATE[labelState(labelOf.get(s.study_instance_uid))];
                return (
                  <tr key={s.study_instance_uid}>
                    <th scope="row" className="rd-nowrap">
                      <span className="rd-case">
                        <DicomThumb
                          projectId={pid}
                          studyUid={s.study_instance_uid}
                          seriesUid={s.series[0]?.series_instance_uid}
                          alt={`${name} 縮圖`}
                          size={48}
                        />
                        <span className="rd-case__name">{s.accession_number ?? '—'}</span>
                      </span>
                    </th>
                    <td className="rd-nowrap">{formatDicomDate(s.study_date)}</td>
                    <td className="rd-nowrap">{s.modalities.join('、') || '—'}</td>
                    <td className="rd-desc">
                      <Clamp text={s.study_description ?? '—'} />
                    </td>
                    <td className="rd-desc">
                      <Clamp text={[...new Set(s.series.map((x) => x.series_description).filter(Boolean))].join('、') || '—'} />
                    </td>
                    <td className="rd-nowrap">{s.patient_id ?? '—'}</td>
                    <td className="rd-nowrap">{s.patient_sex ? (SEX_SHORT[s.patient_sex] ?? s.patient_sex) : '—'}</td>
                    <td className="num">{s.series.length}</td>
                    <td className="num">{s.instances}</td>
                    {showLabels && (
                      <td className="rd-nowrap">
                        <Badge tone={state.tone}>{state.text}</Badge>
                      </td>
                    )}
                    <td>
                      <span className="rd-actions">
                        {/* 舊名稱「預覽」保留為無障礙名稱（驗收腳本沿用） */}
                        <Link
                          to={`/data/imaging/studies/${encodeURIComponent(s.study_instance_uid)}`}
                          className="btn btn--secondary btn--small"
                          aria-label={`預覽 ${name}`}
                        >
                          檢視
                        </Link>
                        {can('labeling') && (
                          <Link
                            to={`/labeling/studies/${encodeURIComponent(s.study_instance_uid)}`}
                            className="btn btn--secondary btn--small"
                            aria-label={`開始標註 ${name}`}
                          >
                            開始標註
                          </Link>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {studies.data && total === 0 && (
                <tr>
                  <td colSpan={cols}>
                    {active.length || scope ? '沒有符合篩選條件的影像' : '這個專案還沒有影像，請按「匯入資料」上傳或從影像儲傳系統取得'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {total > 0 && (
          <Pagination
            label="影像清單分頁"
            page={Math.min(page, lastPage)}
            pageSize={size}
            total={total}
            pageSizeOptions={PAGE_SIZES}
            onPageChange={(p) => goTo(p)}
            onPageSizeChange={(n) => goTo(1, n)}
          />
        )}
      </div>

      <SlideOver open={adding} title="匯入資料" width="44rem" closeOnBackdrop={false} onClose={() => navigate(`/data/imaging${listQuery()}`)}>
        <AddDataPanel
          source={sourceOf(params.get('source'))}
          onSource={(next) => {
            const q = new URLSearchParams(params);
            if (next === 'upload') q.delete('source');
            else q.set('source', next);
            setParams(q, { replace: true });
          }}
        />
      </SlideOver>
    </>
  );
}
