import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { applyStoredTheme, readTheme, saveTheme, THEME_STORAGE_KEY } from '../../src/pages/global/theme';
import { progressSteps } from '../../src/pages/home/HomePage';
import type { ProjectOverview } from '../../src/pages/home/types';
import { renderApp } from '../render';

afterEach(() => {
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

describe('B32 介面主題', () => {
  it('儲存後套用到 html，跟隨系統時移除 data-theme', () => {
    expect(readTheme()).toBe('system');
    expect(saveTheme('dark')).toBe(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(readTheme()).toBe('dark');
    document.documentElement.removeAttribute('data-theme');
    applyStoredTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    saveTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('瀏覽器不允許儲存時仍套用，並回傳 false', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(saveTheme('light')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('個人設定頁選深色、按「儲存顯示偏好」', async () => {
    const { user } = await renderApp('/account', 'md01');
    expect(await screen.findByRole('heading', { level: 1, name: '個人帳號設定' })).toBeInTheDocument();
    const group = screen.getByRole('group', { name: '介面主題' });
    expect(within(group).getByRole('radio', { name: '跟隨系統' })).toBeChecked();
    await user.click(within(group).getByRole('radio', { name: '深色' }));
    await user.click(screen.getByRole('button', { name: '儲存顯示偏好' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(await screen.findByText('已儲存顯示偏好。')).toBeInTheDocument();
    expect(screen.getByText('目前專案角色')).toBeInTheDocument();
  });
});

describe('B31 無專案', () => {
  it('可以複製帳號、重新整理專案清單', async () => {
    const { user } = await renderApp('/', 'user01');
    // user-event 會換掉 navigator.clipboard，要在 renderApp 之後再放
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    expect(await screen.findByRole('heading', { name: '你尚未加入任何專案' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /複製帳號/ }));
    expect(writeText).toHaveBeenCalledWith('user01');
    expect(await screen.findByText('已複製帳號。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /重新整理專案清單/ }));
    expect(await screen.findByText(/已重新取得專案清單/)).toBeInTheDocument();
  });
});

describe('B30 選擇專案', () => {
  it('卡片有示意封面與身分；沒選之前不能進入', async () => {
    const { user } = await renderApp('/projects', 'admin01');
    const list = await screen.findByRole('list', { name: '全部專案' });
    const cards = within(list).getAllByRole('button');
    expect(cards[0].querySelector('img')?.getAttribute('src')).toMatch(/illustrations\/projects\/.+\.jpg$/);
    expect(cards[0]).toHaveTextContent('系統管理者');
    const enter = screen.getByRole('button', { name: /進入專案/ });
    if (!cards.some((c) => c.getAttribute('aria-pressed') === 'true')) expect(enter).toBeDisabled();
    await user.click(cards[1]);
    expect(cards[1]).toHaveAttribute('aria-pressed', 'true');
    expect(enter).toBeEnabled();
  });
});

describe('A01 專案首頁步驟條', () => {
  const base: ProjectOverview = { project: { id: 1, name: 'P' }, me: { role: null, permissions: [] } };
  it('目前步驟＝第一個還沒完成的', () => {
    const lab = { pending: 28, confirmed: 92, total_studies: 120, last: null };
    const r = progressSteps({ ...base, data: { studies: 120, tabular_datasets: 0 }, labeling: lab, models: [] });
    expect(r.current).toBe(1);
    expect(r.steps.map((s) => s.description)).toEqual(['120 筆影像', '進行中・還有 28 筆', '待產生']);
    const done = progressSteps({
      ...base,
      data: { studies: 3, tabular_datasets: 1 },
      labeling: { ...lab, pending: 0, confirmed: 3 },
      models: [{ run_id: 1, name: 'm', task: 'x', metric_name: null, metric_value: null, finished_at: null }],
    });
    expect(done.current).toBe(3);
    expect(done.steps[0].description).toBe('3 筆影像、1 份表格');
  });

  it('md01 首頁有進度條、步驟條與最近處理表', async () => {
    await renderApp('/', 'md01');
    expect(await screen.findByRole('progressbar', { name: '已確認' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '專案進度' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '最近處理' })).toBeInTheDocument();
  });
});
