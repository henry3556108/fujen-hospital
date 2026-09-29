import { useState } from 'react';
import { withQuery } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useMe, useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { DataTable } from './DataTable';
import { useDataset } from './DatasetLayout';
import { loadHidden, saveHidden } from './hiddenColumns';
import type { Preview } from './types';

const PAGE = 50;

/** TC-B04-02 預覽：可隱藏欄位；隱藏狀態重新載入後仍在。 */
export function PreviewTab() {
  const { api } = useSession();
  const me = useMe();
  const { dataset, base } = useDataset();
  const all = dataset.columns.map((c) => c.name);
  const [hidden, setHidden] = useState(() => loadHidden(me.username, dataset.project_id, dataset.id).filter((c) => all.includes(c)));
  const [offset, setOffset] = useState(0);
  const visible = all.filter((c) => !hidden.includes(c));
  const preview = useResource(
    () =>
      visible.length === 0
        ? Promise.resolve(null)
        : api.get<Preview>(withQuery(`${base}/preview`, { offset, limit: PAGE, columns: hidden.length ? visible : undefined })),
    [base, offset, hidden.join('\u0001')],
  );

  function update(next: string[]) {
    setHidden(next);
    saveHidden(me.username, dataset.project_id, dataset.id, next);
  }

  const total = preview.data?.total_rows ?? dataset.valid_rows;
  const last = Math.min(total, offset + PAGE);

  return (
    <>
      <fieldset className="section">
        <legend>顯示欄位</legend>
        <div className="col-picker">
          {all.map((c) => (
            <label key={c} className="checkbox">
              <input
                type="checkbox"
                checked={!hidden.includes(c)}
                onChange={(e) => update(e.target.checked ? hidden.filter((h) => h !== c) : [...hidden, c])}
              />
              {c}
            </label>
          ))}
        </div>
        <div className="row-actions">
          <button type="button" className="btn btn--secondary btn--small" onClick={() => update([])} disabled={hidden.length === 0}>
            全部顯示
          </button>
        </div>
        <p role="status" className="text-muted">
          {hidden.length === 0 ? `顯示全部 ${all.length} 個欄位` : `顯示 ${visible.length} 個欄位，已隱藏 ${hidden.length} 個：${hidden.join('、')}`}
          。這個設定存在這台電腦的瀏覽器。
        </p>
      </fieldset>

      <ApiErrorAlert error={preview.error} />
      {visible.length === 0 ? (
        <Alert tone="info">所有欄位都已隱藏，請至少勾選一個欄位。</Alert>
      ) : (
        preview.data && (
          <>
            <div className="page-head section">
              <p role="status">
                第 {total === 0 ? 0 : offset + 1}–{last} 列，共 {total} 列
              </p>
              <div className="row-actions">
                <button type="button" className="btn btn--secondary btn--small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  上一頁
                </button>
                <button type="button" className="btn btn--secondary btn--small" disabled={last >= total} onClick={() => setOffset(offset + PAGE)}>
                  下一頁
                </button>
              </div>
            </div>
            <DataTable label="資料預覽" preview={preview.data} />
          </>
        )
      )}
    </>
  );
}
