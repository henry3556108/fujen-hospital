import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { useProjectAccess } from '../data/access';
import { AllowlistView } from './AllowlistEditor';
import { ImagingNav } from './ImagingNav';
import type { Allowlist } from './types';

export { parseAccessions } from './AllowlistEditor';

/** TC-B01-08 Accession Number 清單（研究區唯讀）：由 Admin 在管理區的專案頁設定；空清單代表不限制。 */
export function AllowlistPage() {
  const { api, project } = useSession();
  const { isAdmin } = useProjectAccess();
  const list = useResource(() => api.get<Allowlist>(`/api/projects/${project!.id}/imaging/accession-allowlist`), [project!.id]);

  return (
    <>
      <ImagingNav />
      <h2>Accession Number 清單</h2>
      <p className="text-muted">
        這份清單決定專案「看得到哪些影像」（以 Accession Number 列出）。清單外的影像不會顯示，從影像儲傳系統取得時也會被拒絕。
      </p>
      <ApiErrorAlert error={list.error} />
      {list.loading && !list.data && <p role="status">載入中…</p>}
      {list.data && <AllowlistView items={list.data.accession_numbers} />}
      {isAdmin ? (
        <Alert tone="info">
          要修改清單，請到管理區的 <Link to={`/admin/projects/${project!.id}`}>專案設定</Link>。
        </Alert>
      ) : (
        <Alert tone="info">清單由系統管理者設定，需要調整請聯絡系統管理者。</Alert>
      )}
    </>
  );
}
