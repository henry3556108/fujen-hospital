import { SchedulingPage } from './SchedulingRoutes';

export interface MonitoringLink {
  key: string;
  name: string;
  url: string;
  description: string;
}

/** 監控工具位址：預設是 kind 叢集對外的連接埠（platform/deploy/kind），正式環境以環境變數指定。 */
export function monitoringLinks(env: Record<string, string | undefined> = import.meta.env): MonitoringLink[] {
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
      description: '告警狀態、重複抑制與靜音',
    },
    {
      key: 'mailpit',
      name: 'Mailpit',
      url: env.VITE_MAILPIT_URL || 'http://127.0.0.1:38025',
      description: '開發環境的告警信收件匣',
    },
  ];
}

/** TC-C02-03 的入口：儀表板本身在 Grafana 內編輯與保存。 */
export function MonitoringPage() {
  return (
    <SchedulingPage title="監控儀表板">
      <p className="text-muted">監控工具在新分頁開啟，需使用各工具自己的帳號登入。</p>
      <ul className="entry-grid section" aria-label="監控工具">
        {monitoringLinks().map((l) => (
          <li key={l.key}>
            <a className="card link-card" href={l.url} target="_blank" rel="noreferrer">
              <span className="link-card__title">{l.name}（開新分頁）</span>
              <span>{l.description}</span>
              <span className="text-muted mono">{l.url}</span>
            </a>
          </li>
        ))}
      </ul>
      <section className="card section" aria-labelledby="monitoring-dashboards">
        <h2 id="monitoring-dashboards">預設儀表板</h2>
        <p>
          <a href={`${monitoringLinks()[0].url}/dashboards`} target="_blank" rel="noreferrer">
            在 Grafana 瀏覽所有儀表板（開新分頁）
          </a>
        </p>
        <p className="text-muted">「平台叢集總覽」顯示各節點池 CPU、GPU 已配置與可用份數、執行中的 GPU 工作。</p>
      </section>
    </SchedulingPage>
  );
}
