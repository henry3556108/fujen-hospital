import { Link, useParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { formatDicomDate } from '../../components/format';
import { Icon } from '../../components/Icon';
import { DicomThumb } from '../../components/ui';
import type { Study } from './types';

/** 研究明細（影像清單的「檢視」）：研究資訊與各序列縮圖；不在專案內或不在 Accession 清單內時 API 回 404。 */
export function StudyDetailPage() {
  const { api, project } = useSession();
  const pid = project!.id;
  const { studyUid = '' } = useParams();
  const study = useResource(
    () => api.get<Study>(`/api/projects/${pid}/imaging/studies/${encodeURIComponent(studyUid)}`),
    [pid, studyUid],
  );
  const s = study.data;

  return (
    <>
      <p className="rd-crumbs">
        <Link to="/data/imaging">
          <Icon name="chevron-left" /> 回影像清單
        </Link>
      </p>
      <div className="rd-section-head">
        <h2>研究明細</h2>
        {studyUid && (
          <Link to={`/labeling/studies/${encodeURIComponent(studyUid)}`} className="btn btn--primary">
            開始標註
          </Link>
        )}
      </div>
      <ApiErrorAlert error={study.error} />
      {study.loading && !s && <p role="status">載入中…</p>}
      {s && !study.error && (
        <>
          <section className="card rd-study-head" aria-label="研究資訊">
            <DicomThumb
              projectId={pid}
              studyUid={s.study_instance_uid}
              seriesUid={s.series[0]?.series_instance_uid}
              alt={`${s.accession_number ?? s.study_instance_uid} 縮圖`}
              size={160}
            />
            <dl className="kv">
              <dt>Accession Number</dt>
              <dd>{s.accession_number ?? '—'}</dd>
              <dt>Study Instance UID</dt>
              <dd className="mono">{s.study_instance_uid}</dd>
              <dt>Patient ID</dt>
              <dd>{s.patient_id ?? '—'}</dd>
              <dt>Patient&apos;s Sex</dt>
              <dd>{s.patient_sex ?? '—'}</dd>
              <dt>Study Date</dt>
              <dd>{formatDicomDate(s.study_date)}</dd>
              <dt>Study Description</dt>
              <dd>{s.study_description ?? '—'}</dd>
              <dt>Modality</dt>
              <dd>{s.modalities.join('、') || '—'}</dd>
              <dt>影像數</dt>
              <dd>{s.instances}</dd>
              <dt>DICOMweb 路徑</dt>
              <dd className="mono">
                /dicomweb/projects/{pid}/studies/{s.study_instance_uid}
              </dd>
            </dl>
          </section>
          <div className="table-wrap section">
            <table aria-label="序列列表">
              <thead>
                <tr>
                  <th scope="col">Series Description</th>
                  <th scope="col">預覽</th>
                  <th scope="col">Modality</th>
                  <th scope="col">Series Instance UID</th>
                  <th scope="col" className="num">
                    影像
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.series.map((x) => (
                  <tr key={x.series_instance_uid}>
                    <th scope="row">{x.series_description ?? '—'}</th>
                    <td>
                      <DicomThumb
                        projectId={pid}
                        studyUid={s.study_instance_uid}
                        seriesUid={x.series_instance_uid}
                        alt={`${x.series_description ?? x.series_instance_uid} 縮圖`}
                      />
                    </td>
                    <td>{x.modality ?? '—'}</td>
                    <td className="mono">{x.series_instance_uid}</td>
                    <td className="num">{x.instances}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
