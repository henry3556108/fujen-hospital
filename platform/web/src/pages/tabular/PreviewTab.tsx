import { useEffect, useRef, useState } from 'react';
import { withQuery } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useMe, useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { formatStat } from '../../components/format';
import { Pagination, SidePanel, SplitLayout } from '../../components/ui';
import { DataTable } from './DataTable';
import { useDataset } from './DatasetLayout';
import { clearLegacyHidden, loadLegacyHidden, type ColumnView } from './hiddenColumns';
import type { Describe, DescribeColumn, Preview } from './types';

const PAGE = 50;
const PAGE_SIZES = [10, 20, 50, 100];

/** 摘要方塊：前 3 個「真的是數值」的欄位平均（排除 0／1 欄位與每列都不同的識別碼） */
export function summaryColumns(columns: DescribeColumn[], visible: string[]): DescribeColumn[] {
  return columns
    .filter((c) => visible.includes(c.name) && c.kind === 'numeric' && c.mean !== undefined)
    .filter((c) => !(c.min === 0 && c.max === 1 && c.unique <= 2))
    .filter((c) => !(c.count > 1 && c.unique === c.count))
    .slice(0, 3);
}

/** TC-B04-02 資料預覽（B09）：右側欄位顯示面板可隱藏欄位；隱藏狀態存在伺服器（每位使用者一份），重新載入或換電腦後仍在。 */
export function PreviewTab() {
  const { api } = useSession();
  const me = useMe();
  const { dataset, base } = useDataset();
  const all = dataset.columns.map((c) => c.name);
  const [hidden, setHidden] = useState<string[] | null>(null);
  const [viewError, setViewError] = useState<unknown>(null);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const [offset, setOffset] = useState(0);
  const [size, setSize] = useState(PAGE);
  const [search, setSearch] = useState('');
  const shown = hidden ?? [];
  const visible = all.filter((c) => !shown.includes(c));
  const viewPath = `${base}/column-view`;
  const describe = useResource(() => api.get<Describe>(`${base}/describe`).catch(() => null), [base]);

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
        : api.get<Preview>(withQuery(`${base}/preview`, { offset, limit: size, columns: shown.length ? visible : undefined })),
    [base, offset, size, hidden === null ? null : hidden.join('\u0001')],
  );

  function update(next: string[]) {
    setHidden(next);
    setViewError(null);
    // 依序送出，伺服器上留下的一定是最後一次的選擇（勾選後自動儲存，不必另外按儲存）
    saving.current = saving.current.then(() => api.put<ColumnView>(viewPath, { hidden: next }).catch(setViewError));
  }

  const total = preview.data?.total_rows ?? dataset.valid_rows;
  const q = search.trim().toLowerCase();
  const listed = q ? all.filter((c) => c.toLowerCase().includes(q)) : all;
  const tiles = summaryColumns(describe.data?.columns ?? [], visible);

  const side = (
    <SidePanel title="欄位顯示">
      <div className="rd-colpanel">
        <div className="field">
          <label htmlFor="col-search" className="visually-hidden">
            搜尋欄位名稱
          </label>
          <input
            id="col-search"
            type="search"
            className="input"
            placeholder="搜尋欄位名稱"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <fieldset className="section">
          <legend>顯示欄位</legend>
          <div className="rd-colpanel__list">
            {listed.map((c) => (
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
            {listed.length === 0 && <span className="text-muted">沒有符合的欄位</span>}
          </div>
        </fieldset>
        <div className="rd-colpanel__actions section">
          <button type="button" className="btn btn--secondary btn--small" onClick={() => update([])} disabled={shown.length === 0}>
            全部顯示
          </button>
        </div>
        <p role="status" className="text-muted section">
          {shown.length === 0 ? `顯示全部 ${all.length} 個欄位` : `顯示 ${visible.length} 個欄位，已隱藏 ${shown.length} 個：${shown.join('、')}`}
          。這個設定存在你的帳號，換電腦也一樣。
        </p>
        <p className="field__hint">勾選後自動儲存。隱藏只影響你自己的檢視，不會刪除欄位，也不影響模型用的欄位。</p>
        <ApiErrorAlert error={viewError} />
      </div>
    </SidePanel>
  );

  return (
    <SplitLayout side={side} sideWidth="18rem">
      <div className="card">
        <div className="rd-section-head">
          <h3>
            共 {total} 筆資料・{all.length} 個欄位
          </h3>
        </div>
        {tiles.length > 0 && (
          <ul className="rd-tiles" aria-label="摘要統計">
            {tiles.map((c) => (
              <li key={c.name} className="rd-tile">
                <span className="rd-tile__label" title={`平均 ${c.name}`}>
                  平均 {c.name}
                </span>
                <span className="rd-tile__value" title={String(c.mean)}>
                  {formatStat(c.mean!)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <ApiErrorAlert error={preview.error} />
        {visible.length === 0 ? (
          <Alert tone="info">所有欄位都已隱藏，請至少勾選一個欄位。</Alert>
        ) : (
          preview.data && (
            <div className="section">
              <DataTable label="資料預覽" preview={preview.data} />
              <Pagination
                label="資料預覽分頁"
                page={Math.floor(offset / size) + 1}
                pageSize={size}
                total={total}
                pageSizeOptions={PAGE_SIZES}
                onPageChange={(p) => setOffset((p - 1) * size)}
                onPageSizeChange={(n) => {
                  setSize(n);
                  setOffset(0);
                }}
              />
            </div>
          )
        )}
      </div>
    </SplitLayout>
  );
}
