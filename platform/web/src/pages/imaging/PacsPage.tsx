import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { formatDicomDate } from '../../components/format';
import { useProjectAccess } from '../data/access';
import { ImportResult } from './ImportResult';
import { dateRange } from './StudiesPage';
import { SEX_LABELS, type ImportJob, type PacsAnswer } from './types';

const EMPTY = { Modality: '', PatientID: '', AccessionNumber: '', StudyDescription: '', PatientSex: '', from: '', to: '' };

/** TC-B01-07 PACS 查詢取像：C-FIND 查詢（Study 層級）後，逐一 C-MOVE 取回到平台節點。需要 Labeling 權限。 */
export function PacsPage() {
  const { api } = useSession();
  const { project, can, missing } = useProjectAccess();
  const base = `/api/projects/${project!.id}/imaging/pacs`;
  const [q, setQ] = useState(EMPTY);
  const [answers, setAnswers] = useState<PacsAnswer[] | null>(null);
  /** 從送出查詢到收到 PACS 回應的秒數（B-01 判準：30 秒內） */
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retrieveError, setRetrieveError] = useState<unknown>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!can('labeling')) {
    return (
      <>
        <h2>PACS 查詢取像</h2>
        <Alert tone="warning" title="沒有權限">
          {missing('labeling', '向 PACS 查詢或取回影像')}
        </Alert>
      </>
    );
  }

  async function query(e: FormEvent) {
    e.preventDefault();
    setBusy('query');
    setError(null);
    setRetrieveError(null);
    setJob(null);
    const body: Record<string, string> = {};
    for (const k of ['Modality', 'PatientID', 'AccessionNumber', 'StudyDescription', 'PatientSex'] as const) {
      if (q[k].trim()) body[k] = k === 'StudyDescription' ? `*${q[k].trim()}*` : q[k].trim();
    }
    const date = dateRange(q.from, q.to);
    if (date) body.StudyDate = date;
    const started = performance.now();
    try {
      const result = await api.post<PacsAnswer[]>(`${base}/query`, body);
      setElapsed((performance.now() - started) / 1000);
      setAnswers(result);
    } catch (err) {
      setError(err);
      setAnswers(null);
    } finally {
      setBusy(null);
    }
  }

  async function retrieve(a: PacsAnswer) {
    setBusy(a.StudyInstanceUID);
    setRetrieveError(null);
    setJob(null);
    try {
      setJob(await api.post<ImportJob>(`${base}/retrieve`, { study_instance_uid: a.StudyInstanceUID }));
    } catch (err) {
      setRetrieveError(err);
    } finally {
      setBusy(null);
    }
  }

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setQ((v) => ({ ...v, [k]: e.target.value }));

  return (
    <>
      <h2>PACS 查詢取像</h2>
      <p className="text-muted">專案有 Accession 清單時，只會列出清單內的研究。</p>
      <form aria-label="查詢 PACS" className="card" onSubmit={query} noValidate>
        <ApiErrorAlert error={error} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="p-modality">Modality</label>
            <input id="p-modality" className="input" value={q.Modality} onChange={set('Modality')} placeholder="例如 CT" />
          </div>
          <div className="field">
            <label htmlFor="p-accession">Accession Number</label>
            <input id="p-accession" className="input" value={q.AccessionNumber} onChange={set('AccessionNumber')} />
          </div>
          <div className="field">
            <label htmlFor="p-patient">Patient ID</label>
            <input id="p-patient" className="input" value={q.PatientID} onChange={set('PatientID')} />
          </div>
          <div className="field">
            <label htmlFor="p-sex">Patient&apos;s Sex</label>
            <select id="p-sex" className="select" value={q.PatientSex} onChange={set('PatientSex')}>
              <option value="">全部</option>
              {Object.entries(SEX_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="p-desc">Study Description（包含）</label>
            <input id="p-desc" className="input" value={q.StudyDescription} onChange={set('StudyDescription')} />
          </div>
          <div className="field">
            <label htmlFor="p-from">Study Date 起</label>
            <input id="p-from" className="input" type="date" value={q.from} onChange={set('from')} />
          </div>
          <div className="field">
            <label htmlFor="p-to">Study Date 迄</label>
            <input id="p-to" className="input" type="date" value={q.to} onChange={set('to')} />
          </div>
        </div>
        <div className="row-actions section">
          <button type="submit" className="btn btn--primary" disabled={busy !== null}>
            {busy === 'query' ? '查詢中…' : '查詢 PACS'}
          </button>
        </div>
      </form>

      <ApiErrorAlert error={retrieveError} />
      {job && (
        <>
          <ImportResult job={job} title="PACS 取像結果" />
          <p>
            <Link to="/data/imaging">到研究列表查看</Link>
          </p>
        </>
      )}

      {answers && (
        <section className="section" aria-labelledby="pacs-answers">
          <h3 id="pacs-answers">查詢結果</h3>
          <p role="status">
            PACS 回覆 {answers.length} 個研究
            {elapsed !== null && <span>，回應時間 {elapsed.toFixed(1)} 秒</span>}
          </p>
          <div className="table-wrap">
            <table aria-label="PACS 查詢結果">
              <thead>
                <tr>
                  <th scope="col">Study Date</th>
                  <th scope="col">Accession</th>
                  <th scope="col">Patient ID</th>
                  <th scope="col">Sex</th>
                  <th scope="col">Modality</th>
                  <th scope="col">Study Description</th>
                  <th scope="col" className="num">
                    影像
                  </th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {answers.map((a) => (
                  <tr key={a.StudyInstanceUID}>
                    <td>{formatDicomDate(a.StudyDate)}</td>
                    <th scope="row">{a.AccessionNumber || '—'}</th>
                    <td>{a.PatientID || '—'}</td>
                    <td>{a.PatientSex || '—'}</td>
                    <td>{(a.ModalitiesInStudy ?? a.Modality ?? '').split('\\').join('、') || '—'}</td>
                    <td>{a.StudyDescription || '—'}</td>
                    <td className="num">{a.NumberOfStudyRelatedInstances ?? '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--secondary btn--small"
                        aria-label={`取回 ${a.AccessionNumber || a.StudyInstanceUID}`}
                        disabled={busy !== null}
                        onClick={() => void retrieve(a)}
                      >
                        {busy === a.StudyInstanceUID ? '取回中…' : '取回'}
                      </button>
                    </td>
                  </tr>
                ))}
                {answers.length === 0 && (
                  <tr>
                    <td colSpan={8}>PACS 沒有符合條件的研究</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
