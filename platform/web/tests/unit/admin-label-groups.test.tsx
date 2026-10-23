import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { mockDb } from '../../src/mocks/handlers';
import { renderApp } from '../render';

// 標註群組在管理區的單一專案頁（/admin/projects/:id/groups），專案由路由決定
async function openPage(projectId = 1) {
  const r = await renderApp(`/admin/projects/${projectId}/groups`);
  const form = await screen.findByRole('form', { name: '新增標註群組' });
  if (projectId === 1) await within(form).findByRole('checkbox', { name: /md01/ });
  return { ...r, form };
}

describe('admin labeling groups', () => {
  it('lists only project members as candidates, with their role', async () => {
    const { form } = await openPage();
    const boxes = within(form).getAllByRole('checkbox').map((b) => b.closest('label')!.textContent);
    expect(boxes).toEqual([
      'ca01（Coder Assistant）',
      'md01（Medical Doctor）',
      'pi01（Principal Investigator）',
      'ra01（Research Assistant）',
      'vw01（Viewer）',
    ]);
    expect(screen.getByText('這個專案還沒有標註群組。')).toBeInTheDocument();
  });

  it('creates, edits and deletes a group', async () => {
    const { user, form } = await openPage();
    await user.type(within(form).getByLabelText('群組名稱（必填）'), '肺結節標註組');
    await user.type(within(form).getByLabelText('說明'), '第一輪');
    await user.click(within(form).getByRole('checkbox', { name: /md01/ }));
    await user.click(within(form).getByRole('checkbox', { name: /ra01/ }));
    await user.click(within(form).getByRole('button', { name: '新增群組' }));
    expect(await screen.findByText('已新增標註群組「肺結節標註組」')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '標註群組列表' });
    const row = await within(table).findByRole('row', { name: /肺結節標註組/ });
    expect(row).toHaveTextContent('第一輪');
    expect(row).toHaveTextContent('md01、ra01');
    expect(mockDb().labelGroups).toHaveLength(1);

    await user.click(within(row).getByRole('button', { name: '編輯 肺結節標註組' }));
    const edit = await screen.findByRole('form', { name: '編輯標註群組：肺結節標註組' });
    expect((within(edit).getByRole('checkbox', { name: /md01/ }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(edit).getByRole('checkbox', { name: /md01/ }));
    await user.click(within(edit).getByRole('button', { name: '儲存變更' }));
    expect(await screen.findByText('已更新標註群組「肺結節標註組」')).toBeInTheDocument();
    expect(await within(table).findByRole('row', { name: /肺結節標註組/ })).toHaveTextContent('ra01');
    expect(within(table).getByRole('row', { name: /肺結節標註組/ })).not.toHaveTextContent('md01');

    await user.click(within(table).getByRole('button', { name: '刪除 肺結節標註組' }));
    const dialog = screen.getByRole('dialog', { name: '刪除標註群組' });
    await user.click(within(dialog).getByRole('button', { name: '確認刪除' }));
    expect(await screen.findByText('已刪除標註群組「肺結節標註組」')).toBeInTheDocument();
    expect(mockDb().labelGroups).toHaveLength(0);
  });

  it('shows 409 and 422 errors inline', async () => {
    const { user, form } = await openPage();
    await user.click(within(form).getByRole('button', { name: '新增群組' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('資料驗證失敗');
    await user.type(within(form).getByLabelText('群組名稱（必填）'), 'G');
    await user.click(within(form).getByRole('button', { name: '新增群組' }));
    await screen.findByText('已新增標註群組「G」');
    await user.type(within(form).getByLabelText('群組名稱（必填）'), 'G');
    await user.click(within(form).getByRole('button', { name: '新增群組' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('已存在');
  });

  it('switching project shows that project’s members and groups', async () => {
    await openPage(2);
    expect(await screen.findByText('這個專案還沒有成員。')).toBeInTheDocument();
  });
});
