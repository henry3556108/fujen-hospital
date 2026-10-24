import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { ENTRIES } from '../../src/access/entries';
import { confirmLeave, hasUnsavedChanges, useUnsavedChanges } from '../../src/components/unsaved';
import { primaryAction, runStatusText } from '../../src/pages/home/HomePage';
import type { ProjectOverview } from '../../src/pages/home/types';
import { renderApp } from '../render';

async function navLabels(name = '功能選單') {
  const nav = await screen.findByRole('navigation', { name });
  await within(nav).findAllByRole('link');
  return within(nav)
    .getAllByRole('link')
    .map((a) => a.textContent?.trim());
}

/** 功能目錄每列的入口名稱（列標題內的連結，不含「開啟 →」） */
function catalogNames(table: HTMLElement) {
  return within(table)
    .getAllByRole('rowheader')
    .flatMap((th) => within(th).queryAllByRole('link'))
    .map((a) => a.textContent ?? '');
}

describe('login and session', () => {
  it('unauthenticated visitor is sent to the login page, which links to password reset', async () => {
    await renderApp('/', null);
    expect(await screen.findByRole('heading', { level: 1, name: /登入/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /忘記密碼/ }).getAttribute('href')).toMatch(/login-actions\/reset-credentials\?client_id=/);
  });

  it('test-mode login picks a seed account and lands on the project home', async () => {
    const { user } = await renderApp('/', null);
    await user.selectOptions(await screen.findByLabelText('測試帳號'), 'vw01');
    await user.click(screen.getByRole('button', { name: /前往院方登入/ }));
    expect(await screen.findByRole('button', { name: '登出' })).toBeInTheDocument();
    expect(screen.getByText('vw01')).toBeInTheDocument();
    expect(await navLabels()).toEqual(['專案首頁', '研究資料', '使用模型', '功能目錄']);
    expect(await screen.findByRole('heading', { level: 1, name: '專案首頁' })).toBeInTheDocument();
  });

  it('401 from the API returns to the login page with a reason', async () => {
    server.use(http.get('*/api/me', () => HttpResponse.json({ detail: '登入已失效，請重新登入' }, { status: 401 })));
    const { auth } = await renderApp('/', 'md01');
    expect(await screen.findByRole('heading', { level: 1, name: /登入/ })).toBeInTheDocument();
    expect(screen.getByText(/登入已失效/)).toBeInTheDocument();
    expect(await auth.getUser()).toBeNull();
  });

  it('logout returns to the login page', async () => {
    const { user } = await renderApp('/', 'md01');
    await user.click(await screen.findByRole('button', { name: '登出' }));
    expect(await screen.findByRole('heading', { level: 1, name: /登入/ })).toBeInTheDocument();
  });
});

describe('app shell', () => {
  it('has landmarks, a skip link, the current project and my role in it; no theme switch', async () => {
    await renderApp('/', 'md01');
    await screen.findByRole('navigation', { name: '功能選單' });
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '跳到主要內容' })).toHaveAttribute('href', '#main');
    expect(screen.getByLabelText('目前專案')).toHaveDisplayValue('P1-lung-ct');
    expect(screen.getByTestId('header-role')).toHaveTextContent('我的身分（醫師）');
    expect(screen.queryByLabelText('色彩主題')).toBeNull();
  });

  it('the top-right 帳號・身分 menu opens 個人設定 and closes with Esc', async () => {
    const { user } = await renderApp('/', 'md01');
    const btn = await screen.findByRole('button', { name: /md01.*我的身分（醫師）/ });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await user.click(btn);
    expect(screen.getByRole('link', { name: '個人設定' })).toHaveAttribute('href', '/account');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('link', { name: '個人設定' })).toBeNull();
  });

  it('TC-A02-02 sidebar follows the five permissions', async () => {
    const cases: [string, string[]][] = [
      ['vw01', ['專案首頁', '研究資料', '使用模型', '功能目錄']],
      ['md01', ['專案首頁', '研究資料', '影像標註', '使用模型', '功能目錄']],
      ['ca01', ['專案首頁', '研究資料', '建立模型', '使用模型', '語言模型', '功能目錄']],
      ['pi01', ['專案首頁', '研究資料', '影像標註', '建立模型', '使用模型', '語言模型', '功能目錄']],
    ];
    for (const [username, labels] of cases) {
      const { unmount } = await renderApp('/', username);
      expect(await navLabels()).toEqual(labels);
      unmount();
    }
  });

  it('admin lands in the admin area with its own sidebar', async () => {
    await renderApp('/', 'admin01');
    expect(await screen.findByRole('heading', { level: 1, name: '總覽' })).toBeInTheDocument();
    // 設計稿 B12：「返回研究區」在側欄最上方（名稱仍是「回研究區」）
    expect(await navLabels('系統管理選單')).toEqual([
      '返回研究區',
      '總覽',
      '帳號',
      '專案',
      '運算資源',
      '系統監控',
      '資料交換',
      '稽核與審核',
      '功能目錄',
    ]);
    expect(within(screen.getByRole('navigation', { name: '系統管理選單' })).getByRole('link', { name: '回研究區' })).toHaveAttribute('href', '/projects');
  });

  it('admin choosing a project from 回研究區 enters the research area as that project', async () => {
    const { user } = await renderApp('/admin', 'admin01');
    const nav = await screen.findByRole('navigation', { name: '系統管理選單' });
    await user.click(within(nav).getByRole('link', { name: '回研究區' }));
    expect(await screen.findByRole('heading', { level: 1, name: '選擇研究專案' })).toBeInTheDocument();
    // 卡片點一下是選取（打勾），按「進入專案」才進入
    await user.click(screen.getByRole('button', { name: /P2-tabular/ }));
    expect(screen.getByRole('button', { name: /P2-tabular/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /進入專案/ }));
    expect(await screen.findByRole('heading', { level: 1, name: '專案首頁' })).toBeInTheDocument();
    expect(screen.getByLabelText('目前專案')).toHaveDisplayValue('P2-tabular');
    expect(await navLabels()).toContain('系統管理');
  });

  it('TC-A02-01 the 功能目錄 lists the 8 contract names (and the LLM alias) and each one opens', async () => {
    const { user } = await renderApp('/catalog', 'admin01');
    const table = await screen.findByRole('table', { name: '功能目錄' });
    const names = catalogNames(table);
    expect(names).toEqual([...ENTRIES.map((e) => e.label), 'LLM No-code 開發']);
    expect(within(table).getByRole('row', { name: /推論服務管理/ })).toHaveTextContent('使用模型／預測新資料與紀錄');
    for (const name of names) {
      const nav = screen.getByRole('navigation', { name: /選單/ });
      await user.click(within(nav).getByRole('link', { name: '功能目錄' }));
      await user.click(within(await screen.findByRole('table', { name: '功能目錄' })).getByRole('link', { name }));
      const main = screen.getByRole('main');
      await waitFor(() => expect(within(main).queryByRole('table', { name: '功能目錄' })).toBeNull());
      expect(within(main).queryByRole('heading', { name: '找不到頁面' })).toBeNull();
      expect(within(main).queryByRole('heading', { name: '無法存取此功能' })).toBeNull();
    }
  });

  it('vw01 sees only the entries it may use in the 功能目錄', async () => {
    await renderApp('/catalog', 'vw01');
    const table = await screen.findByRole('table', { name: '功能目錄' });
    expect(catalogNames(table)).toEqual(['數據管理', 'AI 模型部署', '推論服務管理']);
    // 分組標題與筆數（研究功能／管理）
    expect(table).toHaveTextContent('研究功能（1 項）');
    expect(table).toHaveTextContent('管理（2 項）');
    expect(within(table).getByRole('link', { name: '開啟數據管理' })).toHaveAttribute('href', '/data');
  });

  it('TC-A02-04 / TC-A03-05 vw01 typing a hidden entry URL sees an access-denied page with a text reason', async () => {
    await renderApp('/training', 'vw01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
    expect(screen.getByText(/沒有 Training 權限/)).toBeInTheDocument();
  });

  it('TC-A03-05 vw01 direct URL to labeling and LLM is denied too, old and new paths', async () => {
    for (const path of ['/labeling', '/auto-labeling', '/llm', '/labeling/auto', '/llm/chat']) {
      const { unmount } = await renderApp(path, 'vw01');
      expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
      unmount();
    }
  });

  it('TC-A03-03 non-admin opening account admin by URL sees a no-permission message', async () => {
    await renderApp('/admin/users', 'pi01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
    expect(screen.getByText(/需要 Admin 帳號類型/)).toBeInTheDocument();
  });

  it('old admin URLs go to their new places', async () => {
    const cases: [string, string][] = [
      ['/admin/dashboard', '總覽'],
      ['/admin/members', '專案'],
      ['/admin/labeling-groups', '專案'],
      ['/admin/scheduling', '排隊與共享設定'],
      ['/admin/scheduling/gpu-dashboard', '運算資源'],
      ['/admin/scheduling/monitoring', '系統監控'],
      ['/fhir/gateway', 'Gateway 路由與流量門檻'],
    ];
    for (const [path, heading] of cases) {
      const { unmount } = await renderApp(path, 'admin01');
      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
      unmount();
    }
  });

  it('project switcher re-evaluates the sidebar against the selected project', async () => {
    server.use(
      http.get('*/api/me', () =>
        HttpResponse.json({
          username: 'multi',
          account_type: 'user',
          projects: [
            { id: 1, name: 'P1-lung-ct', role: 'viewer', permissions: ['prediction', 'project'] },
            { id: 3, name: 'P3-llm', role: 'coder_assistant', permissions: ['coding', 'prediction', 'project', 'training'] },
          ],
        }),
      ),
    );
    const { user } = await renderApp('/', 'vw01');
    expect(await navLabels()).toEqual(['專案首頁', '研究資料', '使用模型', '功能目錄']);
    await user.selectOptions(screen.getByLabelText('目前專案'), 'P3-llm');
    await waitFor(async () => expect(await navLabels()).toEqual(['專案首頁', '研究資料', '建立模型', '使用模型', '語言模型', '功能目錄']));
    expect(screen.getByTestId('header-role')).toHaveTextContent('程式開發助理');
  });

  it('switching project with unsaved changes asks first; cancelling keeps the project', async () => {
    function Dirty() {
      useUnsavedChanges(true, '標註還沒儲存。');
      return null;
    }
    const { user } = await renderApp('/', 'pi01');
    server.use(
      http.get('*/api/me', () =>
        HttpResponse.json({
          username: 'pi01',
          account_type: 'user',
          projects: [
            { id: 1, name: 'P1-lung-ct', role: 'principal_investigator', permissions: ['project'] },
            { id: 2, name: 'P2-tabular', role: 'viewer', permissions: ['project'] },
          ],
        }),
      ),
    );
    fireEvent.focus(window);
    await waitFor(() => expect(within(screen.getByLabelText('目前專案')).getAllByRole('option')).toHaveLength(2));
    const extra = render(<Dirty />);
    expect(hasUnsavedChanges()).toBe(true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.selectOptions(screen.getByLabelText('目前專案'), 'P2-tabular');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('標註還沒儲存。'));
    expect(screen.getByLabelText('目前專案')).toHaveDisplayValue('P1-lung-ct');
    confirm.mockReturnValue(true);
    await user.selectOptions(screen.getByLabelText('目前專案'), 'P2-tabular');
    expect(screen.getByLabelText('目前專案')).toHaveDisplayValue('P2-tabular');
    confirm.mockRestore();
    act(() => extra.unmount());
    expect(hasUnsavedChanges()).toBe(false);
    expect(confirmLeave()).toBe(true);
  });

  it('a project created in another window appears in the switcher on window focus or when the menu gets focus', async () => {
    const projects = [{ id: 1, name: 'P1-lung-ct', role: 'viewer', permissions: ['prediction', 'project'] }];
    let calls = 0;
    server.use(
      http.get('*/api/me', () => {
        calls += 1;
        return HttpResponse.json({ username: 'multi', account_type: 'user', projects: [...projects] });
      }),
    );
    const { user } = await renderApp('/', 'vw01');
    const options = () => within(screen.getByLabelText('目前專案')).getAllByRole('option').map((o) => o.textContent);
    await waitFor(() => expect(options()).toEqual(['P1-lung-ct']));
    projects.push({ id: 4, name: 'P4-new', role: 'viewer', permissions: ['prediction', 'project'] });
    fireEvent.focus(window);
    await waitFor(() => expect(options()).toEqual(['P1-lung-ct', 'P4-new']));
    expect(screen.getByLabelText('目前專案')).toHaveValue('1');
    projects.push({ id: 5, name: 'P5-newer', role: 'viewer', permissions: ['prediction', 'project'] });
    const before = calls;
    await user.click(screen.getByLabelText('目前專案'));
    await waitFor(() => expect(options()).toEqual(['P1-lung-ct', 'P4-new', 'P5-newer']));
    expect(calls).toBeGreaterThan(before);
    expect(screen.getByRole('navigation', { name: '功能選單' })).toBeInTheDocument();
  });

  it('user without projects sees the no-project page and no research entries', async () => {
    await renderApp('/data', 'user01');
    expect(await screen.findByRole('heading', { name: '你尚未加入任何專案' })).toBeInTheDocument();
    expect(screen.getByText(/請聯絡專案管理者，將你的帳號加入研究專案。/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '登出' }).length).toBeGreaterThan(0);
    expect(await navLabels()).toEqual(['功能目錄']);
  });

  it('the account page shows my role in each project and a password link', async () => {
    await renderApp('/account', 'md01');
    expect(await screen.findByRole('heading', { level: 1, name: '個人帳號設定' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '我在各專案的身分' });
    expect(within(table).getByRole('row', { name: /P1-lung-ct/ })).toHaveTextContent('醫師（Medical Doctor）');
    expect(screen.getByRole('link', { name: /前往院方帳號服務修改密碼/ }).getAttribute('href')).toMatch(/\/account$/);
  });

  it('the project picker searches by name', async () => {
    const { user } = await renderApp('/projects', 'admin01');
    const list = await screen.findByRole('list', { name: '全部專案' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    await user.type(screen.getByLabelText('搜尋專案名稱'), 'tab');
    expect(within(screen.getByRole('list', { name: '全部專案' })).getAllByRole('button')).toHaveLength(1);
  });

  it('unknown path shows a not-found page', async () => {
    await renderApp('/nope', 'md01');
    expect(await screen.findByRole('heading', { name: '找不到頁面' })).toBeInTheDocument();
  });
});

describe('project home', () => {
  it('md01 sees how many are waiting and a 繼續標註 button', async () => {
    await renderApp('/', 'md01');
    expect(await screen.findByRole('heading', { name: /還有 \d+ 筆影像待處理/ })).toBeInTheDocument();
    // 讀到研究清單後直接指向第一筆待處理的工作台
    await waitFor(() => expect(screen.getByRole('link', { name: /繼續標註/ }).getAttribute('href')).toMatch(/^\/labeling\/studies\//));
    expect(screen.getByRole('progressbar', { name: '已確認' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '可使用的模型' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '最近訓練' })).toBeNull();
  });

  it('vw01 has no big button and gets the list of things to do', async () => {
    await renderApp('/', 'vw01');
    expect(await screen.findByRole('heading', { name: '可以做的事' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /繼續標註/ })).toBeNull();
  });

  it('still usable when the overview API fails', async () => {
    server.use(http.get('*/api/projects/:pid/overview', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    await renderApp('/', 'md01');
    expect(await screen.findByText(/的進度暫時讀不到/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '可以做的事' })).toBeInTheDocument();
  });

  it('primaryAction follows 03 規格 3.4 in order', () => {
    const base: ProjectOverview = { project: { id: 1, name: 'P' }, me: { role: null, permissions: [] } };
    const all = ['project', 'labeling', 'training', 'prediction'] as const;
    const withLast: ProjectOverview = {
      ...base,
      labeling: { pending: 3, confirmed: 1, total_studies: 4, last: { study_instance_uid: '1.2.3', accession_number: 'A1', updated_at: '2026-10-01T00:00:00Z' } },
      training: { recent: [], recent_completed: [9] },
    };
    expect(primaryAction(withLast, [...all])).toEqual({ kind: 'label', to: '/labeling', pending: 3 });
    expect(primaryAction(withLast, [...all], [], '1.2.4')).toEqual({ kind: 'label', to: '/labeling/studies/1.2.4', pending: 3 });
    expect(primaryAction(withLast, ['training'])).toEqual({ kind: 'result', to: '/training/runs/9', runId: 9 });
    expect(primaryAction(withLast, ['training'], [9])).toEqual({ kind: 'none' });
    expect(primaryAction({ ...base, data: { studies: 0, tabular_datasets: 0 } }, ['labeling'])).toEqual({ kind: 'import', to: '/data/imaging/import' });
    expect(primaryAction({ ...base, data: { studies: 0, tabular_datasets: 0 } }, ['project'])).toEqual({ kind: 'none' });
    expect(primaryAction(null, [...all])).toEqual({ kind: 'none' });
    expect(runStatusText({ status: 'queued', queue_position: 2 })[0]).toBe('排隊第 2 位');
  });
});
