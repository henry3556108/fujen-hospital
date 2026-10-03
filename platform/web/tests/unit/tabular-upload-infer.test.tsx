import '../upload-env';
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { fixtureFile, fixtureText } from '../fixtures';
import { renderApp } from '../render';
import { bodyRows } from '../table';

type User = Awaited<ReturnType<typeof renderApp>>['user'];

async function choose(user: User, csv: string, name: string) {
  const form = await screen.findByRole('form', { name: '上傳 CSV' });
  await user.upload(within(form).getByLabelText(/^CSV 檔案/), fixtureFile(`tabular/${csv}`));
  const table = await within(form).findByRole('table', { name: '欄位確認' });
  await user.type(within(form).getByLabelText('資料集名稱'), name);
  return { form, table };
}

const precheck = () => screen.getByRole('region', { name: '預檢結果（尚未上傳）' });

describe('上傳免寫 JSON', () => {
  it('shows inferred column types in Chinese and a pre-check; upload uses the table', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    const { form, table } = await choose(user, 'cohort_01.csv', 'auto');
    expect(within(table).getByLabelText('age 的型態')).toHaveDisplayValue('整數');
    expect(within(table).getByLabelText('bmi 的型態')).toHaveDisplayValue('小數');
    // 0／1 欄位與資料頁同一個名稱（修正缺陷 4）；型態仍是整數
    // 選單仍是「整數」（不加寬表格），下方寫「（0／1，是／否）」，合起來與資料頁相同
    expect(within(table).getByLabelText('diagnosis 的型態')).toHaveDisplayValue('整數');
    expect(within(table).getByLabelText('diagnosis 的型態')).toHaveAccessibleDescription('（0／1，是／否）');
    expect(within(table).getByTestId('schema-binary-event')).toHaveTextContent('（0／1，是／否）');
    expect(within(table).queryByTestId('schema-binary-age')).toBeNull();
    expect(within(table).getByRole('row', { name: /^diagnosis/ })).toHaveTextContent('1＝是');
    expect(within(table).getByLabelText('sex 的型態')).toHaveDisplayValue('類別');
    expect(within(table).getByLabelText('sex 允許的值')).toHaveValue('F、M');
    expect(within(table).getByLabelText('patient_id 不可重複')).toBeChecked();
    expect(within(table).getByLabelText('glucose 必填')).not.toBeChecked();
    expect(within(table).getByLabelText('age 最大值')).toHaveValue(120);
    expect(precheck()).toHaveTextContent('共 100 列，通過 100 列，拒絕 0 列');
    // JSON 收在「進階」
    expect(within(form).getByText('進階：自行提供結構定義（JSON）').closest('details')).not.toHaveAttribute('open');

    await user.click(within(form).getByRole('button', { name: '上傳並驗證' }));
    const result = await screen.findByRole('region', { name: '「auto」的上傳結果' });
    expect(result).toHaveTextContent('全部通過');
    expect(result).toHaveTextContent('共 100 列，通過 100 列，拒絕 0 列');
  });

  it('TC-B01-10 bad.csv: the inferred table rejects 8 rows; ticking 必填 for sbp rejects exactly the 10 bad rows', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    const { form, table } = await choose(user, 'bad.csv', 'bad-auto');
    expect(precheck()).toHaveTextContent('共 30 列，通過 22 列，拒絕 8 列');
    expect(within(table).getByLabelText('diagnosis 的型態')).toHaveAccessibleDescription('（0／1，是／否）');
    expect(within(table).getByRole('row', { name: /^sbp/ })).toHaveTextContent('有 2 格空白或缺值');
    expect(within(table).getByRole('row', { name: /^sex/ })).toHaveTextContent('「unknown」出現次數很少');

    await user.click(within(table).getByLabelText('sbp 必填'));
    expect(screen.getByText(/欄位設定已修改/)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: '重新預檢' }));
    await waitFor(() => expect(precheck()).toHaveTextContent('共 30 列，通過 20 列，拒絕 10 列'));

    await user.click(within(form).getByRole('button', { name: '上傳並驗證' }));
    const result = await screen.findByRole('region', { name: '「bad-auto」的上傳結果' });
    const expected = JSON.parse(fixtureText('tabular/bad_rows.json')).rows as { row: number; column: string }[];
    const rows = bodyRows(within(result).getByRole('table'));
    expect(rows.map((r) => Number(r[0]))).toEqual(expected.map((r) => r.row + 1));   // 第幾列從 1 起算
  });

  it('changing a type changes the pre-check', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    const { form, table } = await choose(user, 'bad.csv', 'x');
    await user.selectOptions(within(table).getByLabelText('age 的型態'), '文字');
    await user.click(within(form).getByRole('button', { name: '重新預檢' }));
    await waitFor(() => expect(precheck()).toHaveTextContent('拒絕 6 列'));
  });

  it('columns missing from an advanced JSON schema are never dropped silently', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    const { form } = await choose(user, 'cohort_01.csv', 'partial');
    await user.click(within(form).getByText('進階：自行提供結構定義（JSON）'));
    within(form).getByLabelText('結構定義（JSON）').focus();
    await user.paste('{"columns":[{"name":"patient_id","type":"str"},{"name":"age","type":"int"},{"name":"sex","type":"category"}]}');
    await user.click(within(form).getByRole('button', { name: '上傳並驗證' }));
    const warning = await within(form).findByText('結構定義沒有列出 9 個欄位', { exact: false });
    expect(warning.closest('.alert')).toHaveTextContent('bmi、sbp、dbp');
    await user.click(within(form).getByRole('button', { name: '自動加入這些欄位' }));
    expect((within(form).getByLabelText('結構定義（JSON）') as HTMLTextAreaElement).value).toContain('"glucose"');
    await user.click(within(form).getByRole('button', { name: '上傳並驗證' }));
    const result = await screen.findByRole('region', { name: '「partial」的上傳結果' });
    expect(result).toHaveTextContent('全部通過');
    expect(result).not.toHaveTextContent('將忽略');
  });

  it('keeping the partial schema needs an explicit choice and the result says columns were left out', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    const { form } = await choose(user, 'cohort_01.csv', 'partial2');
    await user.click(within(form).getByText('進階：自行提供結構定義（JSON）'));
    within(form).getByLabelText('結構定義（JSON）').focus();
    await user.paste('{"columns":[{"name":"patient_id","type":"str"}]}');
    await user.click(within(form).getByRole('button', { name: '上傳並驗證' }));
    await user.click(await within(form).findByRole('button', { name: '不要這些欄位，繼續上傳' }));
    const result = await screen.findByRole('region', { name: '「partial2」的上傳結果' });
    expect(result).toHaveTextContent('資料列全部通過，但有欄位沒有進入資料集');
  });

  it('same name: a new version by default, or replace the old dataset', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    let { form } = await choose(user, 'cohort_01.csv', 'lung-clinical');
    expect(within(form).getByRole('group', { name: '已經有名為「lung-clinical」的資料集' })).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: '上傳並驗證' }));
    expect(await screen.findByText('已建立資料集「lung-clinical（第 2 版）」')).toBeInTheDocument();

    ({ form } = await choose(user, 'cohort_01.csv', 'lung-clinical（第 2 版）'));
    await user.click(within(form).getByLabelText(/^取代舊的/));
    await user.click(within(form).getByRole('button', { name: '上傳並驗證' }));
    expect(await screen.findByText('已取代資料集「lung-clinical（第 2 版）」')).toBeInTheDocument();
    const list = await screen.findByRole('table', { name: '資料集列表' });
    await waitFor(() => expect(bodyRows(list).map((r) => r[0])).toEqual(['lung-clinical', 'lung-clinical（第 2 版）']));
  });

  it('missing-value spellings can be changed and the columns are judged again', async () => {
    const { user } = await renderApp('/data/tabular', 'pi01');
    const { form } = await choose(user, 'cohort_01.csv', 'mv');
    const field = within(form).getByLabelText('視為缺值的寫法');
    expect(field).toHaveValue('NA、N/A、null、NaN、none、-');
    await user.clear(field);
    await user.type(field, 'NA、999');
    await user.click(within(form).getByRole('button', { name: '套用缺值寫法並重新判斷' }));
    await waitFor(() => expect(within(form).getByLabelText('視為缺值的寫法')).toHaveValue('NA、999'));
  });
});
