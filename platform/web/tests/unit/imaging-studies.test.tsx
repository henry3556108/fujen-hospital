import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { dateRange } from '../../src/pages/imaging/StudiesPage';
import { parseAccessions } from '../../src/pages/imaging/AllowlistPage';
import { renderApp } from '../render';
import { bodyRows } from '../table';

const table = () => screen.findByRole('table', { name: '研究列表' });

async function rows(): Promise<string[][]> {
  return bodyRows(await table());
}

async function loaded(count: number) {
  await screen.findByText(new RegExp(`^共 ${count} 個研究`));
}

describe('數據管理入口', () => {
  it('opens on a choice between CSV tables and medical images, with both data tabs', async () => {
    const { user } = await renderApp('/data', 'vw01');
    expect(await screen.findByRole('heading', { level: 1, name: '數據管理' })).toBeInTheDocument();
    const kinds = await screen.findByRole('list', { name: '資料種類' });
    const tabs = screen.getByRole('navigation', { name: '數據管理分頁' });
    expect(within(tabs).getByRole('link', { name: '結構式資料（CSV 表格）' })).toBeInTheDocument();
    await user.click(within(kinds).getByRole('link', { name: /^醫療影像/ }));
    expect(await screen.findByRole('heading', { level: 2, name: '研究列表' })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: '醫療影像' })).toHaveAttribute('aria-current', 'page');
  });

  it('TC-A02-04 a user outside every project cannot open data pages by URL', async () => {
    await renderApp('/data/imaging', 'user01');
    expect(await screen.findByRole('heading', { name: '無法存取此功能' })).toBeInTheDocument();
  });
});

describe('研究列表', () => {
  it('lists the studies of the current project with counts', async () => {
    await renderApp('/data/imaging', 'vw01');
    await loaded(6);
    const r = await rows();
    expect(r).toHaveLength(6);
    // Study Date, Accession, Patient ID, Sex, Modality, Study Description, Series Description, 序列, 影像
    expect(r[0].slice(0, 9)).toEqual([
      '2024-01-05', 'ACC0011', 'PAT0011', 'F', 'CT', 'CT CHEST WO CONTRAST', 'AXIAL 5MM SOFT TISSUE', '1', '4',
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
    ['Modality', async (u) => u.selectOptions(screen.getByLabelText('Modality'), 'MR'), 'modality=MR', (r) => r[4] === 'MR', 2],
    ["Patient's Sex", async (u) => u.selectOptions(screen.getByLabelText("Patient's Sex"), 'F'), 'patient_sex=F', (r) => r[3] === 'F', 3],
    ['Study Description', async (u) => u.type(screen.getByLabelText(/^Study Description/), 'chest'), 'study_description=chest', (r) => /CHEST/.test(r[5]), 3],
    ['Series Description', async (u) => u.type(screen.getByLabelText(/^Series Description/), 'lung'), 'series_description=lung', (r) => /LUNG/.test(r[6]), 2],
    [
      'Study Date',
      async (u) => {
        await u.type(screen.getByLabelText('Study Date 起'), '2024-03-01');
        await u.type(screen.getByLabelText('Study Date 迄'), '2024-05-31');
      },
      'study_date=20240301-20240531',
      (r) => r[0] >= '2024-03-01' && r[0] <= '2024-05-31',
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
    expect(screen.getByRole('status')).toHaveTextContent('已套用 1 個篩選條件');
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
    expect((await rows()).map((r) => r[1])).toEqual(['ACC0012', 'ACC0015']);
    await first.user.click(screen.getByRole('button', { name: '清除篩選' }));
    await loaded(6);
    expect(screen.getByLabelText('Modality')).toHaveValue('');
  });

  it('a filter with no match says so', async () => {
    await renderApp('/data/imaging?study_description=nothing-like-this', 'vw01');
    await loaded(0);
    expect(screen.getByText('沒有符合篩選條件的研究')).toBeInTheDocument();
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
    await screen.findByText('共 120 個研究，第 1–50 個');
    expect(await rows()).toHaveLength(50);
    expect(seen.at(-1)).toBe('?limit=50');
    expect(screen.getByRole('button', { name: '上一頁' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '下一頁' }));
    await screen.findByText('共 120 個研究，第 51–100 個');
    expect(seen.at(-1)).toBe('?limit=50&offset=50');
    expect((await rows())[0][1]).toBe('ACC0051');

    await user.click(screen.getByRole('button', { name: '下一頁' }));
    await screen.findByText('共 120 個研究，第 101–120 個');
    expect(await rows()).toHaveLength(20);
    expect(screen.getByRole('button', { name: '下一頁' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '上一頁' }));
    await screen.findByText('共 120 個研究，第 51–100 個');
  });

  it('the page is in the URL (survives a reload) and a new filter starts again at page 1', async () => {
    const seen: string[] = [];
    pagedApi(120, seen);
    const { user } = await renderApp('/data/imaging?modality=CT&page=3', 'vw01');
    await screen.findByText('共 120 個研究（已套用 1 個篩選條件），第 101–120 個');
    expect(seen.at(-1)).toBe('?modality=CT&limit=50&offset=100');
    await user.selectOptions(screen.getByLabelText("Patient's Sex"), 'F');
    await user.click(screen.getByRole('button', { name: '套用篩選' }));
    await screen.findByText('共 120 個研究（已套用 2 個篩選條件），第 1–50 個');
    expect(seen.at(-1)).toBe('?modality=CT&patient_sex=F&limit=50');
  });

  it('a page past the end falls back to the last page', async () => {
    const seen: string[] = [];
    pagedApi(60, seen);
    await renderApp('/data/imaging?page=9', 'vw01');
    await screen.findByText('共 60 個研究，第 51–60 個');
    expect(seen.at(-1)).toBe('?limit=50&offset=50');
  });
});

describe('研究明細', () => {
  it('opens from the list and shows series', async () => {
    const { user } = await renderApp('/data/imaging', 'vw01');
    await loaded(6);
    await user.click(screen.getByRole('link', { name: '檢視研究 ACC0013' }));
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
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到研究，或不在本專案的 Accession 清單內');
  });
});

describe('Accession 清單', () => {
  it('parseAccessions splits on newlines, commas and spaces and removes duplicates', () => {
    expect(parseAccessions(' ACC0011\nACC0012, ACC0011  ACC0013，ACC0014\n\n')).toEqual(['ACC0011', 'ACC0012', 'ACC0013', 'ACC0014']);
    expect(parseAccessions('  \n ')).toEqual([]);
  });

  it('TC-B01-08 admin sets the list; studies outside it disappear from the list and by URL', async () => {
    const { user } = await renderApp('/data/imaging/allowlist', 'admin01');
    expect(await screen.findByText(/未設定清單/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: '設定 Accession 清單' });
    await user.type(within(form).getByLabelText(/^Accession Number/), 'ACC0011\nACC0013');
    await user.click(within(form).getByRole('button', { name: '儲存清單' }));
    expect(await screen.findByText('已儲存 Accession 清單，共 2 筆')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '清單內的 Accession Number' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      'ACC0011',
      'ACC0013',
    ]);

    await user.click(within(screen.getByRole('navigation', { name: '醫療影像分頁' })).getByRole('link', { name: '研究列表' }));
    await loaded(2);
    expect((await rows()).map((r) => r[1])).toEqual(['ACC0011', 'ACC0013']);
  });

  it('TC-B01-08 after the list is set, a study outside it is 404 by direct URL', async () => {
    const admin = await renderApp('/data/imaging/allowlist', 'admin01');
    const form = await screen.findByRole('form', { name: '設定 Accession 清單' });
    await admin.user.type(within(form).getByLabelText(/^Accession Number/), 'ACC0011');
    await admin.user.click(within(form).getByRole('button', { name: '儲存清單' }));
    await screen.findByText('已儲存 Accession 清單，共 1 筆');
    admin.unmount();
    await renderApp('/data/imaging/studies/1.2.826.0.1.3680043.10.9999.88.1.12', 'pi01');
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到研究');
  });

  it('invalid accession is rejected with 422', async () => {
    const { user } = await renderApp('/data/imaging/allowlist', 'admin01');
    const form = await screen.findByRole('form', { name: '設定 Accession 清單' });
    await user.type(within(form).getByLabelText(/^Accession Number/), 'ACC*');
    await user.click(within(form).getByRole('button', { name: '儲存清單' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Accession 格式錯誤：ACC*');
  });

  it('non-admin sees the list read-only', async () => {
    await renderApp('/data/imaging/allowlist', 'pi01');
    expect(await screen.findByText('只有 Admin 可以設定 Accession 清單。')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '設定 Accession 清單' })).toBeNull();
    await waitFor(() => expect(screen.getByText(/未設定清單/)).toBeInTheDocument());
  });
});
