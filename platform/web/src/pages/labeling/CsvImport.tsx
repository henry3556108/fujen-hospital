// 匯入診斷結果（原「CSV 自動分類標註」）：選檔 → 選對照欄位 → 預覽配對 → 建立新資料集或加入既有。
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { FileInput } from '../../components/FileInput';
import type { LabelingApi } from './api';
import type { CsvKey, CsvResult, CsvRowStatus, LabelDataset, StudySummary } from './types';

const ROW_STATUS: Record<CsvRowStatus, string> = {
  matched: '已標註',
  unmatched: '找不到研究',
  conflict: '診斷衝突',
  invalid: '資料不完整',
};

const KEY_ALIASES: Record<CsvKey, string[]> = {
  patient_id: ['patient_id', 'patientid', '病歷號', '病歷號碼', 'chart_no', 'mrn'],
  accession_number: ['accession_number', 'accessionnumber', 'accession', '影像編號', '檢查單號'],
};
const LABEL_ALIASES = ['diagnosis', 'label', '診斷', '診斷結果'];

/** 簡單的 CSV 解析（逗號分隔、去掉 BOM 與外層引號），只用來預覽；實際匯入以伺服器為準。 */
export function parseCsv(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => l.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1')));
}

export interface CsvPreviewRow {
  row: number;
  key: string;
  label: string;
  status: CsvRowStatus;
}

/** 依目前專案的研究預覽每一列會不會配對成功。 */
export function previewCsv(lines: string[][], keyAt: number, labelAt: number, key: CsvKey, studies: StudySummary[]): CsvPreviewRow[] {
  const rows = lines.slice(1).map((l, i) => ({ row: i + 2, key: l[keyAt] ?? '', label: l[labelAt] ?? '' }));
  const perKey = new Map<string, Set<string>>();
  for (const r of rows) if (r.key && r.label) perKey.set(r.key, (perKey.get(r.key) ?? new Set()).add(r.label));
  const known = new Set(studies.map((s) => (key === 'patient_id' ? s.patient_id : s.accession_number)));
  return rows.map((r) => ({
    ...r,
    status: !r.key || !r.label ? 'invalid' : (perKey.get(r.key)?.size ?? 0) > 1 ? 'conflict' : known.has(r.key) ? 'matched' : 'unmatched',
  }));
}

export function CsvImport({
  labeling,
  studies,
  datasets,
  onDone,
  defaultDatasetId,
  bare,
}: {
  labeling: LabelingApi;
  studies: StudySummary[];
  datasets: LabelDataset[];
  onDone: () => void;
  /** 從某一份資料集打開時，預設加入這一份 */
  defaultDatasetId?: number;
  /** 放在滑出面板裡：不畫外框與標題（面板自己有標題） */
  bare?: boolean;
}) {
  const { project } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [lines, setLines] = useState<string[][]>([]);
  const [key, setKey] = useState<CsvKey>('patient_id');
  const [keyColumn, setKeyColumn] = useState('');
  const [labelColumn, setLabelColumn] = useState('');
  const [target, setTarget] = useState<'new' | 'existing'>(defaultDatasetId !== undefined ? 'existing' : 'new');
  const [name, setName] = useState('');
  const [existing, setExisting] = useState(defaultDatasetId !== undefined ? String(defaultDatasetId) : '');
  const [result, setResult] = useState<CsvResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const header = lines[0] ?? [];
  const classification = datasets.filter((d) => d.task === 'classification');

  async function pick(files: FileList | File[] | null) {
    const f = files?.[0] ?? null;
    setFile(f);
    setResult(null);
    setError(null);
    if (!f) return setLines([]);
    const parsed = parseCsv(await readText(f));
    setLines(parsed);
    const head = (parsed[0] ?? []).map((h) => h.toLowerCase());
    // 自動猜鍵欄與診斷欄；猜不到就留空，由伺服器辨識或使用者自己選
    const byAccession = head.findIndex((h) => KEY_ALIASES.accession_number.includes(h));
    const byPatient = head.findIndex((h) => KEY_ALIASES.patient_id.includes(h));
    const k: CsvKey = byPatient < 0 && byAccession >= 0 ? 'accession_number' : 'patient_id';
    setKey(k);
    const keyAt = k === 'patient_id' ? byPatient : byAccession;
    setKeyColumn(keyAt >= 0 ? parsed[0][keyAt] : '');
    const labelAt = head.findIndex((h) => LABEL_ALIASES.includes(h));
    setLabelColumn(labelAt >= 0 ? parsed[0][labelAt] : '');
    setName(f.name.replace(/\.csv$/i, ''));
  }

  const preview = useMemo(() => {
    const keyAt = header.indexOf(keyColumn);
    const labelAt = header.indexOf(labelColumn);
    if (keyAt < 0 || labelAt < 0 || lines.length < 2) return null;
    return previewCsv(lines, keyAt, labelAt, key, studies);
  }, [lines, header, keyColumn, labelColumn, key, studies]);
  const tally = (s: CsvRowStatus) => preview?.filter((r) => r.status === s).length ?? 0;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || file.size === 0) return setError(new Error('請先選擇 CSV 檔'));
    if (target === 'new' && !name.trim()) return setError(new Error('請輸入新資料集的名稱'));
    if (target === 'existing' && !existing) return setError(new Error('請選擇要加入的資料集'));
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const dest = target === 'new' ? { datasetName: name.trim() } : { datasetId: Number(existing) };
      setResult(await labeling.classifyCsv(file, key, keyColumn || undefined, labelColumn || undefined, dest));
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const problems = result?.results.filter((r) => r.status !== 'matched') ?? [];
  return (
    <section className={bare ? 'stack' : 'ui-card lb-csv section'} aria-labelledby={bare ? undefined : 'csv-title'}>
      {bare ? null : (
        <h2 id="csv-title" className="ui-card__title">
          匯入診斷結果
        </h2>
      )}
      <p className="text-muted">
        用醫師既有的診斷表（CSV）一次完成分類標註。第一列是欄名，需要有病歷號或影像編號一欄，以及診斷一欄。匯入的標註直接算已確認；重新匯入會更新，不會重複。
      </p>
      <ApiErrorAlert error={error} />
      <form aria-label="匯入診斷結果" onSubmit={submit} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="csv-file">CSV 檔（必填）</label>
            <FileInput id="csv-file" name="file" accept=".csv,text/csv" aria-required="true" onFiles={(f) => void pick(f)} />
          </div>
          <div className="field">
            <label htmlFor="csv-key">用哪一種編號對照影像</label>
            <select id="csv-key" className="select" value={key} onChange={(e) => setKey(e.target.value as CsvKey)}>
              <option value="patient_id">病歷號</option>
              <option value="accession_number">影像編號（Accession Number）</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="csv-key-column">編號在哪一欄</label>
            <select id="csv-key-column" className="select" value={keyColumn} onChange={(e) => setKeyColumn(e.target.value)} disabled={header.length === 0}>
              <option value="">自動辨識</option>
              {header.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="csv-label-column">診斷在哪一欄</label>
            <select
              id="csv-label-column"
              className="select"
              value={labelColumn}
              onChange={(e) => setLabelColumn(e.target.value)}
              disabled={header.length === 0}
            >
              <option value="">自動辨識</option>
              {header.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
        </div>

        {preview ? (
          <div className="stack section" data-testid="csv-preview">
            <p>
              預覽：共 {preview.length} 列，可配對 <strong>{tally('matched')}</strong> 列，找不到研究 {tally('unmatched')} 列，診斷衝突 {tally('conflict')}{' '}
              列，資料不完整 {tally('invalid')} 列。
            </p>
            {tally('unmatched') > 0 ? (
              <Alert tone="warning">
                有 {tally('unmatched')} 列在目前專案找不到影像。目前專案是「{project?.name}」，這個專案有 {studies.length}{' '}
                筆影像。如果診斷表是別的專案的，請先切換專案；如果影像還沒匯入，請到 <Link to="/data/imaging/import">研究資料 → 加入資料</Link>。
              </Alert>
            ) : null}
          </div>
        ) : null}

        <fieldset className="field section">
          <legend>匯入到哪一份標註資料集</legend>
          <label className="checkbox-row">
            <input type="radio" name="csv-target" checked={target === 'new'} onChange={() => setTarget('new')} />
            建立新資料集
          </label>
          {target === 'new' ? (
            <div className="field">
              <label htmlFor="csv-dataset-name">新資料集名稱</label>
              <input id="csv-dataset-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          ) : null}
          <label className="checkbox-row">
            <input
              type="radio"
              name="csv-target"
              checked={target === 'existing'}
              disabled={classification.length === 0}
              onChange={() => setTarget('existing')}
            />
            加入既有資料集{classification.length === 0 ? '（目前沒有分類資料集）' : ''}
          </label>
          {target === 'existing' ? (
            <div className="field">
              <label htmlFor="csv-dataset">資料集</label>
              <select id="csv-dataset" className="select" value={existing} onChange={(e) => setExisting(e.target.value)}>
                <option value="">請選擇</option>
                {classification.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </fieldset>
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? '處理中…' : '匯入'}
        </button>
      </form>

      {result ? (
        <div className="stack section" data-testid="csv-result">
          <Alert tone={problems.length === 0 ? 'success' : 'warning'}>
            共 {result.rows} 列：已標註 {result.matched} 列（{result.annotated_studies} 個研究；新增 {result.created}、更新 {result.updated}、未變動{' '}
            {result.unchanged}），找不到研究 {result.unmatched} 列，診斷衝突 {result.conflict} 列，資料不完整 {result.invalid} 列。
          </Alert>
          {result.unmatched > 0 ? (
            <p className="text-muted">
              目前專案是「{project?.name}」，這個專案有 {studies.length} 筆影像。
            </p>
          ) : null}
          {result.dataset_id ? (
            <p>
              <Link to={`/labeling/datasets/${result.dataset_id}`}>查看這份標註資料集</Link>
              {/* 匯入完的下一步（03 規格 4.1）：有 Training 權限才給建立模型 */}
              {project?.permissions.includes('training') ? (
                <>
                  {'　'}
                  <Link to={`/training/new?labelDataset=${result.dataset_id}`}>下一步：用這份資料建立模型</Link>
                </>
              ) : null}
            </p>
          ) : null}
          {problems.length > 0 ? (
            <div className="table-wrap">
              <table aria-label="未標註的資料列">
                <thead>
                  <tr>
                    <th scope="col">行號</th>
                    <th scope="col">編號</th>
                    <th scope="col">診斷</th>
                    <th scope="col">狀態</th>
                    <th scope="col">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {problems.map((r) => (
                    <tr key={r.row}>
                      <th scope="row">{r.row}</th>
                      <td>{r.key || '（空白）'}</td>
                      <td>{r.label || '（空白）'}</td>
                      <td>{ROW_STATUS[r.status]}</td>
                      <td>{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** 讀出檔案文字；舊瀏覽器與測試環境沒有 File.text() 時改用 FileReader。 */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
