import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderApp } from '../render';
import { layout } from '../../src/pages/fhir/GraphPage';

describe('FHIR 資料交換（WP6）', () => {
  it('Admin 從帳號管理的分頁進入，看到各資源筆數', async () => {
    const { user } = await renderApp('/admin/projects');
    await user.click(within(await screen.findByRole('navigation', { name: '系統管理選單' })).getByRole('link', { name: '資料交換' }));
    expect(await screen.findByRole('heading', { level: 1, name: '醫療資料交換（FHIR）' })).toBeInTheDocument();
    const stats = await screen.findByRole('list', { name: '資源筆數' });
    expect(await within(stats).findByText('2')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Patient 列表' });
    expect(await within(table).findByText('SYN-42-0001')).toBeInTheDocument();
  });

  it('非 Admin 直接輸入網址會看到拒絕頁', async () => {
    await renderApp('/fhir/resources', 'pi01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
  });

  it('TC-C03-03 修改路由 3 次，每次重新載入都一致', async () => {
    const settings: [boolean, string[], string][] = [
      [false, ['GET', 'HEAD'], '30'],
      [true, ['GET', 'HEAD', 'POST'], '60'],
      [true, ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'], '120'],
    ];
    for (const [enabled, methods, threshold] of settings) {
      const { user, unmount } = await renderApp('/fhir/gateway');
      const form = await screen.findByRole('form', { name: '修改路由 fhir-rest' });
      const toggle = within(form).getByRole('checkbox', { name: '啟用這條路由' });
      if ((toggle as HTMLInputElement).checked !== enabled) await user.click(toggle);
      for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const box = within(form).getByRole('checkbox', { name: m }) as HTMLInputElement;
        if (box.checked !== methods.includes(m)) await user.click(box);
      }
      const input = within(form).getByLabelText(/流量告警門檻/);
      await user.clear(input);
      await user.type(input, threshold);
      await user.click(within(form).getByRole('button', { name: '儲存路由設定' }));
      expect(await screen.findByText(/已儲存路由「fhir-rest」/)).toBeInTheDocument();
      unmount();

      const reloaded = await renderApp('/fhir/gateway');
      const table = await screen.findByRole('table', { name: 'Gateway 路由' });
      const row = await within(table).findByRole('row', { name: /fhir-rest/ });
      expect(within(row).getByText(methods.join(' '))).toBeInTheDocument();
      expect(within(row).getByText(enabled ? '啟用' : '停用')).toBeInTheDocument();
      expect(within(row).getByText(threshold)).toBeInTheDocument();
      reloaded.unmount();   // 同一個測試內 MSW 狀態保留，重新載入看到的是剛存下的值
    }
  });

  it('靜態路由唯讀，只有受管路由有修改表單', async () => {
    await renderApp('/fhir/gateway');
    const table = await screen.findByRole('table', { name: 'Gateway 路由' });
    expect(await within(table).findByText('/dicomweb/projects/*')).toBeInTheDocument();
    expect(screen.getAllByRole('form', { name: /修改路由/ })).toHaveLength(1);
  });

  it('TC-C03-10 關聯圖的節點與邊和 API 回傳一致', async () => {
    const { user } = await renderApp('/fhir/graph');
    await user.type(await screen.findByLabelText('病歷號'), 'SYN-42-0001');
    await user.click(screen.getByRole('button', { name: '顯示關聯圖' }));
    const svg = await screen.findByTestId('fhir-graph');
    const nodes = [...svg.querySelectorAll('[data-node-id]')].map((n) => n.getAttribute('data-node-id'));
    expect(nodes.sort()).toEqual(['Encounter/1002', 'Encounter/1003', 'Observation/1004', 'Patient/1000']);
    const edges = [...svg.querySelectorAll('[data-edge]')].map((e) => e.getAttribute('data-edge'));
    expect(edges.sort()).toEqual(['Encounter/1002->Patient/1000', 'Encounter/1003->Patient/1000', 'Observation/1004->Patient/1000']);
    expect(within(screen.getByRole('table', { name: '關聯清單' })).getAllByRole('row')).toHaveLength(5);
  });

  it('找不到病人時顯示文字說明', async () => {
    const { user } = await renderApp('/fhir/graph');
    await user.type(await screen.findByLabelText('病歷號'), 'NOPE');
    await user.click(screen.getByRole('button', { name: '顯示關聯圖' }));
    expect(await screen.findByText('找不到病人 NOPE')).toBeInTheDocument();
  });

  it('layout 把病人放在中心、其他資源在外圈', () => {
    const pos = layout({
      patient: 'X',
      nodes: [
        { id: 'Patient/1', type: 'Patient', label: '', identifier: '' },
        { id: 'Encounter/2', type: 'Encounter', label: '', identifier: '' },
        { id: 'Observation/3', type: 'Observation', label: '', identifier: '' },
      ],
      edges: [],
      truncated: false,
    });
    expect(pos.get('Patient/1')).toEqual({ x: 280, y: 280 });
    expect(Math.round(Math.hypot(pos.get('Encounter/2')!.x - 280, pos.get('Encounter/2')!.y - 280))).toBe(190);
  });

  it('新增來源、加入內建規則並執行；類型不符時顯示原因', async () => {
    const { user } = await renderApp('/fhir/sources');
    await user.type(await screen.findByLabelText('來源名稱（必填）'), 'encounters');
    await user.selectOptions(screen.getByLabelText('來源類型'), 'csv');
    await user.type(screen.getByLabelText('內容'), 'encounter_id,patient_id');
    await user.click(screen.getByRole('button', { name: '新增來源' }));
    expect(await screen.findByText('已新增來源「encounters」')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('內建規則'), 'csv-encounter');
    await user.click(screen.getByRole('button', { name: '加入' }));
    await screen.findByText('已加入對應規則「csv-encounter」');
    await user.selectOptions(screen.getByLabelText('內建規則'), 'sql-patient');
    await user.click(screen.getByRole('button', { name: '加入' }));
    await screen.findByText('已加入對應規則「sql-patient」');

    const form = screen.getByRole('form', { name: '執行轉換' });
    await user.selectOptions(within(form).getByLabelText('來源'), 'encounters');
    await user.selectOptions(within(form).getByLabelText('對應規則'), 'csv-encounter');
    await user.click(within(form).getByRole('button', { name: '執行' }));
    expect(await within(form).findByText(/成功：讀取 20 筆，寫入 Encounter 20/)).toBeInTheDocument();

    await user.selectOptions(within(form).getByLabelText('對應規則'), 'sql-patient');
    await user.click(within(form).getByRole('button', { name: '執行' }));
    expect(await within(form).findByText(/資料不合格，整批未寫入/)).toBeInTheDocument();
    expect(within(form).getByText(/與來源的 csv 不符/)).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: '執行紀錄' })).getAllByRole('row')).toHaveLength(3);
  });

  it('流量告警列表', async () => {
    await renderApp('/fhir/alerts');
    const table = await screen.findByRole('table', { name: '流量告警' });
    expect(await within(table).findByText('md01')).toBeInTheDocument();
    expect(within(table).getByText('已寄出')).toBeInTheDocument();
  });
});
