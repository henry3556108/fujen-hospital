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
    expect(await screen.findByRole('heading', { name: 'Dashboard（系統總覽）' })).toBeInTheDocument();
    const overview = await screen.findByRole('list', { name: '平台總覽' });
    expect(tile(overview, '帳號')).toBe('8');
    expect(overview).toHaveTextContent('Admin 1、User 7');
    expect(tile(overview, '專案')).toBe('3');
    expect(tile(overview, '專案成員')).toBe('5');
    expect(tile(overview, '標註群組')).toBe('0');
    expect(tile(overview, '結構式資料集')).toBe('2');
    expect(tile(overview, '影像研究')).toBe('6');
    expect(tile(overview, 'GPU 群組')).toBe('2');
    expect(tile(overview, '排程工作')).toBe('0');
    const status = screen.getByRole('list', { name: '排程工作狀態' });
    expect(tile(status, '排隊中')).toBe('0');
    const table = screen.getByRole('table', { name: '各專案筆數' });
    const p1 = within(table).getByRole('row', { name: /P1-lung-ct/ });
    expect(within(p1).getAllByRole('cell').map((c) => c.textContent)).toEqual(['gpu-exclusive', '5', '0', '1', '6', '0']);
  });

  it('the Account tab is the account management page', async () => {
    const { user } = await renderApp('/admin/dashboard');
    const tabs = await screen.findByRole('navigation', { name: '帳號管理分頁' });
    await user.click(within(tabs).getByRole('link', { name: 'Account 帳號' }));
    expect(await screen.findByRole('heading', { name: 'Account（帳號）' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: '帳號列表' })).toBeInTheDocument();
  });

  it('non-admin cannot open the Dashboard', async () => {
    await renderApp('/admin/dashboard', 'pi01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
  });
});
