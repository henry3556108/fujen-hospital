import { Link } from 'react-router-dom';
import type { AdminDashboard } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { Card, Icon, PageHeader, StatTile, StatusDot, type IconName } from '../../components/ui';
import type { GatewayRoute } from '../fhir/types';
import type { ClusterNode, GpuAllocation } from '../scheduling/types';
import './admin.css';

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: '等待中',
  running: '執行中',
  succeeded: '已完成',
  failed: '失敗',
  cancelled: '已取消',
  held: '已暫存',
};

const formatAt = (iso: string) => new Date(iso).toLocaleString('zh-TW', { hour12: false });

/** 一格數字；有 to 時附上連結（03 規格第一節 Admin 1：總覽每一項都能點進去） */
function Tile({ label, value, note, to, link }: { label: string; value: number; note?: string; to?: string; link?: string }) {
  return (
    <li className="adm-count">
      <span className="stat-tile__label adm-count__label">{label}</span>
      <span className="stat-tile__value adm-count__value">{value.toLocaleString('zh-TW')}</span>
      {note && <span className="text-muted adm-count__note">{note}</span>}
      {to && (
        <Link to={to} className="adm-count__link">
          {link ?? `查看${label}`}
        </Link>
      )}
    </li>
  );
}

interface PendingItem {
  label: string;
  sub: string;
  value: number;
  to: string;
  icon: IconName;
  tone: 'error' | 'warning' | 'info';
}

/** 待處理事項：待審下載、失敗／執行中／等待中工作。讀不到的項目就不顯示。 */
function PendingCard({ items }: { items: PendingItem[] }) {
  const first = items.find((i) => i.value > 0);
  return (
    <Card
      title="待處理事項"
      footer={
        first ? (
          <Link to={first.to} className="btn btn--primary btn--block">
            查看待處理 <Icon name="arrow" />
          </Link>
        ) : (
          <p className="text-muted adm-muted-line">目前沒有要處理的事項。</p>
        )
      }
    >
      <ul className="adm-todo" aria-label="待處理事項">
        {items.map((i) => (
          <li key={i.label}>
            <Link to={i.to} className="adm-todo__item" aria-label={`${i.label}（${i.value} 件）`}>
              <span className={`adm-todo__icon adm-todo__icon--${i.tone}`} aria-hidden="true">
                <Icon name={i.icon} />
              </span>
              <span className="adm-todo__text">
                <span className="adm-todo__title">{i.label}</span>
                <span className="adm-todo__sub">{i.sub}</span>
              </span>
              <span className={`adm-todo__count ${i.value > 0 ? `adm-todo__count--${i.tone}` : ''}`}>{i.value}</span>
              <Icon name="chevron-right" className="adm-todo__chevron" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** 系統狀態：只顯示 API 讀得到的項目（運算節點、GPU 份數、API Gateway）；其他服務請到系統監控 */
function SystemCard() {
  const { api } = useSession();
  const nodes = useResource(() => api.get<ClusterNode[]>('/api/admin/cluster/nodes'));
  const gpu = useResource(() => api.get<GpuAllocation[]>('/api/admin/cluster/gpu-dashboard'));
  const routes = useResource(() => api.get<GatewayRoute[]>('/api/admin/gateway/routes'));
  const list = nodes.data;
  const notReady = list ? list.filter((n) => !n.ready).length : 0;
  const capacity = list ? list.reduce((a, n) => a + n.gpu_capacity, 0) : 0;
  const enabledRoutes = routes.data ? routes.data.filter((r) => r.enabled).length : 0;
  return (
    <Card
      title="系統狀態"
      className="adm-status-card"
      extra={<Link to="/admin/monitoring">查看全部 ›</Link>}
      footer={
        <div className="adm-status__links">
          <Link to="/admin/monitoring">系統監控與告警規則</Link>
          <Link to="/admin/fhir/alerts">FHIR 流量監測與告警</Link>
        </div>
      }
    >
      <ul className="adm-status" aria-label="系統狀態">
        <li>
          <Icon name="server" />
          <span className="adm-status__name">運算伺服器</span>
          {nodes.error ? (
            <StatusDot tone="neutral">無法讀取</StatusDot>
          ) : !list ? (
            <span className="text-muted">載入中…</span>
          ) : list.length === 0 ? (
            <StatusDot tone="neutral">尚未登記節點</StatusDot>
          ) : notReady === 0 ? (
            <StatusDot tone="success">運作正常（{list.length} 台）</StatusDot>
          ) : (
            <StatusDot tone="error">
              {notReady} 台未就緒（共 {list.length} 台）
            </StatusDot>
          )}
        </li>
        <li>
          <Icon name="grid" />
          <span className="adm-status__name">GPU 使用份數</span>
          {gpu.error || nodes.error ? (
            <StatusDot tone="neutral">無法讀取</StatusDot>
          ) : !gpu.data || !list ? (
            <span className="text-muted">載入中…</span>
          ) : (
            <Link to="/admin/compute/gpu" className="adm-status__value">
              使用中 {gpu.data.length} / {capacity} 份
            </Link>
          )}
        </li>
        <li>
          <Icon name="swap" />
          <span className="adm-status__name">API Gateway</span>
          {routes.error ? (
            <StatusDot tone="neutral">無法讀取</StatusDot>
          ) : !routes.data ? (
            <span className="text-muted">載入中…</span>
          ) : (
            <Link to="/admin/fhir/gateway" className="adm-status__value">
              啟用 {enabledRoutes} / {routes.data.length} 條路由
            </Link>
          )}
        </li>
      </ul>
    </Card>
  );
}

/** A-03「可檢視 Dashboard 頁面」：數字都是後端即時的資料庫筆數（TC-A03-10 以資料庫比對）。設計稿 B17。 */
export function DashboardPage() {
  const { api } = useSession();
  const board = useResource(() => api.get<AdminDashboard>('/api/admin/dashboard'));
  const downloads = useResource(() => api.get<{ status: string }[]>('/api/admin/llm/downloads'));
  const d = board.data;
  const pendingDownloads = downloads.data ? downloads.data.filter((x) => x.status === 'pending').length : null;
  const byStatus = d?.jobs.by_status ?? {};
  const items: PendingItem[] = [
    ...(pendingDownloads !== null
      ? [{ label: '模型下載待審', sub: `申請 ${pendingDownloads} 件`, value: pendingDownloads, to: '/admin/approvals', icon: 'doc' as const, tone: 'error' as const }]
      : []),
    { label: '失敗工作', sub: `運算 ${byStatus.failed ?? 0} 件`, value: byStatus.failed ?? 0, to: '/admin/compute/jobs', icon: 'warning', tone: 'error' },
    { label: '執行中的工作', sub: '看 GPU 正在跑哪個專案', value: byStatus.running ?? 0, to: '/admin/compute/gpu', icon: 'gear', tone: 'info' },
    { label: '等待中的工作', sub: '調整佇列排程', value: byStatus.queued ?? 0, to: '/admin/compute/queues', icon: 'clock', tone: 'warning' },
  ];
  const pendingTotal = (pendingDownloads ?? 0) + (byStatus.failed ?? 0);

  return (
    <div className="adm-page">
      <PageHeader
        title="Dashboard"
        subtitle="管理全平台的專案、帳號與運算資源"
        actions={
          <>
            {d && (
              <span className="adm-updated">
                最後更新 <time dateTime={d.generated_at}>{formatAt(d.generated_at)}</time>
              </span>
            )}
            <button type="button" className="btn btn--secondary" onClick={board.reload} disabled={board.loading}>
              <Icon name="refresh" /> 重新整理
            </button>
          </>
        }
      />
      <ApiErrorAlert error={board.error} />
      {board.loading && !d && <p role="status">載入中…</p>}
      {d && (
        <>
          <div className="adm-stats">
            <StatTile label="專案總數" value={d.projects} icon="folder" to="/admin/projects" />
            <StatTile label="帳號總數" value={d.accounts.total} icon="users" to="/admin/users" />
            <StatTile label="執行中工作" value={byStatus.running ?? 0} icon="gear" tone="secondary" to="/admin/compute/gpu" />
            <StatTile
              label="待處理事項"
              value={pendingTotal}
              icon="warning"
              tone={pendingTotal > 0 ? 'warning' : 'neutral'}
              to={pendingDownloads ? '/admin/approvals' : '/admin/compute/jobs'}
            />
          </div>

          <div className="adm-grid-2">
            <PendingCard items={items} />
            <SystemCard />
          </div>

          <Card title="專案列表" flush extra={<Link to="/admin/projects">查看全部 ›</Link>}>
            <div className="table-wrap">
              <table aria-label="各專案筆數">
                <thead>
                  <tr>
                    <th scope="col">專案名稱</th>
                    <th scope="col">GPU 群組</th>
                    <th scope="col">成員數</th>
                    <th scope="col">標註群組</th>
                    <th scope="col">結構式資料集</th>
                    <th scope="col">影像研究</th>
                    <th scope="col">排程工作</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {d.per_project.length === 0 && (
                    <tr>
                      <td colSpan={8}>
                        還沒有專案，請到 <Link to="/admin/projects">專案</Link> 新增。
                      </td>
                    </tr>
                  )}
                  {d.per_project.map((p) => (
                    <tr key={p.id}>
                      <th scope="row">
                        <Link to={`/admin/projects/${p.id}`}>{p.name}</Link>
                      </th>
                      <td>{p.gpu_group ?? '不綁定'}</td>
                      <td>{p.members}</td>
                      <td>{p.labeling_groups}</td>
                      <td>{p.tabular_datasets}</td>
                      <td>{p.imaging_studies}</td>
                      <td>{p.jobs}</td>
                      <td>
                        <Link to={`/admin/projects/${p.id}`} aria-label={`查看 ${p.name}`}>
                          查看 ›
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="全平台筆數">
            <ul className="adm-counts adm-counts--4" aria-label="Dashboard">
              <Tile label="帳號" value={d.accounts.total} note={`Admin ${d.accounts.admin}、User ${d.accounts.user}`} to="/admin/users" link="管理帳號" />
              <Tile label="專案" value={d.projects} to="/admin/projects" link="管理專案" />
              <Tile label="專案成員" value={d.memberships} note="帳號加入專案的次數" />
              <Tile label="標註群組" value={d.labeling_groups} note={`群組成員 ${d.labeling_group_members}`} />
              <Tile label="結構式資料集" value={d.tabular_datasets} />
              <Tile label="影像研究" value={d.imaging_studies} />
              <Tile label="GPU 群組" value={d.gpu_groups} to="/admin/compute/groups" link="管理 GPU 群組" />
              <Tile label="排程工作" value={d.jobs.total} />
            </ul>
            <h3 className="adm-subhead">排程工作狀態</h3>
            <ul className="adm-counts adm-counts--fill" aria-label="排程工作狀態">
              {Object.entries(d.jobs.by_status).map(([status, n]) => (
                <Tile key={status} label={JOB_STATUS_LABELS[status] ?? status} value={n} />
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
