import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderApp } from '../render';
import { sourceLabel } from '../../src/pages/admin/AuditPage';

async function openPage() {
  const r = await renderApp('/admin/audit');
  const table = await screen.findByRole('table', { name: '稽核紀錄' });
  await within(table).findAllByRole('row', { name: /admin01/ });
  return { ...r, table };
}

describe('admin audit view (read-only)', () => {
  it('shows every required field; seeded rows read 本機指令', async () => {
    const { table } = await openPage();
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['編號', '時間', '操作者', '類別', '動作', '對象', '結果', '來源', '內容']);
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('admin01');
    expect(row).toHaveTextContent('成功');
    expect(row).toHaveTextContent('本機指令：建立測試基線');
    expect(row).toHaveTextContent('local:seed');
    expect(screen.getByRole('status')).toHaveTextContent(/共 \d+ 筆，第 1／1 頁/);
    // 唯讀：表格裡沒有任何按鈕
    expect(within(table).queryAllByRole('button')).toEqual([]);
  });

  it('filters by category and action, then paginates', async () => {
    const { user } = await openPage();
    await user.selectOptions(screen.getByLabelText('類別'), 'role');
    await user.click(screen.getByRole('button', { name: '查詢' }));
    expect(await screen.findByText('共 5 筆，第 1／1 頁')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '稽核紀錄' });
    expect(within(table).getAllByRole('row').slice(1).every((r) => r.textContent!.includes('角色'))).toBe(true);

    await user.selectOptions(screen.getByLabelText('類別'), '');
    await user.type(screen.getByLabelText('動作（開頭符合）'), 'gra');
    await user.click(screen.getByRole('button', { name: '查詢' }));
    expect(await screen.findByText('共 5 筆，第 1／1 頁')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清除條件' }));
    await user.selectOptions(screen.getByLabelText('每頁'), '20');
    expect(await screen.findByText('共 21 筆，第 1／2 頁')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '下一頁' }));
    expect(await screen.findByText('共 21 筆，第 2／2 頁')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: '稽核紀錄' })).getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '下一頁' })).toBeDisabled();
  });

  it('a new admin action appears at the top with the browser source', async () => {
    const { user } = await renderApp('/admin/projects');
    const form = await screen.findByRole('form', { name: '新增專案' });
    await user.type(within(form).getByLabelText('專案名稱（必填）'), 'AUDIT-P');
    await user.click(within(form).getByRole('button', { name: '新增專案' }));
    await screen.findByText('已新增專案「AUDIT-P」');
    await user.click(within(screen.getByRole('navigation', { name: '系統管理選單' })).getByRole('link', { name: '稽核與審核' }));
    const table = await screen.findByRole('table', { name: '稽核紀錄' });
    const first = (await within(table).findAllByRole('row'))[1];
    expect(first).toHaveTextContent('專案');
    expect(first).toHaveTextContent('create');
    expect(first).toHaveTextContent('127.0.0.1');
  });

  it('labels sources', () => {
    expect(sourceLabel(null).text).toBe('（未記錄）');
    expect(sourceLabel('local:bootstrap_admin')).toEqual({ text: '本機指令：登記初始管理者', raw: 'local:bootstrap_admin' });
    expect(sourceLabel('local:other').text).toBe('本機指令：other');
    expect(sourceLabel('10.0.0.5')).toEqual({ text: '10.0.0.5', raw: null });
  });
});
