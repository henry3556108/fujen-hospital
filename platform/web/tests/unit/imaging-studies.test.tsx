import { describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { dateRange } from '../../src/pages/imaging/StudiesPage';
import { parseAccessions } from '../../src/pages/imaging/AllowlistPage';
import { renderData as renderApp } from './imaging-render';
import { bodyRows } from '../table';

const table = () => screen.findByRole('table', { name: '影像清單' });

async function rows(): Promise<string[][]> {
  return bodyRows(await table());
}

async function loaded(count: number) {
  await screen.findByText(new RegExp(`^共 ${count} 筆影像`));
}

describe('數據管理入口', () => {
  it('/data opens the image list', async () => {
    await renderApp('/data', 'vw01');
    expect(await screen.findByRole('heading', { level: 2, name: '影像清單' })).toBeInTheDocument();
  });
});

describe('研究列表', () => {
  it('lists the studies of the current project with counts', async () => {
    await renderApp('/data/imaging', 'vw01');
    await loaded(6);
    const r = await rows();
    expect(r).toHaveLength(6);
    // 影像編號（含縮圖）、Study Date、Modality、Study Description、Series Description、病歷號、性別、序列數、影像數
    expect(r[0].slice(0, 9)).toEqual([
      'ACC0011', '2024-01-05', 'CT', 'CT CHEST WO CONTRAST', 'AXIAL 5MM SOFT TISSUE', 'PAT0011', '女', '1', '4',
    ]);
  });

  it('another project has no studies (project isolation)', async () => {
    const { user } = await renderApp('/data/imaging', 'admin01');
    await loaded(6);
    await user.selectOptions(screen.getByLabelText('目前專案'), 'P2-tabular');
    await loaded(0);
    expect(screen.getByText(/這個專案還沒有影像/)).toBeInTheDocument();
  });

  const cases: [string, (u: ReturnType<typeof import('@testing-library/user-event').default.setup>) => Promise<void>, string, (r: string[]) => boolean, number][] = [
    ['Modality', async (u) => u.selectOptions(screen.getByLabelText('Modality'), 'MR'), 'modality=MR', (r) => r[2] === 'MR', 2],
    ['性別', async (u) => u.selectOptions(screen.getByLabelText("Patient's Sex"), 'F'), 'patient_sex=F', (r) => r[6] === '女', 3],
    ['Study Description', async (u) => u.type(screen.getByLabelText(/^Study Description/), 'chest'), 'study_description=chest', (r) => /CHEST/.test(r[3]), 3],
    ['Series Description', async (u) => u.type(screen.getByLabelText(/^Series Description/), 'lung'), 'series_description=lung', (r) => /LUNG/.test(r[4]), 2],
    [
      'Study Date',
      async (u) => {
        await u.type(screen.getByLabelText('Study Date 起'), '2024-03-01');
        await u.type(screen.getByLabelText('Study Date 迄'), '2024-05-31');
      },
      'study_date=20240301-20240531',
      (r) => r[1] >= '2024-03-01' && r[1] <= '2024-05-31',
      3,
    ],
  ];

  it.each(cases)('TC-B01-09 filter by %s sends the query and every row matches', async (_name, act, query, matches, count) => {
    const seen: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/imaging/studies')) seen.push(decodeURIComponent(new URL(request.url).search));
    });
    const { user } = await renderApp('/data/imaging', 'vw01');
    await loaded(6);
    await act(user);
    await user.click(screen.getByRole('button', { name: '套用篩選' }));
    await loaded(count);
    expect(screen.getByText(/^共 \d+ 筆影像/)).toHaveTextContent('已套用 1 個篩選條件');
    const r = await rows();
    expect(r).toHaveLength(count);
    expect(r.filter((x) => !matches(x))).toEqual([]);
    expect(seen.at(-1)).toBe(`?${query}&limit=50`);
    server.events.removeAllListeners();
  });

  it('filters combine, survive a reload through the URL, and can be cleared', async () => {
    const first = await renderApp('/data/imaging?modality=CT&patient_sex=M', 'vw01');
    await loaded(2);
    expect(screen.getByLabelText('Modality')).toHaveValue('CT');
    expect(screen.getByLabelText("Patient's Sex")).toHaveValue('M');
    expect((await rows()).map((r) => r[0])).toEqual(['ACC0012', 'ACC0015']);
    await first.user.click(screen.getByRole('button', { name: '清除篩選' }));
    await loaded(6);
    expect(screen.getByLabelText('Modality')).toHaveValue('');
  });

  it('a filter with no match says so', async () => {
    await renderApp('/data/imaging?study_description=nothing-like-this', 'vw01');
    await loaded(0);
    expect(screen.getByText('沒有符合篩選條件的影像')).toBeInTheDocument();
  });

  it('422 from the API is shown', async () => {
    server.use(
      http.get('*/api/projects/:pid/imaging/studies', () =>
        HttpResponse.json({ detail: 'study_date 格式需為 YYYYMMDD 或 YYYYMMDD-YYYYMMDD' }, { status: 422 }),
      ),
    );
    await renderApp('/data/imaging?study_date=abc', 'vw01');
    expect(await screen.findByRole('alert')).toHaveTextContent('study_date 格式需為');
  });

  it('dateRange builds the API value', () => {
    expect(dateRange('', '')).toBe('');
    expect(dateRange('2024-01-05', '2024-01-05')).toBe('20240105');
    expect(dateRange('2024-01-05', '')).toBe('20240105-');
    expect(dateRange('', '2024-02-01')).toBe('-20240201');
    expect(dateRange('2024-01-05', '2024-02-01')).toBe('20240105-20240201');
  });
});

describe('研究列表分頁', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      study_instance_uid: `1.2.3.${i + 1}`,
      accession_number: `ACC${String(i + 1).padStart(4, '0')}`,
      patient_id: `PAT${i + 1}`,
      patient_sex: 'F',
      study_date: '20240105',
      study_description: 'CT CHEST',
      modalities: ['CT'],
      series: [],
      instances: 1,
    }));

  function pagedApi(total: number, seen: string[]) {
    const all = many(total);
    server.use(
      http.get('*/api/projects/:pid/imaging/studies', ({ request }) => {
        const q = new URL(request.url).searchParams;
        seen.push(decodeURIComponent(new URL(request.url).search));
        const limit = Number(q.get('limit'));
        const offset = Number(q.get('offset') ?? 0);
        return HttpResponse.json({ items: all.slice(offset, offset + limit), total, offset, limit });
      }),
    );
  }

  it('shows 50 studies per page and moves between pages', async () => {
    const seen: string[] = [];
    pagedApi(120, seen);
    const { user } = await renderApp('/data/imaging', 'vw01');
    await screen.findByText('共 120 筆影像，第 1–50 筆');
    expect(await rows()).toHaveLength(50);
    expect(seen.at(-1)).toBe('?limit=50');
    expect(screen.getByRole('button', { name: '上一頁' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '下一頁' }));
    await screen.findByText('共 120 筆影像，第 51–100 筆');
    expect(seen.at(-1)).toBe('?limit=50&offset=50');
    expect((await rows())[0][0]).toBe('ACC0051');

    await user.click(screen.getByRole('button', { name: '下一頁' }));
    await screen.findByText('共 120 筆影像，第 101–120 筆');
    expect(await rows()).toHaveLength(20);
    expect(screen.getByRole('button', { name: '下一頁' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '上一頁' }));
    await screen.findByText('共 120 筆影像，第 51–100 筆');
  });

  it('the page is in the URL (survives a reload) and a new filter starts again at page 1', async () => {
    const seen: string[] = [];
    pagedApi(120, seen);
    const { user } = await renderApp('/data/imaging?modality=CT&page=3', 'vw01');
    await screen.findByText('共 120 筆影像（已套用 1 個篩選條件），第 101–120 筆');
    expect(seen.at(-1)).toBe('?modality=CT&limit=50&offset=100');
    await user.selectOptions(screen.getByLabelText("Patient's Sex"), 'F');
    await user.click(screen.getByRole('button', { name: '套用篩選' }));
    await screen.findByText('共 120 筆影像（已套用 2 個篩選條件），第 1–50 筆');
    expect(seen.at(-1)).toBe('?modality=CT&patient_sex=F&limit=50');
  });

  it('a page past the end falls back to the last page', async () => {
    const seen: string[] = [];
    pagedApi(60, seen);
    await renderApp('/data/imaging?page=9', 'vw01');
    await screen.findByText('共 60 筆影像，第 51–60 筆');
    expect(seen.at(-1)).toBe('?limit=50&offset=50');
  });
});

describe('研究明細', () => {
  it('opens from the list and shows series', async () => {
    const { user } = await renderApp('/data/imaging', 'vw01');
    await loaded(6);
    await user.click(screen.getByRole('link', { name: '預覽 ACC0013' }));
    expect(await screen.findByRole('heading', { level: 2, name: '研究明細' })).toBeInTheDocument();
    const info = await screen.findByRole('region', { name: '研究資訊' });
    expect(info).toHaveTextContent('MR BRAIN WWO CONTRAST');
    expect(info).toHaveTextContent('2024-03-03');
    expect(info).toHaveTextContent('/dicomweb/projects/1/studies/1.2.826.0.1.3680043.10.9999.88.1.13');
    const series = screen.getByRole('table', { name: '序列列表' });
    expect(within(series).getByRole('row', { name: /AX T1/ })).toHaveTextContent('5');
  });

  it('404 for a study outside the project', async () => {
    await renderApp('/data/imaging/studies/1.2.3', 'vw01');
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到研究，或不在本專案的 Accession Number 清單內');
  });
});

describe('Accession Number 清單', () => {
  it('parseAccessions splits on newlines, commas and spaces and removes duplicates', () => {
    expect(parseAccessions(' ACC0011\nACC0012, ACC0011  ACC0013，ACC0014\n\n')).toEqual(['ACC0011', 'ACC0012', 'ACC0013', 'ACC0014']);
    expect(parseAccessions('  \n ')).toEqual([]);
  });

  it('TC-B01-08 admin sets the list (admin editor); studies outside it disappear from the list and by URL', async () => {
    const { user } = await renderApp('/admin/allowlist', 'admin01');
    expect(await screen.findByText(/未設定清單/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: '設定 Accession Number 清單' });
    await user.type(within(form).getByLabelText(/^Accession Number/), 'ACC0011\nACC0013');
    await user.click(within(form).getByRole('checkbox', { name: /已確認變更範圍/ }));
    {
      // Accession Number 清單儲存前要勾「已確認變更範圍」（F7）
      const ok = within(form).queryByRole('checkbox', { name: /已確認變更範圍/ });
      if (ok && !(ok as HTMLInputElement).checked) await user.click(ok);
    }
    await user.click(within(form).getByRole('button', { name: '儲存清單' }));
    expect(await screen.findByText('已儲存 Accession Number 清單，共 2 筆')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '清單內的 Accession Number' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      'ACC0011',
      'ACC0013',
    ]);

    // 研究區只讀：同一份清單也顯示在 /data/imaging/allowlist
    cleanup();
    await renderApp('/data/imaging/allowlist', 'pi01');
    expect(await screen.findByText('共 2 筆，只顯示清單內的影像。')).toBeInTheDocument();
    cleanup();
    await renderApp('/data/imaging', 'pi01');
    await loaded(2);
    expect((await rows()).map((r) => r[0])).toEqual(['ACC0011', 'ACC0013']);
  });

  it('TC-B01-08 after the list is set, a study outside it is 404 by direct URL', async () => {
    const admin = await renderApp('/admin/allowlist', 'admin01');
    const form = await screen.findByRole('form', { name: '設定 Accession Number 清單' });
    await admin.user.type(within(form).getByLabelText(/^Accession Number/), 'ACC0011');
    await admin.user.click(within(form).getByRole('checkbox', { name: /已確認變更範圍/ }));
    {
      // Accession Number 清單儲存前要勾「已確認變更範圍」（F7）
      const ok = within(form).queryByRole('checkbox', { name: /已確認變更範圍/ });
      if (ok && !(ok as HTMLInputElement).checked) await admin.user.click(ok);
    }
    await admin.user.click(within(form).getByRole('button', { name: '儲存清單' }));
    await screen.findByText('已儲存 Accession Number 清單，共 1 筆');
    admin.unmount();
    await renderApp('/data/imaging/studies/1.2.826.0.1.3680043.10.9999.88.1.12', 'pi01');
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到研究');
  });

  it('invalid accession is rejected with 422', async () => {
    const { user } = await renderApp('/admin/allowlist', 'admin01');
    const form = await screen.findByRole('form', { name: '設定 Accession Number 清單' });
    await user.type(within(form).getByLabelText(/^Accession Number/), 'ACC*');
    await user.click(within(form).getByRole('checkbox', { name: /已確認變更範圍/ }));
    {
      // Accession Number 清單儲存前要勾「已確認變更範圍」（F7）
      const ok = within(form).queryByRole('checkbox', { name: /已確認變更範圍/ });
      if (ok && !(ok as HTMLInputElement).checked) await user.click(ok);
    }
    await user.click(within(form).getByRole('button', { name: '儲存清單' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Accession 格式錯誤：ACC*');
  });

  it('the research area shows the list read-only, even for admin', async () => {
    await renderApp('/data/imaging/allowlist', 'admin01');
    expect(await screen.findByRole('link', { name: '專案設定' })).toHaveAttribute('href', '/admin/projects/1');
    cleanup();
    await renderApp('/data/imaging/allowlist', 'pi01');
    expect(await screen.findByText('清單由系統管理者設定，需要調整請聯絡系統管理者。')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '設定 Accession Number 清單' })).toBeNull();
    await waitFor(() => expect(screen.getByText(/未設定清單/)).toBeInTheDocument());
  });
});

describe('影像清單（改版）', () => {
  it('each row links to preview and to the labeling workbench; 匯入資料 goes to import', async () => {
    await renderApp('/data/imaging', 'ra01');
    await loaded(6);
    expect(screen.getByRole('link', { name: '開始標註 ACC0011' })).toHaveAttribute(
      'href',
      '/labeling/studies/1.2.826.0.1.3680043.10.9999.88.1.11',
    );
    expect(screen.getByRole('link', { name: '預覽 ACC0011' })).toHaveAttribute('href', '/data/imaging/studies/1.2.826.0.1.3680043.10.9999.88.1.11');
    expect(screen.getByRole('link', { name: '匯入資料' })).toHaveAttribute('href', '/data/imaging/import');
    // 標註狀態欄
    expect(screen.getByRole('columnheader', { name: '標註狀態' })).toBeInTheDocument();
  });

  it('a viewer has no 開始標註 / 匯入資料 / 儲存資料範圍', async () => {
    await renderApp('/data/imaging', 'vw01');
    await loaded(6);
    expect(screen.queryByRole('link', { name: /^開始標註/ })).toBeNull();
    expect(screen.queryByRole('link', { name: '匯入資料' })).toBeNull();
    expect(screen.queryByRole('button', { name: '儲存資料範圍' })).toBeNull();
  });

  it('saves the current filters as a data scope and selecting it sends scope_id', async () => {
    const seen: string[] = [];
    const posted: unknown[] = [];
    server.events.on('request:start', async ({ request }) => {
      if (request.url.includes('/imaging/studies')) seen.push(decodeURIComponent(new URL(request.url).search));
      if (request.method === 'POST' && request.url.endsWith('/imaging/scopes')) posted.push(await request.clone().json());
    });
    const { user } = await renderApp('/data/imaging?modality=CT', 'ra01');
    await loaded(4);
    await user.click(screen.getByRole('button', { name: '儲存資料範圍' }));
    const form = screen.getByRole('form', { name: '儲存資料範圍' });
    await user.type(within(form).getByLabelText('資料範圍名稱'), '胸部 CT');
    await user.click(within(form).getByRole('button', { name: '儲存' }));
    expect(await screen.findByText(/已儲存資料範圍「胸部 CT」，共 4 筆影像/)).toBeInTheDocument();
    expect(posted).toEqual([{ name: '胸部 CT', filters: { modality: 'CT' } }]);
    await waitFor(() => expect(seen.at(-1)).toBe('?scope_id=1&limit=50'));
    await loaded(4);
    expect(screen.getByLabelText('資料範圍')).toHaveValue('1');
    // 範圍內再篩選
    await user.selectOptions(screen.getByLabelText("Patient's Sex"), 'M');
    await user.click(screen.getByRole('button', { name: '套用篩選' }));
    await loaded(2);
    expect(seen.at(-1)).toBe('?patient_sex=M&scope_id=1&limit=50');
    // 改回全部影像
    await user.selectOptions(screen.getByLabelText('資料範圍'), '');
    await loaded(6);
    server.events.removeAllListeners();
  });
});

describe('資料範圍 mock API', () => {
  it('CRUD and study_count follow the filters', async () => {
    const { mockFetch } = await import('./imaging-mockfetch');
    const created = await mockFetch('POST', '/api/projects/1/imaging/scopes', 'ra01', { name: 'MR', filters: { modality: 'MR', bogus: 'x' } });
    expect(created.status).toBe(201);
    const scope = await created.json();
    expect(scope).toMatchObject({ name: 'MR', filters: { modality: 'MR' }, study_count: 2, created_by: 'ra01' });
    expect((await mockFetch('POST', '/api/projects/1/imaging/scopes', 'vw01', { name: 'x', filters: {} })).status).toBe(403);
    const put = await mockFetch('PUT', `/api/projects/1/imaging/scopes/${scope.id}`, 'ra01', { filters: { modality: 'CT' } });
    expect((await put.json()).study_count).toBe(4);
    const list = await (await mockFetch('GET', '/api/projects/1/imaging/scopes', 'vw01')).json();
    expect(list.map((x: { name: string }) => x.name)).toEqual(['MR']);
    const studies = await (await mockFetch('GET', `/api/projects/1/imaging/studies?scope_id=${scope.id}&limit=50`, 'vw01')).json();
    expect(studies.total).toBe(4);
    expect((await mockFetch('DELETE', `/api/projects/1/imaging/scopes/${scope.id}`, 'ra01')).status).toBe(204);
    expect((await mockFetch('GET', `/api/projects/1/imaging/studies?scope_id=${scope.id}`, 'vw01')).status).toBe(404);
  });
});
