import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { mockDb } from '../../src/mocks/handlers';
import { renderApp } from '../render';

// 管理區單一專案頁：基本資料與 GPU 群組／成員與權限／標註群組／Accession Number 清單
describe('admin project detail', () => {
  it('opens from the project list and shows the four tabs', async () => {
    const { user } = await renderApp('/admin/projects');
    const table = await screen.findByRole('table', { name: '專案列表' });
    await user.click(await within(table).findByRole('link', { name: 'P1-lung-ct' }));
    expect(await screen.findByRole('heading', { level: 1, name: '專案：P1-lung-ct' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: '專案設定分頁' });
    expect(within(tabs).getAllByRole('link').map((a) => a.textContent)).toEqual([
      '基本資料與 GPU 群組',
      '成員與權限',
      '標註群組',
      'Accession Number 清單',
    ]);
    await user.click(within(tabs).getByRole('link', { name: '成員與權限' }));
    const members = await screen.findByRole('table', { name: '目前的專案成員' });
    expect(await within(members).findByRole('row', { name: /md01/ })).toBeInTheDocument();
    // 專案由路由決定，沒有頁內的專案下拉
    expect(screen.queryByRole('combobox', { name: '專案' })).toBeNull();
  });

  it('saves the basic data and GPU group in place', async () => {
    const { user } = await renderApp('/admin/projects/2');
    const form = await screen.findByRole('form', { name: '基本資料與 GPU 群組' });
    const desc = within(form).getByLabelText('說明');
    await user.clear(desc);
    await user.type(desc, '表格研究');
    await user.click(within(form).getByRole('button', { name: '儲存' }));
    expect(await screen.findByText('已更新專案「P2-tabular」')).toBeInTheDocument();
    expect(mockDb().projects.find((p) => p.id === 2)!.description).toBe('表格研究');
    expect(within(form).getByLabelText('說明')).toHaveValue('表格研究');
  });

  it('the image access list tab is editable here', async () => {
    await renderApp('/admin/projects/1/allowlist');
    expect(await screen.findByRole('heading', { name: 'Accession Number 清單' })).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: '設定 Accession Number 清單' })).toBeInTheDocument();
  });

  it('an unknown project id says so', async () => {
    await renderApp('/admin/projects/99');
    expect(await screen.findByText(/找不到專案 99/)).toBeInTheDocument();
  });
});
