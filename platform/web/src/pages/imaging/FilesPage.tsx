import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { StatusBadge, type BadgeTone } from '../../components/StatusBadge';
import { FORMAT_LABELS, PAIRING_LABELS, type ImagingFile } from './types';
import { ImagingNav } from './ImagingNav';

const TONE: Record<ImagingFile['pairing'], BadgeTone> = { 'n/a': 'neutral', paired: 'success', unpaired: 'warning' };

function pairedWith(f: ImagingFile): string {
  if (f.paired_image) return f.paired_image;
  if (f.paired_studies?.length) {
    return f.paired_studies
      .map((st) => `${[st.accession_number || '（無 Accession）', st.study_description].filter(Boolean).join(' ')}（${st.instances} 張）`)
      .join('；');
  }
  if (f.paired_sop_instance_uids.length) return `${f.paired_sop_instance_uids.length} 張 DICOM 影像`;
  return '—';
}

function metaText(f: ImagingFile): string {
  const dims = f.meta.dims;
  if (Array.isArray(dims)) return `尺寸 ${dims.join(' × ')}`;
  if (typeof f.meta.annotations === 'number') return `${f.meta.annotations} 筆標註`;
  return '—';
}

/** TC-B01-03、04：NIfTI／ITK／makesense 檔案與「影像—標註」配對狀態。 */
export function FilesPage() {
  const { api, project } = useSession();
  const files = useResource(() => api.get<ImagingFile[]>(`/api/projects/${project!.id}/imaging/files`), [project!.id]);
  const unpaired = (files.data ?? []).filter((f) => f.pairing === 'unpaired').length;

  return (
    <>
      <ImagingNav />
      <div className="page-head">
        <h2>檔案與配對</h2>
        <button type="button" className="btn btn--secondary" onClick={files.reload} disabled={files.loading}>
          重新整理
        </button>
      </div>
      <p className="text-muted">
        標註檔只在同一個專案內配對。先匯入標註、後匯入影像也可以，每次匯入後會重新配對尚未配對的標註。
      </p>
      <ApiErrorAlert error={files.error} />
      <p role="status">
        {files.loading && !files.data ? '載入中…' : `共 ${files.data?.length ?? 0} 個檔案，${unpaired} 個標註尚未配對`}
      </p>
      <div className="table-wrap">
        <table aria-label="檔案列表">
          <thead>
            <tr>
              <th scope="col">檔名</th>
              <th scope="col">格式</th>
              <th scope="col">角色</th>
              <th scope="col">Case</th>
              <th scope="col">內容</th>
              <th scope="col">配對</th>
              <th scope="col">配對對象</th>
              <th scope="col">說明</th>
            </tr>
          </thead>
          <tbody>
            {files.data?.map((f) => (
              <tr key={f.id}>
                <th scope="row" className="mono">
                  {f.filename}
                </th>
                <td>{FORMAT_LABELS[f.format] ?? f.format}</td>
                <td>{f.role === 'image' ? '影像' : '標註'}</td>
                <td>{f.case ?? '—'}</td>
                <td>{metaText(f)}</td>
                <td>
                  <StatusBadge tone={TONE[f.pairing] ?? 'neutral'}>{PAIRING_LABELS[f.pairing] ?? f.pairing}</StatusBadge>
                </td>
                <td className="mono">{pairedWith(f)}</td>
                <td>{f.pairing_note || '—'}</td>
              </tr>
            ))}
            {files.data?.length === 0 && (
              <tr>
                <td colSpan={8}>這個專案還沒有 NIfTI、ITK 或 makesense 檔案</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
