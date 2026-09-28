import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { mockDb } from '../../src/mocks/handlers';
import { renderApp } from '../render';

async function userTable() {
  const t = await screen.findByRole('table', { name: '帳號列表' });
  await within(t).findByText('admin01');
  return t;
}
const row = (t: HTMLElement, name: string) => within(t).getByRole('row', { name: new RegExp(`^${name}\\b`) });

describe('admin users', () => {
  it('lists users with their account type', async () => {
    await renderApp('/admin/users');
    const t = await userTable();
    expect(within(row(t, 'vw01')).getByRole('combobox', { name: 'vw01 的帳號類型' })).toHaveValue('user');
    expect(within(row(t, 'admin01')).getByRole('combobox', { name: 'admin01 的帳號類型' })).toHaveValue('admin');
  });

  it('TC-A03-02 creates a user', async () => {
    const { user } = await renderApp('/admin/users');
    await userTable();
    const form = screen.getByRole('form', { name: '新增帳號' });
    await user.type(within(form).getByLabelText("帳號（必填）"), 'nurse01');
    await user.type(within(form).getByLabelText(/^初始密碼/), 'S3cret!pw');
    await user.selectOptions(within(form).getByLabelText('帳號類型'), 'user');
    await user.click(within(form).getByRole('button', { name: '新增帳號' }));
    expect(await screen.findByText('已新增帳號「nurse01」')).toBeInTheDocument();
    expect(within(await userTable()).getByText('nurse01')).toBeInTheDocument();
    expect(mockDb().users.find((u) => u.username === 'nurse01')?.account_type).toBe('user');
  });

  it('409 duplicate username is shown inline', async () => {
    const { user } = await renderApp('/admin/users');
    await userTable();
    const form = screen.getByRole('form', { name: '新增帳號' });
    await user.type(within(form).getByLabelText("帳號（必填）"), 'md01');
    await user.type(within(form).getByLabelText(/^初始密碼/), 'x');
    await user.click(within(form).getByRole('button', { name: '新增帳號' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('資料衝突');
    expect(alert).toHaveTextContent('帳號「md01」已存在');
  });

  it('422 missing password is shown inline and the field marked invalid', async () => {
    const { user } = await renderApp('/admin/users');
    await userTable();
    const form = screen.getByRole('form', { name: '新增帳號' });
    await user.type(within(form).getByLabelText("帳號（必填）"), 'nopw');
    await user.click(within(form).getByRole('button', { name: '新增帳號' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('密碼：不可空白');
    expect(within(form).getByLabelText(/^初始密碼/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('TC-A03-02 changes account type with PATCH {account_type}', async () => {
    let body: unknown = null;
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PATCH') body = await request.clone().json();
    });
    const { user } = await renderApp('/admin/users');
    const t = await userTable();
    await user.selectOptions(within(row(t, 'ra01')).getByRole('combobox', { name: 'ra01 的帳號類型' }), 'admin');
    expect(await screen.findByText('已將「ra01」改為 Admin')).toBeInTheDocument();
    expect(body).toEqual({ account_type: 'admin' });
    expect(mockDb().users.find((u) => u.username === 'ra01')?.account_type).toBe('admin');
    server.events.removeAllListeners();
  });

  it('409 when demoting the last admin reverts the select and explains why', async () => {
    const { user } = await renderApp('/admin/users');
    const t = await userTable();
    const select = within(row(t, 'admin01')).getByRole('combobox', { name: 'admin01 的帳號類型' });
    await user.selectOptions(select, 'user');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('至少要保留 1 個 Admin');
    await waitFor(() => expect(select).toHaveValue('admin'));
  });

  it('TC-A03-08 resets a password', async () => {
    const { user } = await renderApp('/admin/users');
    const t = await userTable();
    await user.click(within(row(t, 'ra01')).getByRole('button', { name: '重設 ra01 的密碼' }));
    const form = screen.getByRole('form', { name: '重設密碼：ra01' });
    await user.type(within(form).getByLabelText(/^新密碼/), 'N3w-pass');
    await user.click(within(form).getByRole('button', { name: '確認重設' }));
    expect(await screen.findByText('已重設「ra01」的密碼')).toBeInTheDocument();
    const ra = mockDb().users.find((u) => u.username === 'ra01')!;
    expect(mockDb().passwords[ra.id]).toBe('N3w-pass');
  });

  it('TC-A03-02 deletes a user after confirmation', async () => {
    const { user } = await renderApp('/admin/users');
    const t = await userTable();
    await user.click(within(row(t, 'user02')).getByRole('button', { name: '刪除 user02' }));
    const dialog = screen.getByRole('dialog', { name: '刪除帳號' });
    expect(dialog).toHaveTextContent('user02');
    await user.click(within(dialog).getByRole('button', { name: '確認刪除' }));
    expect(await screen.findByText('已刪除帳號「user02」')).toBeInTheDocument();
    expect(mockDb().users.some((u) => u.username === 'user02')).toBe(false);
  });

  it('409 when deleting yourself is shown inline', async () => {
    const { user } = await renderApp('/admin/users');
    const t = await userTable();
    await user.click(within(row(t, 'admin01')).getByRole('button', { name: '刪除 admin01' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '確認刪除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('不能刪除自己的帳號');
  });

  it('403 while loading the list shows a no-permission message', async () => {
    server.use(http.get('*/api/admin/users', () => HttpResponse.json({ detail: '需要 Admin 權限' }, { status: 403 })));
    await renderApp('/admin/users');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('沒有權限');
    expect(alert).toHaveTextContent('需要 Admin 權限');
  });
});
