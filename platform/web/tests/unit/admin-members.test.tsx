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

// 成員頁在管理區的單一專案頁（/admin/projects/:id/members），專案由路由決定
async function openPage(projectId = 1) {
  const r = await renderApp(`/admin/projects/${projectId}/members`);
  const table = await screen.findByRole('table', { name: '目前的專案成員' });
  if (projectId === 1) await within(table).findByRole('row', { name: /ra01/ });
  else await within(table).findByText('這個專案還沒有成員。');
  const form = screen.getByRole('form', { name: '設定專案成員' });
  return { ...r, form, table };
}

function captureWrites() {
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
  it('loads the current members with role and permissions; no outdated notice', async () => {
    const { table } = await openPage();
    expect(screen.queryByText(/列出專案成員的 API/)).toBeNull();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      'Coder Assistant',
      'Medical Doctor',
      'Principal Investigator',
      'Research Assistant',
      'Viewer',
    ]);
    expect(within(table).getByRole('row', { name: /ra01/ })).toHaveTextContent('Project、Labeling、Training、Prediction');
  });

  it('choosing an existing member prefills their current role and permissions (not Viewer)', async () => {
    const { user, form } = await openPage();
    expect(within(form).getByRole('button', { name: /加入專案|儲存變更/ })).toBeDisabled(); // 尚未選帳號
    await user.selectOptions(within(form).getByLabelText('帳號'), 'ra01（已是成員）');
    expect((within(form).getByLabelText('角色') as HTMLSelectElement).value).toBe('research_assistant');
    expect(checkedPerms(form)).toEqual(['Project', 'Labeling', 'Training', 'Prediction']);
    expect(within(form).getByRole('status')).toHaveTextContent('「ra01」目前是 Research Assistant');
    expect(within(form).getByRole('button', { name: '儲存變更' })).toBeDisabled(); // 沒有變更

    await user.selectOptions(within(form).getByLabelText('帳號'), 'md01（已是成員）');
    expect((within(form).getByLabelText('角色') as HTMLSelectElement).value).toBe('medical_doctor');
    expect(checkedPerms(form)).toEqual(['Project', 'Labeling', 'Prediction']);
  });

  it('the 編輯 button in the table prefills the form', async () => {
    const { user, form, table } = await openPage();
    await user.click(within(table).getByRole('button', { name: '編輯 pi01' }));
    expect((within(form).getByLabelText('角色') as HTMLSelectElement).value).toBe('principal_investigator');
    expect(checkedPerms(form)).toEqual(PERMS);
  });

  it('changing a role asks for confirmation; cancelling sends nothing', async () => {
    const seen = captureWrites();
    const { user, form, table } = await openPage();
    await user.selectOptions(within(form).getByLabelText('帳號'), 'md01（已是成員）');
    await user.selectOptions(within(form).getByLabelText('角色'), 'viewer');
    await user.click(within(form).getByRole('button', { name: '儲存變更' }));
    const dialog = screen.getByRole('dialog', { name: '變更角色' });
    expect(dialog).toHaveTextContent('從 Medical Doctor 改為 Viewer');
    expect(dialog).toHaveTextContent('Project、Labeling、Prediction → Project、Prediction');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(seen).toEqual([]);
    expect(within(table).getByRole('row', { name: /md01/ })).toHaveTextContent('Medical Doctor');

    await user.click(within(form).getByRole('button', { name: '儲存變更' }));
    await user.click(within(screen.getByRole('dialog', { name: '變更角色' })).getByRole('button', { name: '確認變更' }));
    expect(await screen.findByText(/已將「md01」設定為「P1-lung-ct」的 Viewer/)).toBeInTheDocument();
    expect(await within(table).findByRole('row', { name: /md01.*Viewer/ })).toBeInTheDocument();
    server.events.removeAllListeners();
    const md = mockDb().users.find((u) => u.username === 'md01')!;
    expect(seen).toEqual([
      { method: 'PUT', url: `/api/admin/projects/1/members/${md.id}`, body: { role: 'viewer', permissions: ['project', 'prediction'] } },
    ]);
  });

  it('a permission-only change saves without the role dialog', async () => {
    const { user, form, table } = await openPage();
    await user.selectOptions(within(form).getByLabelText('帳號'), 'ra01（已是成員）');
    await user.click(within(form).getByRole('checkbox', { name: /^Training/ }));
    await user.click(within(form).getByRole('button', { name: '儲存變更' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText(/已將「ra01」設定為「P1-lung-ct」的 Research Assistant/)).toBeInTheDocument();
    expect(await within(table).findByRole('row', { name: /ra01.*Labeling、Prediction/ })).toBeInTheDocument();
  });

  it('adds a new member with Viewer defaults and edited permissions', async () => {
    const { user, form } = await openPage(2);
    const table = screen.getByRole('table', { name: '目前的專案成員' });
    expect(await within(table).findByText('這個專案還沒有成員。')).toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText('帳號'), 'md01');
    expect(within(form).getByRole('status')).toHaveTextContent('還不是這個專案的成員');
    expect(checkedPerms(form)).toEqual(['Project', 'Prediction']);
    await user.selectOptions(within(form).getByLabelText('角色'), 'medical_doctor');
    await user.click(within(form).getByRole('checkbox', { name: /^Training/ }));
    await user.click(within(form).getByRole('button', { name: '加入專案' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await within(table).findByRole('row', { name: /md01/ })).toHaveTextContent('Project、Labeling、Training、Prediction');
  });

  it('removes a member after confirmation (DELETE)', async () => {
    const { user, table } = await openPage();
    await user.click(within(table).getByRole('button', { name: '移除 vw01' }));
    const dialog = screen.getByRole('dialog', { name: '移除專案成員' });
    expect(dialog).toHaveTextContent('vw01');
    expect(dialog).toHaveTextContent('P1-lung-ct');
    await user.click(within(dialog).getByRole('button', { name: '確認移除' }));
    expect(await screen.findByText('已將「vw01」移出「P1-lung-ct」')).toBeInTheDocument();
    const vw = mockDb().users.find((u) => u.username === 'vw01')!;
    expect(mockDb().memberships.some((m) => m.user_id === vw.id && m.project_id === 1)).toBe(false);
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
    const { user, form } = await openPage();
    await user.selectOptions(within(form).getByLabelText('帳號'), 'user01');
    await user.click(within(form).getByRole('button', { name: '加入專案' }));
    let alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('資料驗證失敗');
    expect(alert).toHaveTextContent('權限：值不在允許清單中');

    server.use(
      http.put('*/api/admin/projects/:pid/members/:uid', () =>
        HttpResponse.json({ detail: '需要 Admin 權限' }, { status: 403 }),
      ),
    );
    await user.click(within(form).getByRole('button', { name: '加入專案' }));
    alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('沒有權限');
  });
});
