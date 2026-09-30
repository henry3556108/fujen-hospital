import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { mockDb } from '../../src/mocks/handlers';
import { renderApp } from '../render';

async function projectTable() {
  return screen.findByRole('table', { name: '專案列表' });
}

function rowFor(table: HTMLElement, name: string) {
  return within(table).getByRole('row', { name: new RegExp(name) });
}

describe('admin projects', () => {
  it('lists projects', async () => {
    await renderApp('/admin/projects');
    const table = await projectTable();
    await within(table).findByText('P1-lung-ct');
    expect(within(table).getByText('P2-tabular')).toBeInTheDocument();
    expect(within(table).getByText('P3-llm')).toBeInTheDocument();
  });

  it('TC-A03-01 creates a project', async () => {
    const { user } = await renderApp('/admin/projects');
    await projectTable();
    await user.type(screen.getByLabelText(/^專案名稱/), 'P4-new');
    await user.type(screen.getByLabelText('說明'), '新專案');
    await user.click(screen.getByRole('button', { name: '新增專案' }));
    expect(await screen.findByText('已新增專案「P4-new」')).toBeInTheDocument();
    expect(within(await projectTable()).getByText('P4-new')).toBeInTheDocument();
    expect(mockDb().projects.map((p) => p.name)).toContain('P4-new');
  });

  it('409 duplicate name shows an inline message with icon and text', async () => {
    const { user } = await renderApp('/admin/projects');
    await projectTable();
    await user.type(screen.getByLabelText(/^專案名稱/), 'P1-lung-ct');
    await user.click(screen.getByRole('button', { name: '新增專案' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('資料衝突');
    expect(alert).toHaveTextContent('專案名稱「P1-lung-ct」已存在');
    expect(alert.querySelector('svg')).not.toBeNull();
  });

  it('422 validation error lists the field and marks the input invalid', async () => {
    const { user } = await renderApp('/admin/projects');
    await projectTable();
    await user.click(screen.getByRole('button', { name: '新增專案' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('資料驗證失敗');
    expect(alert).toHaveTextContent('專案名稱：不可空白');
    expect(screen.getByLabelText(/^專案名稱/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('403 is shown as a no-permission message', async () => {
    server.use(http.post('*/api/admin/projects', () => HttpResponse.json({ detail: '需要 Admin 權限' }, { status: 403 })));
    const { user } = await renderApp('/admin/projects');
    await projectTable();
    await user.type(screen.getByLabelText(/^專案名稱/), 'X');
    await user.click(screen.getByRole('button', { name: '新增專案' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('沒有權限');
    expect(alert).toHaveTextContent('需要 Admin 權限');
  });

  it('TC-A03-01 edits a project name and description', async () => {
    const { user } = await renderApp('/admin/projects');
    const table = await projectTable();
    await within(table).findByText('P2-tabular');
    await user.click(within(rowFor(table, 'P2-tabular')).getByRole('button', { name: /編輯/ }));
    const form = screen.getByRole('form', { name: '編輯專案' });
    const name = within(form).getByLabelText(/^專案名稱/);
    await user.clear(name);
    await user.type(name, 'P2-renamed');
    await user.click(within(form).getByRole('button', { name: '儲存' }));
    expect(await screen.findByText('已更新專案「P2-renamed」')).toBeInTheDocument();
    expect(within(await projectTable()).getByText('P2-renamed')).toBeInTheDocument();
  });

  it('TC-A03-01 asks for confirmation before deleting; cancel keeps the project', async () => {
    const { user } = await renderApp('/admin/projects');
    const table = await projectTable();
    await within(table).findByText('P3-llm');
    await user.click(within(rowFor(table, 'P3-llm')).getByRole('button', { name: /刪除/ }));
    let dialog = screen.getByRole('dialog', { name: '刪除專案' });
    expect(dialog).toHaveTextContent('P3-llm');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockDb().projects.some((p) => p.name === 'P3-llm')).toBe(true);

    await user.click(within(rowFor(table, 'P3-llm')).getByRole('button', { name: /刪除/ }));
    dialog = screen.getByRole('dialog', { name: '刪除專案' });
    await user.click(within(dialog).getByRole('button', { name: '確認刪除' }));
    expect(await screen.findByText('已刪除專案「P3-llm」')).toBeInTheDocument();
    await waitFor(() => expect(within(table).queryByText('P3-llm')).toBeNull());
    expect(mockDb().projects.some((p) => p.name === 'P3-llm')).toBe(false);
  });

  it('confirm dialog closes with Escape and moves focus into the dialog', async () => {
    const { user } = await renderApp('/admin/projects');
    const table = await projectTable();
    await within(table).findByText('P3-llm');
    await user.click(within(rowFor(table, 'P3-llm')).getByRole('button', { name: /刪除/ }));
    const dialog = screen.getByRole('dialog', { name: '刪除專案' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('GPU group is picked from the defined groups (not typed)', async () => {
    const { user } = await renderApp('/admin/projects');
    await projectTable();
    const form = screen.getByRole('form', { name: '新增專案' });
    const picker = within(form).getByRole('combobox', { name: 'GPU 群組' });
    await waitFor(() =>
      expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
        '不綁定',
        'gpu-exclusive（獨占，2 張）',
        'gpu-shared（共享，1 張）',
      ]),
    );
    await user.type(within(form).getByLabelText(/^專案名稱/), 'P4-gpu');
    await user.selectOptions(picker, 'gpu-shared');
    await user.click(within(form).getByRole('button', { name: '新增專案' }));
    expect(await screen.findByText('已新增專案「P4-gpu」')).toBeInTheDocument();
    expect(mockDb().projects.find((p) => p.name === 'P4-gpu')?.gpu_group).toBe('gpu-shared');
  });

  it('editing shows the current group selected and can unbind it', async () => {
    const { user } = await renderApp('/admin/projects');
    const table = await projectTable();
    await within(table).findByText('P1-lung-ct');
    await user.click(within(rowFor(table, 'P1-lung-ct')).getByRole('button', { name: /編輯/ }));
    const form = screen.getByRole('form', { name: '編輯專案' });
    const picker = within(form).getByRole('combobox', { name: 'GPU 群組' });
    await waitFor(() => expect(picker).toHaveValue('gpu-exclusive'));
    await user.selectOptions(picker, '');
    await user.click(within(form).getByRole('button', { name: '儲存' }));
    expect(await screen.findByText('已更新專案「P1-lung-ct」')).toBeInTheDocument();
    expect(mockDb().projects.find((p) => p.name === 'P1-lung-ct')?.gpu_group).toBeNull();
  });

  it('a bound group that no longer exists stays selectable and is marked', async () => {
    mockDb().projects[0].gpu_group = 'gpu-removed';
    const { user } = await renderApp('/admin/projects');
    const table = await projectTable();
    await within(table).findByText('P1-lung-ct');
    await user.click(within(rowFor(table, 'P1-lung-ct')).getByRole('button', { name: /編輯/ }));
    const picker = within(screen.getByRole('form', { name: '編輯專案' })).getByRole('combobox', { name: 'GPU 群組' });
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'gpu-removed（已不存在）' })).toBeInTheDocument());
    expect(picker).toHaveValue('gpu-removed');
  });

  it('when the group list cannot be loaded, the error is shown and only 不綁定 and the current value remain', async () => {
    server.use(
      http.get('*/api/admin/gpu-groups', () => HttpResponse.json({ detail: '排程服務尚未設定（JOB_BACKEND）' }, { status: 503 })),
    );
    const { user } = await renderApp('/admin/projects');
    const table = await projectTable();
    await within(table).findByText('P3-llm');
    await user.click(within(rowFor(table, 'P3-llm')).getByRole('button', { name: /編輯/ }));
    const form = screen.getByRole('form', { name: '編輯專案' });
    expect(await within(form).findByRole('alert')).toHaveTextContent('排程服務尚未設定');
    const picker = within(form).getByRole('combobox', { name: 'GPU 群組' });
    expect(within(picker).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['', 'gpu-shared']);
  });
});
