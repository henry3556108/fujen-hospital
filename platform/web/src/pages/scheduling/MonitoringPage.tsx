import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { platformEnv } from '../../runtimeConfig';
import { ApiErrorAlert, Card, Icon, StatTile } from '../../components/ui';
import { SchedulingPage } from './SchedulingRoutes';
import type { ClusterNode, GpuAllocation } from './types';

export interface MonitoringLink {
  key: string;
  name: string;
  url: string;
  description: string;
}

/** 監控工具位址：預設是 kind 叢集對外的連接埠（platform/deploy/kind），正式環境以環境變數指定。 */
export function monitoringLinks(env: Record<string, string | undefined> = platformEnv()): MonitoringLink[] {
  return [
    {
      key: 'grafana',
      name: 'Grafana',
      url: env.VITE_GRAFANA_URL || 'http://127.0.0.1:33000',
      description: '儀表板：平台叢集總覽，可自訂儀表板、視覺效果與更新頻率',
    },
    {
      key: 'prometheus',
      name: 'Prometheus',
      url: env.VITE_PROMETHEUS_URL || 'http://127.0.0.1:39090',
      description: '指標查詢與監控目標（節點、Pod、CPU、記憶體、GPU）',
    },
    {
      key: 'alertmanager',
      name: 'Alertmanager',
      url: env.VITE_ALERTMANAGER_URL || 'http://127.0.0.1:39093',
      description: '告警分類、規則、重複抑制、靜音與通知',
    },
    {
      key: 'mailpit',
      name: 'Mailpit',
      url: env.VITE_MAILPIT_URL || 'http://127.0.0.1:38025',
      description: '開發環境的告警信收件匣',
    },
  ];
}

interface Snapshot {
  nodes: ClusterNode[];
  rows: GpuAllocation[];
}

/** 平台自己知道的叢集狀態（節點與 GPU 份數）；CPU、記憶體曲線與告警規則在外部監控工具內 */
function ClusterSnapshot() {
  const { api } = useSession();
  const snap = useResource<Snapshot>(async () => {
    const [nodes, rows] = await Promise.all([
      api.get<ClusterNode[]>('/api/admin/cluster/nodes'),
      api.get<GpuAllocation[]>('/api/admin/cluster/gpu-dashboard'),
    ]);
    return { nodes, rows };
  });
  if (snap.error) return <ApiErrorAlert error={snap.error} />;
  if (!snap.data) return <p role="status">載入中…</p>;
  const { nodes, rows } = snap.data;
  const ready = nodes.filter((n) => n.ready).length;
  const capacity = nodes.reduce((a, n) => a + n.gpu_capacity, 0);
  return (
    <div className="sch-mon-tiles" aria-label="叢集狀態">
      <StatTile label="就緒節點" value={`${ready} / ${nodes.length}`} icon="server" tone={ready === nodes.length ? 'secondary' : 'error'} to="/admin/compute/nodes" />
      <StatTile label="執行中 GPU 工作" value={rows.length} icon="pulse" to="/admin/compute/gpu" />
      <StatTile label="可排程 GPU 份數" value={capacity} icon="grid" tone="neutral" />
    </div>
  );
}

/** TC-C02-03 的入口（設計稿 B23）：監控圖表、告警規則與通知在外部工具內編輯與保存，這頁提供入口與叢集摘要。 */
export function MonitoringPage() {
  const links = monitoringLinks();
  return (
    <SchedulingPage title="系統監控" subtitle="監控運算資源與服務狀態" tabs={false}>
      <ClusterSnapshot />
      <Card title="監控工具" extra={<span className="text-muted">在新分頁開啟，需使用各工具自己的帳號登入</span>}>
        <ul className="sch-mon-links" aria-label="監控工具">
          {links.map((l) => (
            <li key={l.key} className="sch-mon-link">
              <strong className="sch-mon-link__name">{l.name}</strong>
              <span className="sch-mon-link__desc">{l.description}</span>
              <span className="text-muted mono sch-mon-link__url">{l.url}</span>
              <a
                className="btn btn--secondary btn--small"
                href={l.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`${l.name}（開新分頁）：${l.description}`}
              >
                開啟
                <Icon name="external" />
              </a>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="預設儀表板">
        <p>
          <a href={`${links[0].url}/dashboards`} target="_blank" rel="noreferrer">
            在 Grafana 瀏覽所有儀表板（開新分頁）
          </a>
        </p>
        <p className="text-muted">「平台叢集總覽」顯示各節點池 CPU、GPU 已配置與可用份數、執行中的 GPU 工作。告警規則、重複通知抑制與通知管道在 Alertmanager 設定。</p>
      </Card>
    </SchedulingPage>
  );
}
