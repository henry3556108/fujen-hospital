// 管理區運算資源、系統監控、FHIR 改版（設計稿 B21～B28）新增的行為。
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { filterAlerts } from '../../src/pages/fhir/AlertsPage';
import { intervalText } from '../../src/pages/fhir/SchedulesPage';
import type { TrafficAlert } from '../../src/pages/fhir/types';
import { renderApp } from '../render';

const alert = (id: number, actor: string, created_at: string): TrafficAlert => ({
  id, project_id: 1, actor, window_start: created_at, request_count: 150, threshold: 120, notified: true, created_at,
});

describe('FHIR 改版', () => {
  it('排程間隔顯示成白話', () => {
    expect(intervalText(30)).toBe('每 30 分鐘');
    expect(intervalText(360)).toBe('每 6 小時');
    expect(intervalText(1440)).toBe('每天');
    expect(intervalText(2880)).toBe('每 2 天');
  });

  it('流量告警依使用者與日期篩選（含結束日當天）', () => {
    const list = [alert(1, 'md01', '2026-10-20T04:00:00'), alert(2, 'pi01', '2026-10-22T04:00:00'), alert(3, 'md01', '2026-10-23T04:00:00')];
    expect(filterAlerts(list, { actor: 'md01', from: '', to: '' }).map((a) => a.id)).toEqual([1, 3]);
    expect(filterAlerts(list, { actor: '', from: '2026-10-21', to: '2026-10-23' }).map((a) => a.id)).toEqual([2, 3]);
  });

  it('流量告警點一筆看詳情', async () => {
    const { user } = await renderApp('/admin/fhir/alerts');
    const table = await screen.findByRole('table', { name: '流量告警' });
    await within(table).findByText('md01');
    await user.click(within(table).getAllByRole('button', { name: /的告警詳情$/ })[0]);
    expect(screen.getByRole('complementary', { name: '流量告警詳情' })).toHaveTextContent('60 秒請求數');
  });

  it('資源頁以病歷號查詢，列出病人資源與關聯摘要', async () => {
    const { user } = await renderApp('/admin/fhir/resources');
    await user.type(await screen.findByLabelText('病歷號'), 'SYN-42-0001');
    await user.click(screen.getByRole('button', { name: '查詢資源' }));
    const table = await screen.findByRole('table', { name: '病人 SYN-42-0001 的資源' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(screen.getByRole('group', { name: '病人 SYN-42-0001 的資源關聯' })).toHaveTextContent('Encounter');
  });

  it('Gateway 點靜態路由只顯示唯讀資訊', async () => {
    const { user } = await renderApp('/admin/fhir/gateway');
    const table = await screen.findByRole('table', { name: 'API Gateway 路由' });
    await user.click((await within(table).findAllByRole('button', { name: '靜態路由' }))[0]);
    expect(screen.queryByRole('form', { name: /修改路由/ })).toBeNull();
    expect(screen.getByText(/由部署設定檔控制/)).toBeInTheDocument();
  });
});

describe('佇列排程與共享排程設定', () => {
  it('佇列排程頁右欄有共享排程設定', async () => {
    await renderApp('/admin/compute/queues', 'admin01');
    const panel = await screen.findByRole('complementary', { name: '共享排程設定' });
    expect(await within(panel).findByLabelText(/^時間片份數/)).toHaveValue(4);
    expect(within(panel).getByRole('button', { name: '儲存共享排程設定' })).toBeInTheDocument();
  });

  it('系統監控頁顯示叢集就緒節點', async () => {
    await renderApp('/admin/monitoring', 'admin01');
    expect(await screen.findByText('就緒節點')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Grafana（開新分頁）/ })).toHaveAttribute('target', '_blank');
  });
});
