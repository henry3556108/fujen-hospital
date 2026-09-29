// 模擬 API 的計算要跟真實 API 一致：以下期望值取自 platform/api（pandas／numpy）對同一份 cohort_01.csv 的回應。
import { describe as suite, expect, it } from 'vitest';
import { applyPipeline, columnInfo, describe, parseCsv, validateCsv, validateSteps } from '../../src/mocks/tabular';
import { fixtureText } from '../fixtures';

const schema = JSON.parse(fixtureText('tabular/schema.json'));
const cohort = () => validateCsv(fixtureText('tabular/cohort_01.csv'), schema);

suite('mock tabular API matches the real API', () => {
  it('parseCsv handles quotes, embedded commas, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n1,\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['1', ''],
    ]);
  });

  it('TC-B01-10 cohort_01.csv: 100 rows, none rejected', () => {
    const { report, frame } = cohort();
    expect(report).toMatchObject({ total_rows: 100, valid_rows: 100, rejected_row_count: 0, errors: [] });
    expect(frame.rows).toHaveLength(100);
    expect(frame.rows[0]).toEqual(['P10001', 38, 'M', 23.1, 90, 50, 78.6, 'current', 0, 2180, 0, null]);
  });

  it('TC-B01-10 bad.csv: exactly the rows listed in bad_rows.json are rejected, with the API wording', () => {
    const { report } = validateCsv(fixtureText('tabular/bad.csv'), schema);
    const expected = JSON.parse(fixtureText('tabular/bad_rows.json')).rows as { row: number; column: string }[];
    expect(report.rejected.map((r) => [r.row, r.column])).toEqual(expected.map((r) => [r.row, r.column]));
    expect(report).toMatchObject({ total_rows: 30, valid_rows: 20, rejected_row_count: 10 });
    expect(report.rejected.map((r) => r.reason)).toEqual([
      '必填欄位為空值',
      '值「P90001」重複（與第 0 列相同），此欄位不可重複',
      '「12O」不是整數',
      '「unknown」不在允許值（M、F）之內',
      '「95.0」大於最大值 60',
      '「150」大於最大值 100',
      '「sometimes」不在允許值（never、former、current）之內',
      '必填欄位為空值',
      '「forty」不是整數',
      '值「P90001」重複（與第 0 列相同），此欄位不可重複',
    ]);
  });

  it('missing required columns is an error, not a row rejection', () => {
    const { report } = validateCsv('foo,bar\n1,2\n', schema);
    expect(report.errors).toEqual([
      { code: 'missing_required_columns', message: '缺少必要欄位：patient_id、age、sex、sbp、dbp、smoker、diagnosis、time_to_event、event' },
    ]);
  });

  it('column info matches', () => {
    expect(columnInfo(cohort().frame).filter((c) => ['patient_id', 'age', 'sex', 'glucose', 'study_accession'].includes(c.name))).toEqual([
      { name: 'patient_id', dtype: 'object', kind: 'categorical', missing: 0 },
      { name: 'age', dtype: 'Int64', kind: 'numeric', missing: 0 },
      { name: 'sex', dtype: 'category', kind: 'categorical', missing: 0 },
      { name: 'glucose', dtype: 'float64', kind: 'numeric', missing: 5 },
      { name: 'study_accession', dtype: 'object', kind: 'categorical', missing: 88 },
    ]);
  });

  it('TC-B04-01 describe matches pandas for numeric and categorical columns', () => {
    const d = describe(cohort().frame);
    expect(d.row_count).toBe(100);
    const by = Object.fromEntries(d.columns.map((c) => [c.name, c]));
    expect(by.age).toMatchObject({ count: 100, missing: 0, unique: 51, mean: 59.15, min: 25, p25: 41.75, p50: 61, p75: 77, max: 89 });
    expect(by.age.std).toBeCloseTo(19.79867100937267, 10);
    expect(by.bmi).toMatchObject({ unique: 71, min: 16, p25: 22.9, p50: 25.6, p75: 28.625, max: 35 });
    expect(by.bmi.mean).toBeCloseTo(25.152, 10);
    expect(by.bmi.std).toBeCloseTo(4.237411063993265, 10);
    expect(by.sex).toMatchObject({ count: 100, unique: 2, top: 'M', freq: 51 });
    expect(by.study_accession).toMatchObject({ count: 12, missing: 88, unique: 8, top: 'ACC0010', freq: 3 });
  });

  it('TC-B04-04 mean imputation and One-Hot give the reference result', () => {
    const before = cohort().frame;
    const out = applyPipeline(before, [
      { id: 'impute_mean', columns: ['glucose'] },
      { id: 'onehot', columns: ['sex'] },
    ]);
    expect(columnInfo(out).find((c) => c.name === 'glucose')!.missing).toBe(0);
    expect(out.columns.slice(2, 4)).toEqual(['sex_F', 'sex_M']);
    expect(out.rows[0].slice(2, 4)).toEqual([0, 1]);
    expect(out.rows[1].slice(2, 4)).toEqual([1, 0]);
    const known = before.rows.map((r) => r[6]).filter((v): v is number => v !== null);
    const mean = known.reduce((a, b) => a + b, 0) / known.length;
    expect(out.rows[1][7]).toBeCloseTo(mean, 9); // 第 1 列原本缺 glucose
    // 原始資料不被改動
    expect(before.columns).toContain('sex');
    expect(before.rows[1][6]).toBeNull();
  });

  it('validateSteps fills defaults and reports the API errors', () => {
    expect(validateSteps([{ id: 'onehot', columns: ['sex'] }, { id: 'impute_mean' }])).toEqual([
      { id: 'onehot', columns: ['sex'], params: { drop_first: false } },
      { id: 'impute_mean', columns: [], params: {} },
    ]);
    expect(() => validateSteps([{ id: 'magic' }])).toThrow('找不到前處理方法「magic」');
    expect(() => validateSteps([{ columns: [] }])).toThrow('第 1 個前處理步驟缺少 id');
    expect(() => validateSteps([{ id: 'binary_map', columns: ['sex'] }])).toThrow('缺少必要參數「陽性值（對應為 1）」（positive）');
    expect(() => validateSteps([{ id: 'kbins_uniform', columns: ['age'], params: { n_bins: 1 } }])).toThrow('「等寬分箱」的參數「分箱數」不可小於 2');
    expect(() => validateSteps([{ id: 'drop_columns' }])).toThrow('「刪除欄位」必須指定欄位');
    expect(() => applyPipeline(cohort().frame, [{ id: 'scale_standard', columns: ['sex'] }])).toThrow(
      '「標準化（Z 分數）」不適用於欄位「sex」（型別：categorical），適用型別：numeric',
    );
  });
});

suite('mock histogram', () => {
  it('matches numpy.histogram on bin boundaries (bmi, 5 bins)', async () => {
    const res = await fetch('http://localhost/api/projects/1/tabular/datasets/2/histogram?column=bmi&bins=5', {
      headers: { Authorization: 'Bearer test-token:vw01' },
    });
    const body = await res.json();
    expect(body.counts).toEqual([15, 17, 35, 29, 4]);
    expect(body.edges).toEqual([16, 19.8, 23.6, 27.4, 31.2, 35]);
    expect(body.missing).toBe(0);
  });
});
