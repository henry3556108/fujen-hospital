import { useState, type FormEvent } from 'react';
import { AUDIT_CATEGORIES, AUDIT_CATEGORY_LABELS, type AuditCategory, type AuditPage as Page } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';

const RESULT_LABELS: Record<string, string> = {
  success: '成功',
  failed: '失敗',
  failure: '失敗',
  partial: '部分完成',
  rejected: '已拒絕',
  denied: '拒絕存取',
  cancelled: '已取消',
  accepted: '已受理',
  not_sent_offline: '離線，未送出',
};

const LOCAL_SOURCES: Record<string, string> = {
  seed: '建立測試基線',
  bootstrap_admin: '登記初始管理者',
  project_cleanup: '清理專案資料',
  acceptance: '驗收測試',
};

/** 來源：網路位址照原樣；命令列執行的 local:<程式> 顯示白話說明；沒有記錄時明確寫出。 */
export function sourceLabel(source: string | null): { text: string; raw: string | null } {
  if (!source) return { text: '（未記錄）', raw: null };
  if (source.startsWith('local:')) {
    const name = source.slice(6);
    return { text: `本機指令：${LOCAL_SOURCES[name] ?? name}`, raw: source };
  }
  return { text: source, raw: null };
}

const categoryLabel = (c: string) => AUDIT_CATEGORY_LABELS[c as AuditCategory] ?? c;
const PAGE_SIZES = [20, 50, 100];

interface Filters {
  category: string;
  actor: string;
  action: string;
  since: string; // datetime-local（瀏覽器時區）
  until: string;
}

const EMPTY: Filters = { category: '', actor: '', action: '', since: '', until: '' };

function query(f: Filters, page: number, size: number): string {
  const q = new URLSearchParams({ page: String(page), page_size: String(size) });
  if (f.category) q.set('category', f.category);
  if (f.actor.trim()) q.set('actor', f.actor.trim());
  if (f.action.trim()) q.set('action', f.action.trim());
  if (f.since) q.set('since', new Date(f.since).toISOString());
  if (f.until) q.set('until', new Date(f.until).toISOString());
  return q.toString();
}

const formatAt = (iso: string) => new Date(iso).toLocaleString('zh-TW', { hour12: false });

/** 稽核紀錄（唯讀）：A-03 第 6 項與 D-01 的抽查。本頁沒有任何修改或刪除的操作。 */
export function AuditPage() {
  const { api } = useSession();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const qs = query(filters, page, size);
  const data = useResource(() => api.get<Page>(`/api/admin/audit?${qs}`), [qs]);
  const d = data.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.page_size)) : 1;

  function apply(e: FormEvent) {
    e.preventDefault();
    setFilters(draft);
    setPage(1);
  }

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((v) => ({ ...v, [k]: e.target.value }));

  return (
    <div className="section">
      <h2>稽核紀錄</h2>
      <p className="text-muted">
        帳號、角色、權限、專案、資料集等操作的紀錄，只能查詢，不能修改或刪除。時間以瀏覽器所在時區顯示。
      </p>
      <form aria-label="篩選稽核紀錄" className="card section" onSubmit={apply} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="audit-category">類別</label>
            <select id="audit-category" className="select" value={draft.category} onChange={set('category')}>
              <option value="">全部</option>
              {AUDIT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {AUDIT_CATEGORY_LABELS[c]}（{c}）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="audit-actor">操作者</label>
            <input id="audit-actor" className="input" value={draft.actor} onChange={set('actor')} placeholder="例如 admin01" />
          </div>
          <div className="field">
            <label htmlFor="audit-action">動作（開頭符合）</label>
            <input
              id="audit-action"
              className="input"
              value={draft.action}
              onChange={set('action')}
              placeholder="例如 labeling_group"
            />
          </div>
          <div className="field">
            <label htmlFor="audit-since">開始時間</label>
            <input id="audit-since" className="input" type="datetime-local" value={draft.since} onChange={set('since')} />
          </div>
          <div className="field">
            <label htmlFor="audit-until">結束時間（不含）</label>
            <input id="audit-until" className="input" type="datetime-local" value={draft.until} onChange={set('until')} />
          </div>
        </div>
        <div className="row-actions">
          <button type="submit" className="btn btn--primary">
            查詢
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              setDraft(EMPTY);
              setFilters(EMPTY);
              setPage(1);
            }}
          >
            清除條件
          </button>
        </div>
      </form>

      <ApiErrorAlert error={data.error} />
      <div className="page-head">
        <p role="status">{d ? `共 ${d.total} 筆，第 ${d.page}／${pages} 頁` : data.loading ? '載入中…' : ''}</p>
        <div className="row-actions">
          <label htmlFor="audit-size">每頁</label>
          <select
            id="audit-size"
            className="select"
            value={size}
            onChange={(e) => {
              setSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} 筆
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="table-wrap">
        <table aria-label="稽核紀錄">
          <thead>
            <tr>
              <th scope="col">編號</th>
              <th scope="col">時間</th>
              <th scope="col">操作者</th>
              <th scope="col">類別</th>
              <th scope="col">動作</th>
              <th scope="col">對象</th>
              <th scope="col">結果</th>
              <th scope="col">來源</th>
              <th scope="col">內容</th>
            </tr>
          </thead>
          <tbody>
            {d && d.items.length === 0 && (
              <tr>
                <td colSpan={9}>沒有符合條件的紀錄。</td>
              </tr>
            )}
            {d?.items.map((e) => {
              const source = sourceLabel(e.source_ip);
              const detail = JSON.stringify(e.detail ?? {});
              return (
                <tr key={e.id}>
                  <td className="mono">{e.id}</td>
                  <td>
                    <time dateTime={e.at}>{formatAt(e.at)}</time>
                  </td>
                  <th scope="row">{e.actor}</th>
                  <td>{categoryLabel(e.category)}</td>
                  <td className="mono">{e.action}</td>
                  <td className="mono">{e.target}</td>
                  <td>{RESULT_LABELS[e.result] ?? e.result}</td>
                  <td>
                    {source.text}
                    {source.raw && <div className="text-muted mono">{source.raw}</div>}
                  </td>
                  <td>
                    {detail === '{}' ? (
                      '—'
                    ) : (
                      <details>
                        <summary>查看</summary>
                        <pre className="mono">{JSON.stringify(e.detail, null, 2)}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row-actions">
        <button type="button" className="btn btn--secondary" disabled={page <= 1 || data.loading} onClick={() => setPage((p) => p - 1)}>
          上一頁
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          disabled={!d || page >= pages || data.loading}
          onClick={() => setPage((p) => p + 1)}
        >
          下一頁
        </button>
      </div>
    </div>
  );
}
