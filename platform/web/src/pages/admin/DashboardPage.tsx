import { Link } from 'react-router-dom';
import type { AdminDashboard } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: '排隊中',
  running: '執行中',
  succeeded: '已完成',
  failed: '失敗',
  cancelled: '已取消',
  held: '已暫存',
};

function Tile({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <li className="card stat-tile">
      <span className="stat-tile__label">{label}</span>
      <span className="stat-tile__value">{value.toLocaleString('zh-TW')}</span>
      {note && <span className="text-muted">{note}</span>}
    </li>
  );
}

/** A-03「可檢視 Dashboard 頁面」：數字都是後端即時的資料庫筆數（TC-A03-10 以資料庫比對）。 */
export function DashboardPage() {
  const { api } = useSession();
  const board = useResource(() => api.get<AdminDashboard>('/api/admin/dashboard'));
  const d = board.data;
  return (
    <div className="section">
      <div className="page-head">
        <h2>Dashboard（系統總覽）</h2>
        <button type="button" className="btn btn--secondary" onClick={board.reload} disabled={board.loading}>
          重新整理
        </button>
      </div>
      <ApiErrorAlert error={board.error} />
      {board.loading && !d && <p role="status">載入中…</p>}
      {d && (
        <>
          <p className="text-muted">
            資料時間：{new Date(d.generated_at).toLocaleString('zh-TW', { hour12: false })}（按「重新整理」取得最新數字）
          </p>
          <ul className="stat-grid section" aria-label="平台總覽">
            <Tile label="帳號" value={d.accounts.total} note={`Admin ${d.accounts.admin}、User ${d.accounts.user}`} />
            <Tile label="專案" value={d.projects} />
            <Tile label="專案成員" value={d.memberships} note="帳號加入專案的次數" />
            <Tile label="標註群組" value={d.labeling_groups} note={`群組成員 ${d.labeling_group_members}`} />
            <Tile label="結構式資料集" value={d.tabular_datasets} />
            <Tile label="影像研究" value={d.imaging_studies} />
            <Tile label="GPU 群組" value={d.gpu_groups} />
            <Tile label="排程工作" value={d.jobs.total} />
          </ul>

          <h3>排程工作狀態</h3>
          <ul className="stat-grid section" aria-label="排程工作狀態">
            {Object.entries(d.jobs.by_status).map(([status, n]) => (
              <Tile key={status} label={JOB_STATUS_LABELS[status] ?? status} value={n} />
            ))}
          </ul>

          <h3>各專案</h3>
          <div className="table-wrap">
            <table aria-label="各專案筆數">
              <thead>
                <tr>
                  <th scope="col">專案</th>
                  <th scope="col">GPU 群組</th>
                  <th scope="col">成員</th>
                  <th scope="col">標註群組</th>
                  <th scope="col">結構式資料集</th>
                  <th scope="col">影像研究</th>
                  <th scope="col">排程工作</th>
                </tr>
              </thead>
              <tbody>
                {d.per_project.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      還沒有專案，請到 <Link to="/admin/projects">專案</Link> 新增。
                    </td>
                  </tr>
                )}
                {d.per_project.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.name}</th>
                    <td>{p.gpu_group ?? '不綁定'}</td>
                    <td>{p.members}</td>
                    <td>{p.labeling_groups}</td>
                    <td>{p.tabular_datasets}</td>
                    <td>{p.imaging_studies}</td>
                    <td>{p.jobs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
