import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert, Card, Icon, StatusDot, type IconName } from '../../components/ui';
import { SchedulingPage } from './SchedulingRoutes';
import type { ClusterNode } from './types';

const POOL_USE: Record<string, string> = {
  'cpu-web': '網頁服務',
  'cpu-data': '資料清洗',
  'gpu-exclusive': 'GPU 獨占',
  'gpu-shared': 'GPU 共享',
};

/** 統計方塊（外觀同 ui StatTile；保留 stat-tile__label／__value 類名給驗收腳本讀數字） */
function Tile({ label, value, icon }: { label: string; value: number; icon: IconName }) {
  return (
    <li className="ui-stat sch-tile">
      <span className="ui-stat__icon ui-stat__icon--primary" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="ui-stat__text">
        <span className="ui-stat__label stat-tile__label">{label}</span>
        <span className="ui-stat__value ui-stat__value--primary stat-tile__value">{value}</span>
      </span>
    </li>
  );
}

/** TC-C01-01 節點清單（設計稿 B21 叢集節點）：直接讀 Kubernetes，新增節點後自動出現（TC-C01-07）。 */
export function ClusterNodesPage() {
  const { api } = useSession();
  const nodes = useResource(() => api.get<ClusterNode[]>('/api/admin/cluster/nodes'));
  const list = nodes.data ?? [];
  const ready = list.filter((n) => n.ready).length;
  const physical = list.reduce((a, n) => a + n.gpu_physical, 0);
  const capacity = list.reduce((a, n) => a + n.gpu_capacity, 0);

  return (
    <SchedulingPage
      title="GPU／CPU 伺服器管理"
      subtitle="管理 GPU 資源、群組與叢集節點"
      actions={
        <button type="button" className="btn btn--secondary" onClick={nodes.reload} disabled={nodes.loading}>
          重新整理
        </button>
      }
    >
      <ApiErrorAlert error={nodes.error} />
      {nodes.data && (
        <ul className="sch-tiles" aria-label="叢集摘要">
          <Tile label="節點數" value={list.length} icon="server" />
          <Tile label="就緒節點" value={ready} icon="check" />
          <Tile label="實體 GPU" value={physical} icon="cube" />
          <Tile label="可排程 GPU 份數" value={capacity} icon="grid" />
        </ul>
      )}
      <Card title="叢集節點" flush extra={<span className="text-muted">節點清單直接讀取叢集，不需另外設定</span>}>
        <div className="table-wrap">
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
                  <td>{n.ready ? <StatusDot tone="success">就緒</StatusDot> : <StatusDot tone="error">未就緒</StatusDot>}</td>
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
      </Card>
    </SchedulingPage>
  );
}
