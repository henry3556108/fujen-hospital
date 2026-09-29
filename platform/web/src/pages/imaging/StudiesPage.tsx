import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { withQuery } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { formatDicomDate } from '../../components/format';
import { EMPTY_FILTERS, SEX_LABELS, type Study, type StudyFilters } from './types';

const MODALITIES = ['CT', 'MR', 'CR', 'DX', 'US', 'MG', 'PT', 'NM', 'XA'];
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

/** TC-B01-09 研究列表：以 5 個 DICOM 欄位篩選；篩選條件放在網址，重新載入或分享連結都一致。 */
export function StudiesPage() {
  const { api, project } = useSession();
  const pid = project!.id;
  const [params, setParams] = useSearchParams();
  const applied = Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? ''])) as unknown as StudyFilters;
  const appliedKey = KEYS.map((k) => applied[k]).join('|');
  const studies = useResource(() => api.get<Study[]>(withQuery(`/api/projects/${pid}/imaging/studies`, { ...applied })), [pid, appliedKey]);

  const [from0, to0] = splitRange(applied.study_date);
  const [draft, setDraft] = useState({ ...applied, from: from0, to: to0 });

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: StudyFilters = { ...draft, study_date: dateRange(draft.from, draft.to) };
    setParams(Object.fromEntries(KEYS.filter((k) => next[k].trim()).map((k) => [k, next[k].trim()])));
  }

  function clear() {
    setDraft({ ...EMPTY_FILTERS, from: '', to: '' });
    setParams({});
  }

  const active = KEYS.filter((k) => applied[k]);
  const set = (k: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <>
      <h2>研究列表</h2>
      <form aria-label="篩選研究" className="card" onSubmit={submit} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="f-modality">Modality</label>
            <select id="f-modality" className="select" value={draft.modality} onChange={set('modality')}>
              <option value="">全部</option>
              {MODALITIES.map((mo) => (
                <option key={mo} value={mo}>
                  {mo}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-sex">Patient&apos;s Sex</label>
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
            <label htmlFor="f-study-desc">Study Description（包含）</label>
            <input id="f-study-desc" className="input" value={draft.study_description} onChange={set('study_description')} />
          </div>
          <div className="field">
            <label htmlFor="f-series-desc">Series Description（包含）</label>
            <input id="f-series-desc" className="input" value={draft.series_description} onChange={set('series_description')} />
          </div>
          <div className="field">
            <label htmlFor="f-from">Study Date 起</label>
            <input id="f-from" className="input" type="date" value={draft.from} onChange={set('from')} />
          </div>
          <div className="field">
            <label htmlFor="f-to">Study Date 迄</label>
            <input id="f-to" className="input" type="date" value={draft.to} onChange={set('to')} />
          </div>
        </div>
        <div className="row-actions section">
          <button type="submit" className="btn btn--primary">
            套用篩選
          </button>
          <button type="button" className="btn btn--secondary" onClick={clear}>
            清除篩選
          </button>
        </div>
      </form>

      <ApiErrorAlert error={studies.error} />
      <p role="status" className="section">
        {studies.loading && !studies.data
          ? '載入中…'
          : `共 ${studies.data?.length ?? 0} 個研究${active.length ? `（已套用 ${active.length} 個篩選條件）` : ''}`}
      </p>
      <div className="table-wrap">
        <table aria-label="研究列表">
          <thead>
            <tr>
              <th scope="col">Study Date</th>
              <th scope="col">Accession</th>
              <th scope="col">Patient ID</th>
              <th scope="col">Sex</th>
              <th scope="col">Modality</th>
              <th scope="col">Study Description</th>
              <th scope="col">Series Description</th>
              <th scope="col" className="num">
                序列
              </th>
              <th scope="col" className="num">
                影像
              </th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {studies.data?.map((s) => (
              <tr key={s.study_instance_uid}>
                <td>{formatDicomDate(s.study_date)}</td>
                <th scope="row">{s.accession_number ?? '—'}</th>
                <td>{s.patient_id ?? '—'}</td>
                <td>{s.patient_sex ?? '—'}</td>
                <td>{s.modalities.join('、') || '—'}</td>
                <td>{s.study_description ?? '—'}</td>
                <td>{[...new Set(s.series.map((x) => x.series_description).filter(Boolean))].join('、') || '—'}</td>
                <td className="num">{s.series.length}</td>
                <td className="num">{s.instances}</td>
                <td>
                  <Link
                    to={`/data/imaging/studies/${encodeURIComponent(s.study_instance_uid)}`}
                    aria-label={`檢視研究 ${s.accession_number ?? s.study_instance_uid}`}
                  >
                    檢視
                  </Link>
                </td>
              </tr>
            ))}
            {studies.data?.length === 0 && (
              <tr>
                <td colSpan={10}>{active.length ? '沒有符合篩選條件的研究' : '這個專案還沒有影像，請到「匯入影像」或「PACS 查詢取像」'}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
