import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderApp } from '../render';

function tile(list: HTMLElement, label: string) {
  const item = within(list)
    .getAllByRole('listitem')
    .find((li) => li.querySelector('.stat-tile__label')?.textContent === label);
  if (!item) throw new Error(`找不到 ${label}`);
  return item.querySelector('.stat-tile__value')!.textContent;
}

describe('admin Dashboard and Account pages', () => {
  it('the 帳號管理 entry opens the Dashboard with counts from the API', async () => {
    await renderApp('/admin');
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    const overview = await screen.findByRole('list', { name: 'Dashboard' });
    expect(tile(overview, '帳號')).toBe('8');
    expect(overview).toHaveTextContent('Admin 1、User 7');
    expect(tile(overview, '專案')).toBe('3');
    expect(tile(overview, '專案成員')).toBe('5');
    expect(tile(overview, '標註群組')).toBe('0');
    expect(tile(overview, '結構式資料集')).toBe('2');
    expect(tile(overview, '影像研究')).toBe('6');
    expect(tile(overview, 'GPU 群組')).toBe('2');
    expect(tile(overview, '排程工作')).toBe('0');
    // 帳號、專案、GPU 群組都能點進去
    expect(within(overview).getByRole('link', { name: '管理帳號' })).toHaveAttribute('href', '/admin/users');
    expect(within(overview).getByRole('link', { name: '管理專案' })).toHaveAttribute('href', '/admin/projects');
    expect(within(overview).getByRole('link', { name: '管理 GPU 群組' })).toHaveAttribute('href', '/admin/compute/groups');
    const status = screen.getByRole('list', { name: '排程工作狀態' });
    expect(tile(status, '等待中')).toBe('0');
    const table = screen.getByRole('table', { name: '各專案筆數' });
    const p1 = within(table).getByRole('row', { name: /P1-lung-ct/ });
    expect(within(p1).getAllByRole('cell').map((c) => c.textContent)).toEqual(['gpu-exclusive', '5', '0', '1', '6', '0', '查看 ›']);
  });

  it('the 帳號 item in the admin sidebar is the account management page, with each account’s projects', async () => {
    const { user } = await renderApp('/admin/dashboard');
    const nav = await screen.findByRole('navigation', { name: '管理後台選單' });
    await user.click(within(nav).getByRole('link', { name: '帳號管理' }));
    expect(await screen.findByRole('heading', { level: 1, name: '帳號管理' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: '帳號列表' });
    expect(within(table).getByRole('columnheader', { name: '所屬專案' })).toBeInTheDocument();
    const md = within(table).getByRole('row', { name: /md01/ });
    expect(await within(md).findByRole('link', { name: 'P1-lung-ct' })).toHaveAttribute('href', '/admin/projects/1');
    expect(within(table).getByRole('row', { name: /user01/ })).toHaveTextContent('未加入');
  });

  it('the overview lists pending items that link to where they are handled', async () => {
    await renderApp('/admin');
    const pending = await screen.findByRole('list', { name: '待處理事項' });
    expect(within(pending).getByRole('link', { name: '等待中的工作（0 件）' })).toHaveAttribute('href', '/admin/compute/queues');
    expect(screen.getByRole('link', { name: '系統監控與告警規則' })).toHaveAttribute('href', '/admin/monitoring');
  });

  it('non-admin cannot open the Dashboard', async () => {
    await renderApp('/admin/dashboard', 'pi01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
  });
});
