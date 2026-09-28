import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { mockDb } from '../../src/mocks/handlers';
import { renderApp } from '../render';

const PERMS = ['Project', 'Labeling', 'Training', 'Prediction', 'Coding'];

function checkedPerms(form: HTMLElement) {
  return PERMS.filter((p) => (within(form).getByRole('checkbox', { name: new RegExp(`^${p}`) }) as HTMLInputElement).checked);
}

async function openForm() {
  const r = await renderApp('/admin/members');
  const form = await screen.findByRole('form', { name: '設定專案成員' });
  await within(form).findByRole('option', { name: 'P1-lung-ct' });
  await within(form).findByRole('option', { name: 'md01' });
  return { ...r, form };
}

function captureRequests() {
  const seen: { method: string; url: string; body: unknown }[] = [];
  server.events.on('request:start', async ({ request }) => {
    if (request.method === 'GET') return;
    let body: unknown = null;
    try {
      body = await request.clone().json();
    } catch {
      body = null;
    }
    seen.push({ method: request.method, url: new URL(request.url).pathname, body });
  });
  return seen;
}

describe('admin project members', () => {
  it('explains that the member list API is missing', async () => {
    await openForm();
    expect(screen.getByText(/列出專案成員的 API/)).toBeInTheDocument();
  });

  it('checkboxes default from the role; changing role resets them to the new defaults', async () => {
    const { user, form } = await openForm();
    await user.selectOptions(within(form).getByLabelText('角色'), 'viewer');
    expect(checkedPerms(form)).toEqual(['Project', 'Prediction']);
    await user.click(within(form).getByRole('checkbox', { name: /^Coding/ }));
    expect(checkedPerms(form)).toEqual(['Project', 'Prediction', 'Coding']);
    await user.selectOptions(within(form).getByLabelText('角色'), 'medical_doctor');
    expect(checkedPerms(form)).toEqual(['Project', 'Labeling', 'Prediction']);
    await user.selectOptions(within(form).getByLabelText('角色'), 'coder_assistant');
    expect(checkedPerms(form)).toEqual(['Project', 'Training', 'Prediction', 'Coding']);
    await user.selectOptions(within(form).getByLabelText('角色'), 'principal_investigator');
    expect(checkedPerms(form)).toEqual(PERMS);
  });

  it('adds a member with role and edited permissions using the right PUT body', async () => {
    const seen = captureRequests();
    const { user, form } = await openForm();
    await user.selectOptions(within(form).getByLabelText('專案'), 'P2-tabular');
    await user.selectOptions(within(form).getByLabelText('帳號'), 'md01');
    await user.selectOptions(within(form).getByLabelText('角色'), 'medical_doctor');
    await user.click(within(form).getByRole('checkbox', { name: /^Labeling/ }));
    await user.click(within(form).getByRole('checkbox', { name: /^Training/ }));
    await user.click(within(form).getByRole('button', { name: '儲存成員設定' }));
    expect(await screen.findByText('已將「md01」設定為「P2-tabular」的 Medical Doctor')).toBeInTheDocument();
    server.events.removeAllListeners();

    const md = mockDb().users.find((u) => u.username === 'md01')!;
    expect(seen).toEqual([
      {
        method: 'PUT',
        url: `/api/admin/projects/2/members/${md.id}`,
        body: { role: 'medical_doctor', permissions: ['project', 'training', 'prediction'] },
      },
    ]);
    const table = screen.getByRole('table', { name: '本次設定的成員' });
    const row = within(table).getByRole('row', { name: /md01/ });
    expect(row).toHaveTextContent('P2-tabular');
    expect(row).toHaveTextContent('Project、Training、Prediction');
  });

  it('removes a member after confirmation (DELETE)', async () => {
    const { user, form } = await openForm();
    await user.selectOptions(within(form).getByLabelText('專案'), 'P1-lung-ct');
    await user.selectOptions(within(form).getByLabelText('帳號'), 'vw01');
    await user.click(within(form).getByRole('button', { name: '從專案移除' }));
    const dialog = screen.getByRole('dialog', { name: '移除專案成員' });
    expect(dialog).toHaveTextContent('vw01');
    expect(dialog).toHaveTextContent('P1-lung-ct');
    await user.click(within(dialog).getByRole('button', { name: '確認移除' }));
    expect(await screen.findByText('已將「vw01」移出「P1-lung-ct」')).toBeInTheDocument();
    const vw = mockDb().users.find((u) => u.username === 'vw01')!;
    expect(mockDb().memberships.some((m) => m.user_id === vw.id && m.project_id === 1)).toBe(false);
  });

  it('removing a non-member shows the 404 message inline', async () => {
    const { user, form } = await openForm();
    await user.selectOptions(within(form).getByLabelText('專案'), 'P3-llm');
    await user.selectOptions(within(form).getByLabelText('帳號'), 'user01');
    await user.click(within(form).getByRole('button', { name: '從專案移除' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '確認移除' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('找不到資料');
    expect(alert).toHaveTextContent('不在專案');
  });

  it('a member added this session can be removed from the session list', async () => {
    const { user, form } = await openForm();
    await user.selectOptions(within(form).getByLabelText('專案'), 'P3-llm');
    await user.selectOptions(within(form).getByLabelText('帳號'), 'user01');
    await user.click(within(form).getByRole('button', { name: '儲存成員設定' }));
    const table = await screen.findByRole('table', { name: '本次設定的成員' });
    await user.click(within(table).getByRole('button', { name: '移除 user01（P3-llm）' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '確認移除' }));
    expect(await screen.findByText('已將「user01」移出「P3-llm」')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: '本次設定的成員' })).toBeNull();
  });

  it('422 and 403 from PUT are shown inline with text', async () => {
    server.use(
      http.put('*/api/admin/projects/:pid/members/:uid', () =>
        HttpResponse.json(
          { detail: [{ type: 'enum', loc: ['body', 'permissions', 0], msg: 'Input should be ...', input: 'x' }] },
          { status: 422 },
        ),
      ),
    );
    const { user, form } = await openForm();
    await user.click(within(form).getByRole('button', { name: '儲存成員設定' }));
    let alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('資料驗證失敗');
    expect(alert).toHaveTextContent('權限：值不在允許清單中');

    server.use(
      http.put('*/api/admin/projects/:pid/members/:uid', () =>
        HttpResponse.json({ detail: '需要 Admin 權限' }, { status: 403 }),
      ),
    );
    await user.click(within(form).getByRole('button', { name: '儲存成員設定' }));
    alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('沒有權限');
  });
});
