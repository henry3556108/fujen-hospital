import '../upload-env';
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import { server } from '../../src/mocks/server';
import { renderApp } from '../render';

const VISIBLE_AFTER_HIDING = ['列', 'age', 'sex', 'sbp', 'dbp', 'glucose', 'diagnosis', 'time_to_event', 'event', 'study_accession'];
const headers = () => within(screen.getByRole('table', { name: '資料預覽' })).getAllByRole('columnheader').map((h) => h.textContent);

describe('TC-B04-02 欄位顯示設定存在伺服器', () => {
  it('another computer (no browser storage) sees the same hidden columns', async () => {
    const seen: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PUT' && request.url.endsWith('/column-view')) seen.push(await request.clone().json());
    });
    const first = await renderApp('/data/tabular/2/preview', 'vw01');
    await screen.findByRole('table', { name: '資料預覽' });
    for (const c of ['patient_id', 'bmi', 'smoker']) await first.user.click(screen.getByRole('checkbox', { name: c }));
    await waitFor(() => expect(headers()).toEqual(VISIBLE_AFTER_HIDING));
    await waitFor(() => expect(seen.at(-1)).toEqual({ hidden: ['patient_id', 'bmi', 'smoker'] }));
    first.unmount();
    server.events.removeAllListeners();

    window.localStorage.clear(); // 換一台電腦：瀏覽器沒有任何狀態
    await renderApp('/data/tabular/2/preview', 'vw01');
    await waitFor(() => expect(headers()).toEqual(VISIBLE_AFTER_HIDING));
    for (const c of ['patient_id', 'bmi', 'smoker']) expect(screen.getByRole('checkbox', { name: c })).not.toBeChecked();
    expect(screen.getByText(/已隱藏 3 個：patient_id、bmi、smoker/)).toHaveTextContent('這個設定存在你的帳號');
  });

  it('moves a setting left in browser storage by the previous version to the server once', async () => {
    window.localStorage.setItem('ai-platform.tabular.hidden.vw01.1.2', JSON.stringify(['age', 'no_longer_a_column']));
    const puts: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PUT' && request.url.endsWith('/column-view')) puts.push(await request.clone().json());
    });
    const first = await renderApp('/data/tabular/2/preview', 'vw01');
    await screen.findByText(/已隱藏 1 個：age/);
    await waitFor(() => expect(puts).toEqual([{ hidden: ['age'] }]));
    expect(window.localStorage.getItem('ai-platform.tabular.hidden.vw01.1.2')).toBeNull();
    first.unmount();
    server.events.removeAllListeners();

    await renderApp('/data/tabular/2/preview', 'vw01');
    await screen.findByText(/已隱藏 1 個：age/);
  });

  it('a failed save is reported and the choice stays on screen', async () => {
    server.use(
      http.put('*/api/projects/:pid/tabular/datasets/:id/column-view', () =>
        HttpResponse.json({ detail: '資料集沒有這些欄位：x' }, { status: 422 }),
      ),
    );
    const { user } = await renderApp('/data/tabular/2/preview', 'vw01');
    await screen.findByRole('table', { name: '資料預覽' });
    await user.click(screen.getByRole('checkbox', { name: 'bmi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('資料集沒有這些欄位：x');
    expect(screen.getByRole('checkbox', { name: 'bmi' })).not.toBeChecked();
  });
});
