import { useEffect, useRef, useState } from 'react';
import { withQuery } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useMe, useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { DataTable } from './DataTable';
import { useDataset } from './DatasetLayout';
import { clearLegacyHidden, loadLegacyHidden, type ColumnView } from './hiddenColumns';
import type { Preview } from './types';

const PAGE = 50;

/** TC-B04-02 預覽：可隱藏欄位；隱藏狀態存在伺服器（每位使用者一份），重新載入或換電腦後仍在。 */
export function PreviewTab() {
  const { api } = useSession();
  const me = useMe();
  const { dataset, base } = useDataset();
  const all = dataset.columns.map((c) => c.name);
  const [hidden, setHidden] = useState<string[] | null>(null);
  const [viewError, setViewError] = useState<unknown>(null);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const [offset, setOffset] = useState(0);
  const shown = hidden ?? [];
  const visible = all.filter((c) => !shown.includes(c));
  const viewPath = `${base}/column-view`;

  useEffect(() => {
    let live = true;
    const known = (cols: string[]) => cols.filter((c) => all.includes(c));
    setHidden(null);
    setViewError(null);
    (async () => {
      let next: string[] = [];
      try {
        const view = await api.get<ColumnView>(viewPath);
        next = known(view.hidden);
        if (!view.saved) {
          const legacy = known(loadLegacyHidden(me.username, dataset.project_id, dataset.id));
          if (legacy.length) {
            next = legacy;
            await api.put<ColumnView>(viewPath, { hidden: legacy });
          }
          clearLegacyHidden(me.username, dataset.project_id, dataset.id);
        }
      } catch (e) {
        if (live) setViewError(e);
      }
      if (live) setHidden(next);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPath, me.username]);

  const preview = useResource(
    () =>
      hidden === null || visible.length === 0
        ? Promise.resolve(null)
        : api.get<Preview>(withQuery(`${base}/preview`, { offset, limit: PAGE, columns: shown.length ? visible : undefined })),
    [base, offset, hidden === null ? null : hidden.join('\u0001')],
  );

  function update(next: string[]) {
    setHidden(next);
    setViewError(null);
    // 依序送出，伺服器上留下的一定是最後一次的選擇
    saving.current = saving.current.then(() => api.put<ColumnView>(viewPath, { hidden: next }).catch(setViewError));
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
                checked={!shown.includes(c)}
                disabled={hidden === null}
                onChange={(e) => update(e.target.checked ? shown.filter((h) => h !== c) : [...shown, c])}
              />
              {c}
            </label>
          ))}
        </div>
        <div className="row-actions">
          <button type="button" className="btn btn--secondary btn--small" onClick={() => update([])} disabled={shown.length === 0}>
            全部顯示
          </button>
        </div>
        <p role="status" className="text-muted">
          {shown.length === 0 ? `顯示全部 ${all.length} 個欄位` : `顯示 ${visible.length} 個欄位，已隱藏 ${shown.length} 個：${shown.join('、')}`}
          。這個設定存在你的帳號，換電腦也一樣。
        </p>
        <ApiErrorAlert error={viewError} />
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
