import { useState } from 'react';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { DataTable } from './DataTable';
import { useDataset } from './DatasetLayout';
import { StepsEditor } from './StepsEditor';
import { KIND_LABELS, type PipelinePreview } from './types';

/** TC-B04-04、06 前處理：方法清單來自 API；在資料副本上套用後預覽，不改動已儲存的資料集。 */
export function PreprocessTab() {
  const { api } = useSession();
  const { dataset, base, catalogue, steps, setSteps } = useDataset();
  const [result, setResult] = useState<PipelinePreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const categories = [...new Map(catalogue.map((c) => [c.category, c.category_zh])).entries()];

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post<PipelinePreview>(`${base}/preprocess/preview`, { steps, limit: 50 }));
    } catch (e) {
      setError(e);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p role="status">
        共 {catalogue.length} 種前處理方法：
        {categories.map(([id, label]) => `${label} ${catalogue.filter((c) => c.category === id).length} 種`).join('、')}。
      </p>
      <details>
        <summary>方法清單</summary>
        <div className="table-wrap">
          <table aria-label="前處理方法清單">
            <thead>
              <tr>
                <th scope="col">方法</th>
                <th scope="col">代號</th>
                <th scope="col">類別</th>
                <th scope="col">適用欄位類型</th>
              </tr>
            </thead>
            <tbody>
              {catalogue.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.name_zh}</th>
                  <td className="mono">{c.id}</td>
                  <td>{c.category_zh}</td>
                  <td>{c.column_types.map((t) => (t === 'any' ? '全部' : (KIND_LABELS[t] ?? t))).join('、')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <StepsEditor
        catalogue={catalogue}
        columns={dataset.columns}
        steps={steps}
        onChange={(s) => {
          setSteps(s);
          setResult(null);
        }}
      />
      <div className="row-actions section">
        <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={busy}>
          {busy ? '套用中…' : '預覽套用結果'}
        </button>
      </div>
      <ApiErrorAlert error={error} />
      {result && (
        <section className="section" aria-label="前處理預覽結果">
          <h3>套用後的資料（前 50 列）</h3>
          <p role="status">
            套用 {steps.length} 個步驟後：{result.row_count} 列、{result.columns.length} 欄，缺值合計{' '}
            {result.columns.reduce((a, c) => a + c.missing, 0)} 筆
          </p>
          <DataTable label="前處理後的資料預覽" preview={result.preview} />
          <p className="text-muted">步驟會帶到「Target／Feature」分頁一起儲存，也可以在「統計分析」套用。</p>
        </section>
      )}
    </>
  );
}
