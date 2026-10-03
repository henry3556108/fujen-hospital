import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { ENTRIES } from '../../src/access/entries';
import { renderApp } from '../render';

async function navLabels() {
  const nav = await screen.findByRole('navigation', { name: '功能選單' });
  await within(nav).findAllByRole('link');
  return within(nav)
    .getAllByRole('link')
    .map((a) => a.textContent?.trim());
}

describe('login and session', () => {
  it('unauthenticated visitor is sent to the login page', async () => {
    await renderApp('/', null);
    expect(await screen.findByRole('heading', { name: '登入' })).toBeInTheDocument();
  });

  it('test-mode login picks a seed account and lands on the shell', async () => {
    const { user } = await renderApp('/', null);
    await user.selectOptions(await screen.findByLabelText('測試帳號'), 'vw01');
    await user.click(screen.getByRole('button', { name: '登入' }));
    expect(await screen.findByRole('button', { name: '登出' })).toBeInTheDocument();
    expect(screen.getByText('vw01')).toBeInTheDocument();
    expect(await navLabels()).toEqual(['數據管理', 'AI 模型部署', '推論服務管理']);
  });

  it('401 from the API returns to the login page with a reason', async () => {
    server.use(http.get('*/api/me', () => HttpResponse.json({ detail: '登入已失效，請重新登入' }, { status: 401 })));
    const { auth } = await renderApp('/', 'md01');
    expect(await screen.findByRole('heading', { name: '登入' })).toBeInTheDocument();
    expect(screen.getByText(/登入已失效/)).toBeInTheDocument();
    expect(await auth.getUser()).toBeNull();
  });

  it('logout returns to the login page', async () => {
    const { user } = await renderApp('/', 'md01');
    await user.click(await screen.findByRole('button', { name: '登出' }));
    expect(await screen.findByRole('heading', { name: '登入' })).toBeInTheDocument();
  });
});

describe('app shell', () => {
  it('has landmarks and a skip link', async () => {
    await renderApp('/', 'admin01');
    await screen.findByRole('navigation', { name: '功能選單' });
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '跳到主要內容' })).toHaveAttribute('href', '#main');
  });

  it('TC-A02-02 vw01 sees only 數據管理, AI 模型部署, 推論服務管理', async () => {
    await renderApp('/', 'vw01');
    expect(await navLabels()).toEqual(['數據管理', 'AI 模型部署', '推論服務管理']);
  });

  it('TC-A02-02 md01 sees project + labeling + prediction entries', async () => {
    await renderApp('/', 'md01');
    expect(await navLabels()).toEqual(['數據管理', '影像標註', '自動影像分類標註', 'AI 模型部署', '推論服務管理']);
  });

  it('TC-A02-02 ca01 sees project + training + coding + prediction entries', async () => {
    await renderApp('/', 'ca01');
    expect(await navLabels()).toEqual(['數據管理', '建模管理', 'AI 模型部署', '推論服務管理', 'LLM No-code 開發']);
  });

  it('TC-A02-02 admin01 sees all 8 entries', async () => {
    await renderApp('/', 'admin01');
    expect(await navLabels()).toEqual(ENTRIES.map((e) => e.label));
  });

  it('TC-A02-01 admin01 clicks every entry and each page opens', async () => {
    const { user } = await renderApp('/', 'admin01');
    const nav = await screen.findByRole('navigation', { name: '功能選單' });
    for (const entry of ENTRIES) {
      await user.click(within(nav).getByRole('link', { name: entry.label }));
      const main = screen.getByRole('main');
      expect(await within(main).findByRole('heading', { level: 1, name: new RegExp(entry.label) })).toBeInTheDocument();
      if (entry.placeholder) {
        expect(within(main).getByText('此功能將於 M2 提供')).toBeInTheDocument();
        expect(within(main).getByText(`模組代碼：${entry.moduleCode}`)).toBeInTheDocument();
      }
      expect(within(nav).getByRole('link', { name: entry.label })).toHaveAttribute('aria-current', 'page');
    }
  });

  it('TC-A02-04 / TC-A03-05 vw01 typing a hidden entry URL sees an access-denied page with a text reason', async () => {
    await renderApp('/training', 'vw01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
    expect(screen.getByText(/沒有 Training 權限/)).toBeInTheDocument();
  });

  it('TC-A03-05 vw01 direct URL to labeling and LLM is denied too', async () => {
    for (const path of ['/labeling', '/auto-labeling', '/llm']) {
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

  it('project switcher re-evaluates entries against the selected project', async () => {
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
    expect(await navLabels()).toEqual(['數據管理', 'AI 模型部署', '推論服務管理']);
    await user.selectOptions(screen.getByLabelText('目前專案'), 'P3-llm');
    await waitFor(async () =>
      expect(await navLabels()).toEqual(['數據管理', '建模管理', 'AI 模型部署', '推論服務管理', 'LLM No-code 開發']),
    );
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
    // 另一個視窗由 Admin 新增專案並加入成員；不按 F5
    projects.push({ id: 4, name: 'P4-new', role: 'viewer', permissions: ['prediction', 'project'] });
    fireEvent.focus(window);
    await waitFor(() => expect(options()).toEqual(['P1-lung-ct', 'P4-new']));
    expect(screen.getByLabelText('目前專案')).toHaveValue('1'); // 目前的選擇不變
    projects.push({ id: 5, name: 'P5-newer', role: 'viewer', permissions: ['prediction', 'project'] });
    const before = calls;
    await user.click(screen.getByLabelText('目前專案'));
    await waitFor(() => expect(options()).toEqual(['P1-lung-ct', 'P4-new', 'P5-newer']));
    expect(calls).toBeGreaterThan(before);
    // 重新讀取不會讓頁面回到載入中
    expect(screen.getByRole('navigation', { name: '功能選單' })).toBeInTheDocument();
  });

  it('user without projects is told so and sees no entries', async () => {
    await renderApp('/', 'user01');
    expect(await screen.findByText('你尚未加入任何專案，請聯絡管理者將你加入專案。')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: '功能選單' });
    expect(within(nav).queryAllByRole('link')).toHaveLength(0);
  });

  it('unknown path shows a not-found page', async () => {
    await renderApp('/nope', 'admin01');
    expect(await screen.findByRole('heading', { name: '找不到頁面' })).toBeInTheDocument();
  });

  it('theme toggle switches data-theme on <html>', async () => {
    const { user } = await renderApp('/', 'admin01');
    const toggle = await screen.findByLabelText('色彩主題');
    await user.selectOptions(toggle, 'dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.selectOptions(toggle, 'light');
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.selectOptions(toggle, 'system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('建模管理 links to the project job list', async () => {
    const { user } = await renderApp('/training', 'pi01');
    await user.click(await screen.findByRole('link', { name: /專案工作/ }));
    expect(await screen.findByRole('heading', { level: 1, name: '專案工作' })).toBeInTheDocument();
  });
});
