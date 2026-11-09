import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderApp } from '../render';
import { flattenAuditDetail } from '../../src/pages/admin/AuditPage';
import { diffAllowlist, invalidAccessions, parseAccessionFile } from '../../src/pages/imaging/AllowlistEditor';

describe('B17 總覽', () => {
  it('頂端四格統計可點，待處理事項與系統狀態分兩張卡片', async () => {
    await renderApp('/admin');
    expect(await screen.findByRole('link', { name: /專案總數\s*3/ })).toHaveAttribute('href', '/admin/projects');
    expect(screen.getByRole('link', { name: /帳號總數\s*8/ })).toHaveAttribute('href', '/admin/users');
    expect(screen.getByRole('link', { name: /執行中工作/ })).toHaveAttribute('href', '/admin/compute/gpu');
    const pending = screen.getByRole('list', { name: '待處理事項' });
    expect(within(pending).getByRole('link', { name: '失敗工作（0 件）' })).toHaveAttribute('href', '/admin/compute/jobs');
    const status = screen.getByRole('region', { name: '系統狀態' });
    expect(within(status).getByRole('link', { name: '查看全部 ›' })).toHaveAttribute('href', '/admin/monitoring');
    expect(await within(status).findByText(/運作正常|未就緒|尚未登記節點/)).toBeInTheDocument();
  });
});

describe('B18 帳號管理', () => {
  it('搜尋與類型篩選；點「編輯」右側顯示帳號、類型與所屬專案，改類型要按儲存', async () => {
    const { user } = await renderApp('/admin/users');
    const table = await screen.findByRole('table', { name: '帳號列表' });
    await within(table).findByText('admin01');
    await user.selectOptions(screen.getByRole('combobox', { name: '帳號類型篩選' }), 'admin');
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['admin01']);
    await user.selectOptions(screen.getByRole('combobox', { name: '帳號類型篩選' }), '');
    await user.type(screen.getByRole('searchbox', { name: '搜尋帳號名稱或所屬專案' }), 'md');
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['md01']);

    // 預設右側是新增帳號；點編輯換成該帳號
    expect(screen.getByRole('form', { name: '新增帳號' })).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: '編輯 md01' }));
    const panel = screen.getByRole('complementary', { name: 'md01' });
    expect(screen.queryByRole('form', { name: '新增帳號' })).toBeNull();
    expect(await within(panel).findByRole('link', { name: 'P1-lung-ct' })).toBeInTheDocument();
    const save = within(panel).getByRole('button', { name: '儲存變更' });
    expect(save).toBeDisabled();
    await user.selectOptions(within(panel).getByLabelText('類型'), 'admin');
    expect(within(panel).getByText(/將帳號類型從 User 改為 Admin/)).toBeInTheDocument();
    await user.click(save);
    expect(await screen.findByText('已將「md01」改為 Admin')).toBeInTheDocument();
  });
});

describe('B19 成員與權限', () => {
  it('右側編輯成員顯示變更摘要（新增／移除權限）', async () => {
    const { user } = await renderApp('/admin/projects/1/members');
    const table = await screen.findByRole('table', { name: '目前的專案成員' });
    await within(table).findByRole('row', { name: /ra01/ });
    expect(screen.getByRole('heading', { name: '專案成員（5 人）' })).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: '編輯 ra01' }));
    const form = screen.getByRole('form', { name: '設定專案成員' });
    await user.click(within(form).getByRole('checkbox', { name: /^Training/ }));
    await user.click(within(form).getByRole('checkbox', { name: /^Coding/ }));
    expect(within(form).getByText('新增權限：Coding')).toBeInTheDocument();
    expect(within(form).getByText('移除權限：Training')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: '取消' }));
    expect(within(form).queryByText(/新增權限/)).toBeNull();
    // 搜尋只影響表格
    await user.type(screen.getByRole('searchbox', { name: '搜尋成員帳號或角色' }), 'doctor');
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['md01']);
  });
});

describe('B20 稽核紀錄詳情（F10）', () => {
  it('flattenAuditDetail 把 from/to 攤平成變更前後，其他欄位逐一列出', () => {
    expect(flattenAuditDetail({ account_type: { from: 'user', to: 'admin' } })).toEqual({
      changes: [{ field: '帳號類型', before: 'user', after: 'admin' }],
      fields: [],
    });
    expect(flattenAuditDetail({ from: ['project'], to: ['project', 'labeling'] }).changes).toEqual([
      { field: '（本筆）', before: 'project', after: 'project、labeling' },
    ]);
    const r = flattenAuditDetail({ queue: 'q1', before: [3, 1], after: [1, 3], extra: { nested: true } });
    expect(r.changes).toEqual([{ field: '（本筆）', before: '3、1', after: '1、3' }]);
    expect(r.fields).toEqual([
      { field: '佇列', value: 'q1' },
      { field: 'extra › nested', value: '是' },
    ]);
    expect(flattenAuditDetail({})).toEqual({ changes: [], fields: [] });
  });

  it('點一筆紀錄，右側顯示操作詳情與可展開的原始內容', async () => {
    const { user } = await renderApp('/admin/audit');
    const table = await screen.findByRole('table', { name: '稽核紀錄' });
    const rows = await within(table).findAllByRole('row', { name: /admin01/ });
    expect(screen.getByText(/點選左側一筆紀錄/)).toBeInTheDocument();
    await user.click(rows[0]);
    const panel = screen.getByRole('complementary', { name: '操作詳情' });
    expect(within(panel).getByText('操作者')).toBeInTheDocument();
    expect(within(panel).getByText('變更內容')).toBeInTheDocument();
    // 表格仍然沒有按鈕（唯讀）
    expect(within(table).queryAllByRole('button')).toEqual([]);
  });
});

describe('B07 Accession Number 清單（F7）', () => {
  it('解析上傳檔、檢查格式、計算差異', () => {
    expect(parseAccessionFile('list.csv', 'accession_number,note\nACC1,x\n"ACC2",y\nACC1,z\n')).toEqual(['ACC1', 'ACC2']);
    expect(parseAccessionFile('list.txt', 'ACC1\r\nACC2\n')).toEqual(['ACC1', 'ACC2']);
    expect(invalidAccessions(['ACC1', 'ACC*', 'X'.repeat(17)])).toEqual(['ACC*', 'X'.repeat(17)]);
    const d = diffAllowlist(['A', 'B', 'C'], ['B', 'C', 'D']);
    expect(d.added).toEqual(['D']);
    expect(d.removed).toEqual(['A']);
    expect(d.rows).toEqual([
      { accession: 'B', before: true, after: true },
      { accession: 'C', before: true, after: true },
      { accession: 'D', before: false, after: true },
      { accession: 'A', before: true, after: false },
    ]);
  });

  it('上傳 .txt 後顯示新增／移除與逐筆預覽；勾選「已確認變更範圍」才能儲存', async () => {
    const { user } = await renderApp('/admin/projects/1/allowlist');
    const form = await screen.findByRole('form', { name: '設定 Accession Number 清單' });
    const save = within(form).getByRole('button', { name: '儲存清單' });
    expect(save).toBeDisabled();
    const file = new File(['ACC0011\nACC0013\nACC0011\n'], 'list.txt', { type: 'text/plain' });
    await user.upload(within(form).getByLabelText('選擇檔案或拖曳上傳'), file);
    expect(await within(form).findByText(/已讀入「list.txt」，共 2 筆/)).toBeInTheDocument();
    const diff = within(form).getByRole('group', { name: '與目前清單的差異' });
    expect(diff).toHaveTextContent('新清單2 筆');
    expect(diff).toHaveTextContent('新增 2');
    expect(diff).toHaveTextContent('移除 0');
    const preview = within(form).getByRole('table', { name: '變更預覽' });
    expect(within(preview).getAllByRole('row')).toHaveLength(3);
    expect(within(preview).getByRole('row', { name: /ACC0011/ })).toHaveTextContent('不限制包含新增');
    expect(save).toBeDisabled();
    await user.click(within(form).getByRole('checkbox', { name: /已確認變更範圍/ }));
    expect(save).toBeEnabled();
    // 再改內容要重新確認
    await user.type(within(form).getByLabelText(/^Accession Number/), '\nACC*');
    expect(within(form).getByRole('checkbox', { name: /已確認變更範圍/ })).not.toBeChecked();
    expect(within(form).getByText(/格式不符 1 筆：ACC\*/)).toBeInTheDocument();
  });

  it('不是 .csv／.txt 的檔案會提示', async () => {
    const { user } = await renderApp('/admin/projects/1/allowlist');
    const form = await screen.findByRole('form', { name: '設定 Accession Number 清單' });
    const input = within(form).getByLabelText('選擇檔案或拖曳上傳') as HTMLInputElement;
    input.removeAttribute('accept');
    await user.upload(input, new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('「a.pdf」不是 .csv 或 .txt 檔。');
  });
});
