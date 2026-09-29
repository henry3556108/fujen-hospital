import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { StatusBadge } from '../../components/StatusBadge';
import { SchedulingPage } from './SchedulingRoutes';
import type { ClusterNode } from './types';

const POOL_USE: Record<string, string> = {
  'cpu-web': '網頁服務',
  'cpu-data': '資料清洗',
  'gpu-exclusive': 'GPU 獨占',
  'gpu-shared': 'GPU 共享',
};

/** TC-C01-01 節點清單：直接讀 Kubernetes，新增節點後自動出現（TC-C01-07）。 */
export function ClusterNodesPage() {
  const { api } = useSession();
  const nodes = useResource(() => api.get<ClusterNode[]>('/api/admin/cluster/nodes'));
  const list = nodes.data ?? [];
  const ready = list.filter((n) => n.ready).length;
  const physical = list.reduce((a, n) => a + n.gpu_physical, 0);
  const capacity = list.reduce((a, n) => a + n.gpu_capacity, 0);

  return (
    <SchedulingPage title="叢集節點">
      <div className="page-head">
        <p className="text-muted">節點清單直接讀取叢集，不需另外設定。</p>
        <button type="button" className="btn btn--secondary" onClick={nodes.reload} disabled={nodes.loading}>
          重新整理
        </button>
      </div>
      <ApiErrorAlert error={nodes.error} />
      {nodes.data && (
        <ul className="stat-grid section" aria-label="叢集摘要">
          <li className="card stat-tile">
            <span className="stat-tile__label">節點數</span>
            <span className="stat-tile__value">{list.length}</span>
          </li>
          <li className="card stat-tile">
            <span className="stat-tile__label">就緒節點</span>
            <span className="stat-tile__value">{ready}</span>
          </li>
          <li className="card stat-tile">
            <span className="stat-tile__label">實體 GPU</span>
            <span className="stat-tile__value">{physical}</span>
          </li>
          <li className="card stat-tile">
            <span className="stat-tile__label">可排程 GPU 份數</span>
            <span className="stat-tile__value">{capacity}</span>
          </li>
        </ul>
      )}
      <div className="table-wrap section">
        <table aria-label="叢集節點列表">
          <thead>
            <tr>
              <th scope="col">節點</th>
              <th scope="col">節點池</th>
              <th scope="col">用途</th>
              <th scope="col">狀態</th>
              <th scope="col" className="num">
                實體 GPU
              </th>
              <th scope="col" className="num">
                GPU 份數
              </th>
              <th scope="col" className="num">
                可分配
              </th>
            </tr>
          </thead>
          <tbody>
            {nodes.loading && !nodes.data && (
              <tr>
                <td colSpan={7} role="status">
                  載入中…
                </td>
              </tr>
            )}
            {list.map((n) => (
              <tr key={n.name}>
                <th scope="row" className="mono">
                  {n.name}
                </th>
                <td>{n.pool ?? '—'}</td>
                <td>{n.pool ? (POOL_USE[n.pool] ?? n.pool) : '控制平面'}</td>
                <td>{n.ready ? <StatusBadge tone="success">就緒</StatusBadge> : <StatusBadge tone="error">未就緒</StatusBadge>}</td>
                <td className="num">{n.gpu_physical}</td>
                <td className="num">{n.gpu_capacity}</td>
                <td className="num">{n.gpu_allocatable}</td>
              </tr>
            ))}
            {nodes.data?.length === 0 && (
              <tr>
                <td colSpan={7}>叢集沒有節點</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </SchedulingPage>
  );
}
