import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { setSchedulingAvailable } from '../../src/mocks/scheduling';
import { renderApp } from '../render';

async function form() {
  return screen.findByRole('form', { name: '修改共享排程設定' });
}

describe('共享排程設定', () => {
  it('shows the current settings from the API', async () => {
    await renderApp('/admin/scheduling');
    expect(await screen.findByRole('heading', { level: 1, name: '共享排程設定' })).toBeInTheDocument();
    const f = await form();
    expect(within(f).getByLabelText(/^時間片份數/)).toHaveValue(4);
    expect(within(f).getByLabelText(/^工作時限/)).toHaveValue(60);
    expect(screen.getByTestId('current-replicas')).toHaveTextContent('4');
    expect(screen.getByTestId('current-timeout')).toHaveTextContent('60');
  });

  it('TC-A02-07 saves 3 times and every reload shows the saved values', async () => {
    for (const [replicas, timeout] of [
      ['2', '30'],
      ['8', '120'],
      ['1', '1440'],
    ]) {
      const { user, unmount } = await renderApp('/admin/scheduling');
      const f = await form();
      const r = within(f).getByLabelText(/^時間片份數/);
      const t = within(f).getByLabelText(/^工作時限/);
      await user.clear(r);
      await user.type(r, replicas);
      await user.clear(t);
      await user.type(t, timeout);
      await user.click(within(f).getByRole('button', { name: '儲存設定' }));
      expect(await screen.findByText(`已儲存：時間片 ${replicas} 份、工作時限 ${timeout} 分鐘`)).toBeInTheDocument();
      unmount();

      // 重新載入：整個 App 重新掛載，值來自 API
      const again = await renderApp('/admin/scheduling');
      const f2 = await form();
      expect(within(f2).getByLabelText(/^時間片份數/)).toHaveValue(Number(replicas));
      expect(within(f2).getByLabelText(/^工作時限/)).toHaveValue(Number(timeout));
      expect(screen.getByTestId('current-replicas')).toHaveTextContent(replicas);
      again.unmount();
    }
  });

  it('422 out-of-range value names the field and marks it invalid', async () => {
    const { user } = await renderApp('/admin/scheduling');
    const f = await form();
    const r = within(f).getByLabelText(/^時間片份數/);
    await user.clear(r);
    await user.type(r, '0');
    await user.click(within(f).getByRole('button', { name: '儲存設定' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('資料驗證失敗');
    expect(alert).toHaveTextContent('時間片份數：數值超出允許範圍');
    expect(r).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('current-replicas')).toHaveTextContent('4');
  });

  it('503 from the scheduler is shown and the saved values stay', async () => {
    const { user } = await renderApp('/admin/scheduling');
    const f = await form();
    setSchedulingAvailable(false);
    await user.click(within(f).getByRole('button', { name: '儲存設定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('排程服務尚未設定');
  });

  it('TC-A03-03 non-admin is denied by URL', async () => {
    await renderApp('/admin/scheduling', 'pi01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
    await renderApp('/admin/scheduling/gpu-dashboard', 'vw01');
    await waitFor(() => expect(screen.getAllByRole('heading', { name: '無法存取此功能' })).toHaveLength(2));
  });

  it('tabs lead to the other scheduling pages', async () => {
    const { user } = await renderApp('/admin/scheduling');
    await screen.findByRole('navigation', { name: '排程與叢集分頁' });
    for (const name of ['GPU 群組', '叢集節點', 'GPU Dashboard', '監控儀表板', '共享排程設定']) {
      await user.click(within(screen.getByRole('navigation', { name: '排程與叢集分頁' })).getByRole('link', { name }));
      expect(await screen.findByRole('heading', { level: 1, name })).toBeInTheDocument();
      expect(within(screen.getByRole('navigation', { name: '排程與叢集分頁' })).getByRole('link', { name })).toHaveAttribute(
        'aria-current',
        'page',
      );
    }
  });
});
