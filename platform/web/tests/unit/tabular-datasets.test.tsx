import '../upload-env';
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { fixtureFile, fixtureText } from '../fixtures';
import { renderApp } from '../render';
import { bodyRows, cellsOf } from '../table';

type User = Awaited<ReturnType<typeof renderApp>>['user'];
const list = () => screen.findByRole('table', { name: '資料集列表' });

/** 選檔、等自動判斷完成、填名稱；schema 不是 undefined 時貼到「進階」的 JSON 欄位。 */
async function fill(user: User, csv: string, name: string, schema?: string) {
  const form = await screen.findByRole('form', { name: '上傳 CSV' });
  await user.upload(within(form).getByLabelText(/^CSV 檔案/), fixtureFile(`tabular/${csv}`));
  await within(form).findByRole('table', { name: '欄位確認' });
  const n = within(form).getByLabelText('資料集名稱');
  await user.clear(n);
  if (name) await user.type(n, name);
  if (schema !== undefined) {
    const details = within(form).getByText('進階：自行提供結構定義（JSON）').closest('details')!;
    if (!details.open) await user.click(within(form).getByText('進階：自行提供結構定義（JSON）'));
    const s = within(form).getByLabelText('結構定義（JSON）');
    await user.clear(s);
    if (schema) {
      s.focus();
      await user.paste(schema);
    }
  }
  return form;
}

async function upload(user: User, csv: string, name: string, schema: string | undefined = fixtureText('tabular/schema.json')) {
  const form = await fill(user, csv, name, schema);
  await user.click(within(form).getByRole('button', { name: '上傳並驗證' }));
  return form;
}

describe('資料集列表', () => {
  it('lists the datasets of the current project only', async () => {
    const { user } = await renderApp('/data/tabular', 'admin01');
    const table = await list();
    await within(table).findByRole('link', { name: 'lung-clinical' });
    expect(bodyRows(table).map((r) => r.slice(0, 5))).toEqual([['lung-clinical', 'cohort_01.csv', '100', '100', '0']]);
    await user.selectOptions(screen.getByLabelText('目前專案'), 'P2-tabular');
    await within(await list()).findByRole('link', { name: 'cohort_01' });
    expect(bodyRows(await list())).toHaveLength(1);
  });

  it('TC-B01-10 uploads a clean CSV: 100 rows accepted, the dataset appears in the list', async () => {
    const { user } = await renderApp('/data/tabular', 'vw01');
    await upload(user, 'cohort_01.csv', 'cohort-a');
    expect(await screen.findByText('已建立資料集「cohort-a」')).toBeInTheDocument();
    const result = screen.getByRole('region', { name: '「cohort-a」的上傳結果' });
    expect(result).toHaveTextContent('全部通過');
    expect(result).toHaveTextContent('共 100 列，通過 100 列，拒絕 0 列');
    const row = await within(await list()).findByRole('row', { name: /^cohort-a/ });
    expect(cellsOf(row).slice(0, 6)).toEqual(['cohort-a', 'cohort_01.csv', '100', '100', '0', 'vw01']);
  });

  it('TC-B01-10 bad.csv: every bad row is listed with column and reason; none is let through', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    await upload(user, 'bad.csv', 'bad');
    const result = await screen.findByRole('region', { name: '「bad」的上傳結果' });
    expect(result).toHaveTextContent('部分資料列被拒絕');
    expect(result).toHaveTextContent('共 30 列，通過 20 列，拒絕 10 列');
    const expected = JSON.parse(fixtureText('tabular/bad_rows.json')).rows as { row: number; column: string }[];
    const rows = bodyRows(within(result).getByRole('table', { name: '「bad」的上傳結果：被拒絕的資料列' }));
    expect(rows.map((r) => [Number(r[0]), Number(r[1]), r[2]])).toEqual(expected.map((r) => [r.row, r.row + 2, r.column]));
    expect(rows[2][3]).toBe('「12O」不是整數');
    expect(rows[3][3]).toBe('「unknown」不在允許值（M、F）之內');
    expect(cellsOf(within(await list()).getByRole('row', { name: /^bad/ })).slice(2, 5)).toEqual(['30', '20', '10']);
  });

  it('the validation report of an existing dataset can be reopened', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    await upload(user, 'bad.csv', 'bad');
    await screen.findByRole('region', { name: '「bad」的上傳結果' });
    await user.click(within(await list()).getByRole('button', { name: '驗證報告 bad' }));
    const report = await screen.findByRole('region', { name: '「bad」的驗證報告' });
    expect(bodyRows(within(report).getByRole('table'))).toHaveLength(10);
  });

  it('schema can be loaded from a .json file', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    const form = await screen.findByRole('form', { name: '上傳 CSV' });
    await user.upload(within(form).getByLabelText(/^載入結構定義檔/), fixtureFile('tabular/schema.json'));
    await waitFor(() => expect((within(form).getByLabelText('結構定義（JSON）') as HTMLTextAreaElement).value).toContain('"patient_id"'));
  });

  it('errors: no file, invalid schema JSON, missing columns', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    const form = await screen.findByRole('form', { name: '上傳 CSV' });
    await user.click(within(form).getByRole('button', { name: '上傳並驗證' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('請先選擇 CSV 檔案');

    await upload(user, 'cohort_01.csv', 'x', '{not json');
    await waitFor(() => expect(within(form).getByRole('alert')).toHaveTextContent('結構定義不是有效的 JSON'));

    await upload(user, 'cohort_01.csv', 'x', '{"columns":[{"name":"nope","type":"int","required":true}]}');
    await waitFor(() => expect(within(form).getAllByRole('alert')[0]).toHaveTextContent('缺少必要欄位：nope'));
    expect(bodyRows(await list())).toHaveLength(1);
  });

  it('deletes a dataset after confirmation', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    const table = await list();
    await user.click(await within(table).findByRole('button', { name: '刪除 lung-clinical' }));
    await user.click(within(screen.getByRole('dialog', { name: '刪除資料集' })).getByRole('button', { name: '確認刪除' }));
    expect(await screen.findByText('已刪除資料集「lung-clinical」')).toBeInTheDocument();
    expect(await screen.findByText('這個專案還沒有資料集')).toBeInTheDocument();
  });

  it('404 for a dataset of another project', async () => {
    await renderApp('/data/tabular/1', 'pi01'); // 資料集 1 屬於 P2-tabular
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到資料集 1');
  });
});

describe('預覽與欄位顯示／隱藏', () => {
  it('shows the first 50 rows with row numbers, and pages', async () => {
    const { user } = await renderApp('/data/tabular/2', 'vw01');
    expect(await screen.findByRole('heading', { level: 2, name: '資料集：lung-clinical' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: '資料預覽' });
    expect(screen.getByText('第 1–50 列，共 100 列')).toBeInTheDocument();
    const rows = bodyRows(table);
    expect(rows).toHaveLength(50);
    expect(rows[0]).toEqual(['0', 'P10001', '38', 'M', '23.1', '90', '50', '78.6', 'current', '0', '2,180', '0', '（空）']);
    await user.click(screen.getByRole('button', { name: '下一頁' }));
    await screen.findByText('第 51–100 列，共 100 列');
    expect(bodyRows(screen.getByRole('table', { name: '資料預覽' }))[0][0]).toBe('50');
    expect(screen.getByRole('button', { name: '下一頁' })).toBeDisabled();
  });

  it('TC-B04-02 hides 3 columns; after a reload the same 3 are still hidden', async () => {
    const first = await renderApp('/data/tabular/2', 'vw01');
    await screen.findByRole('table', { name: '資料預覽' });
    for (const c of ['patient_id', 'bmi', 'smoker']) await first.user.click(screen.getByRole('checkbox', { name: c }));
    await waitFor(() =>
      expect(within(screen.getByRole('table', { name: '資料預覽' })).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
        '列', 'age', 'sex', 'sbp', 'dbp', 'glucose', 'diagnosis', 'time_to_event', 'event', 'study_accession',
      ]),
    );
    expect(screen.getByText(/顯示 9 個欄位，已隱藏 3 個：patient_id、bmi、smoker/)).toBeInTheDocument();
    first.unmount();

    const again = await renderApp('/data/tabular/2', 'vw01');
    const table = await screen.findByRole('table', { name: '資料預覽' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      '列', 'age', 'sex', 'sbp', 'dbp', 'glucose', 'diagnosis', 'time_to_event', 'event', 'study_accession',
    ]);
    for (const c of ['patient_id', 'bmi', 'smoker']) expect(screen.getByRole('checkbox', { name: c })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'age' })).toBeChecked();
    expect(bodyRows(table)[0]).toEqual(['0', '38', 'M', '90', '50', '78.6', '0', '2,180', '0', '（空）']);

    await again.user.click(screen.getByRole('button', { name: '全部顯示' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: '資料預覽' })).getAllByRole('columnheader')).toHaveLength(13));
  });

  it('TC-B04-02 the hidden state is per account and per dataset', async () => {
    const first = await renderApp('/data/tabular/2', 'vw01');
    await screen.findByRole('table', { name: '資料預覽' });
    await first.user.click(screen.getByRole('checkbox', { name: 'age' }));
    await screen.findByText(/已隱藏 1 個：age/);
    first.unmount();
    await renderApp('/data/tabular/2', 'pi01');
    await screen.findByRole('table', { name: '資料預覽' });
    expect(screen.getByRole('checkbox', { name: 'age' })).toBeChecked();
  });

  it('hiding every column asks to show at least one', async () => {
    const { user } = await renderApp('/data/tabular/2', 'vw01');
    await screen.findByRole('table', { name: '資料預覽' });
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    expect(await screen.findByText('所有欄位都已隱藏，請至少勾選一個欄位。')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: '資料預覽' })).toBeNull();
  });
});

describe('描述統計與分布', () => {
  it('TC-B04-01 shows the statistics returned by the API', async () => {
    await renderApp('/data/tabular/2/describe', 'vw01');
    const table = await screen.findByRole('table', { name: '描述統計' });
    const row = (name: string) => cellsOf(within(table).getByRole('row', { name: new RegExp(`^${name} `) }));
    // 欄位, 類型, 筆數, 缺值, 相異值, 平均, 標準差, 最小, P25, 中位數, P75, 最大, 最常見值, 次數
    expect(row('age')).toEqual(['age', '整數', '100', '0', '51', '59.15', '19.7987', '25', '41.75', '61', '77', '89', '—', '—']);
    expect(row('glucose').slice(2, 4)).toEqual(['95', '5']);
    expect(row('sex')).toEqual(['sex', '類別', '100', '0', '2', '—', '—', '—', '—', '—', '—', '—', 'M', '51']);
    expect(screen.getByText('共 100 列、12 欄')).toBeInTheDocument();
    // 0／1 欄位顯示為是／否與比例；識別碼不顯示無意義的統計
    expect(row('diagnosis').slice(0, 7)).toEqual(['diagnosis', '是／否（0／1）', '100', '0', '2', expect.stringMatching(/% 為 1$/), '—']);
    expect(row('patient_id').slice(0, 2)).toEqual(['patient_id', '識別碼']);
    expect(row('patient_id')[12]).toBe('—');
    expect((screen.getByText(/^表頭說明/).closest('details') as HTMLDetailsElement).open).toBe(true);
  });

  it('draws a histogram for a numeric column and category counts for a categorical one', async () => {
    const { user } = await renderApp('/data/tabular/2/describe', 'vw01');
    const fig = await screen.findByRole('figure', { name: 'age 的分布' });
    expect(within(fig).getAllByRole('img', { name: /：\d+$/ })).toHaveLength(10);
    await user.selectOptions(screen.getByLabelText('欄位'), 'bmi');
    await user.selectOptions(await screen.findByLabelText('分組數'), '5');
    const bmi = await screen.findByRole('figure', { name: 'bmi 的分布' });
    await waitFor(() => expect(within(bmi).getAllByRole('img', { name: /：\d+$/ })).toHaveLength(5));
    expect(bodyRows(within(bmi).getByRole('table', { hidden: true })).map((r) => r[1])).toEqual(['15', '17', '35', '29', '4']);

    await user.selectOptions(screen.getByLabelText('欄位'), 'smoker');
    const cat = await screen.findByRole('figure', { name: 'smoker 的各類別筆數' });
    expect(bodyRows(within(cat).getByRole('table', { hidden: true })).map((r) => r[0]).sort()).toEqual(['current', 'former', 'never']);
    expect(screen.queryByLabelText('分組數')).toBeNull();
  });
});
