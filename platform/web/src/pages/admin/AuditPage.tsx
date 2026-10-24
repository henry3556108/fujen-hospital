import { useState, type FormEvent } from 'react';
import { AUDIT_CATEGORIES, AUDIT_CATEGORY_LABELS, type AuditCategory, type AuditEntry, type AuditPage as Page } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { Icon, InfoList, SidePanel, SplitLayout } from '../../components/ui';
import './admin.css';

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

// 內容欄位的白話名稱；沒列到的照原欄位名稱顯示
const FIELD_LABELS: Record<string, string> = {
  account_type: '帳號類型',
  role: '角色',
  permissions: '權限',
  name: '名稱',
  description: '說明',
  members: '成員',
  member_ids: '成員',
  project_id: '專案編號',
  project: '專案',
  username: '帳號',
  user_id: '帳號編號',
  queue: '佇列',
  gpu_group: 'GPU 群組',
  status: '狀態',
  reason: '原因',
  count: '筆數',
  accession_numbers: 'Accession Number',
};

export interface DetailChange {
  field: string;
  before: string;
  after: string;
}
export interface DetailField {
  field: string;
  value: string;
}

const PAIRS: [string, string][] = [
  ['from', 'to'],
  ['before', 'after'],
  ['old', 'new'],
];

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length === 0 ? '（無）' : v.every((x) => typeof x !== 'object' || x === null) ? v.map((x) => String(x)).join('、') : JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

function fieldName(path: string[]): string {
  if (path.length === 0) return '（本筆）';
  return path.map((k) => FIELD_LABELS[k] ?? k).join(' › ');
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 稽核內容攤平成可讀欄位（F10）：
 * 有 from/to、before/after、old/new 成對的欄位當作「變更前→變更後」；其他欄位逐一列出，巢狀物件用 › 串起欄位名稱。
 */
export function flattenAuditDetail(detail: Record<string, unknown> | null | undefined): { changes: DetailChange[]; fields: DetailField[] } {
  const changes: DetailChange[] = [];
  const fields: DetailField[] = [];
  function walk(v: unknown, path: string[]) {
    if (isPlain(v)) {
      const pair = PAIRS.find(([a, b]) => a in v && b in v);
      if (pair) {
        const [a, b] = pair;
        changes.push({ field: fieldName(path), before: show(v[a]), after: show(v[b]) });
        for (const [k, x] of Object.entries(v)) if (k !== a && k !== b) walk(x, [...path, k]);
        return;
      }
      for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
      return;
    }
    fields.push({ field: fieldName(path), value: show(v) });
  }
  if (detail) walk(detail, []);
  return { changes, fields };
}

const categoryLabel = (c: string) => AUDIT_CATEGORY_LABELS[c as AuditCategory] ?? c;
const resultLabel = (r: string) => RESULT_LABELS[r] ?? r;
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

/** 右側「操作詳情」：欄位、變更前後（攤平）、原始內容可展開 */
function DetailPanel({ entry, onClose }: { entry: AuditEntry | null; onClose: () => void }) {
  if (!entry) {
    return (
      <SidePanel title="操作詳情">
        <p className="text-muted">點選左側一筆紀錄，查看完整內容與變更前後。</p>
      </SidePanel>
    );
  }
  const source = sourceLabel(entry.source_ip);
  const { changes, fields } = flattenAuditDetail(entry.detail);
  const raw = JSON.stringify(entry.detail ?? {}, null, 2);
  return (
    <SidePanel title="操作詳情" onClose={onClose}>
      <InfoList
        items={[
          { label: '編號', value: entry.id },
          { label: '時間', value: <time dateTime={entry.at}>{formatAt(entry.at)}</time> },
          { label: '類別', value: categoryLabel(entry.category) },
          { label: '操作者', value: entry.actor },
          { label: '對象', value: <span className="mono">{entry.target}</span> },
          { label: '動作', value: <span className="mono">{entry.action}</span> },
          { label: '結果', value: resultLabel(entry.result) },
          { label: '來源', value: source.raw ? `${source.text}（${source.raw}）` : source.text },
        ]}
      />
      <h3 className="adm-subhead">變更內容</h3>
      {changes.length === 0 ? (
        <p className="text-muted">這筆紀錄沒有變更前後的內容。</p>
      ) : (
        <div className="table-wrap">
          <table aria-label="變更前後">
            <thead>
              <tr>
                <th scope="col">欄位</th>
                <th scope="col">變更前</th>
                <th scope="col">變更後</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c, i) => (
                <tr key={`${c.field}-${i}`}>
                  <th scope="row">{c.field}</th>
                  <td>{c.before}</td>
                  <td>{c.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {fields.length > 0 && (
        <>
          <h3 className="adm-subhead">其他內容</h3>
          <InfoList items={fields.map((f, i) => ({ label: fields.findIndex((x) => x.field === f.field) === i ? f.field : `${f.field}（${i + 1}）`, value: f.value }))} />
        </>
      )}
      {raw !== '{}' && (
        <details className="adm-raw">
          <summary>原始內容（JSON）</summary>
          <pre className="mono">{raw}</pre>
        </details>
      )}
    </SidePanel>
  );
}

/** 稽核紀錄（唯讀，設計稿 B20）：A-03 第 6 項與 D-01 的抽查。本頁沒有任何修改或刪除的操作。 */
export function AuditPage() {
  const { api } = useSession();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const qs = query(filters, page, size);
  const data = useResource(() => api.get<Page>(`/api/admin/audit?${qs}`), [qs]);
  const d = data.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.page_size)) : 1;
  const selected = d?.items.find((e) => e.id === selectedId) ?? null;

  function apply(e: FormEvent) {
    e.preventDefault();
    setFilters(draft);
    setPage(1);
  }

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((v) => ({ ...v, [k]: e.target.value }));

  return (
    <div className="adm-audit">
      <p className="text-muted">
        帳號、角色、權限、專案、資料集等操作的紀錄，只能查詢，不能修改或刪除。時間以瀏覽器所在時區顯示。
      </p>
      <form aria-label="篩選稽核紀錄" className="ui-card adm-filter" onSubmit={apply} noValidate>
        <div className="adm-filter__fields">
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
            <input id="audit-action" className="input" value={draft.action} onChange={set('action')} placeholder="例如 labeling_group" />
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
        <div className="adm-filter__actions">
          <button type="submit" className="btn btn--primary">
            <Icon name="search" /> 查詢
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
      <SplitLayout sideWidth="22rem" side={<DetailPanel entry={selected} onClose={() => setSelectedId(null)} />}>
        <section className="ui-card adm-card" aria-labelledby="audit-list-title">
          <div className="ui-card__head">
            <h2 id="audit-list-title" className="ui-card__title">
              稽核紀錄{d ? `（${d.total} 筆）` : ''}
            </h2>
          </div>
          <div className="table-wrap">
            <table aria-label="稽核紀錄" className="adm-audit-table">
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
                  const active = e.id === selectedId;
                  return (
                    <tr
                      key={e.id}
                      className={`adm-row--clickable ${active ? 'adm-row--selected' : ''}`}
                      tabIndex={0}
                      aria-selected={active}
                      onClick={() => setSelectedId(e.id)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          setSelectedId(e.id);
                        }
                      }}
                    >
                      <td className="mono">{e.id}</td>
                      <td>
                        <time dateTime={e.at}>{formatAt(e.at)}</time>
                      </td>
                      <th scope="row">{e.actor}</th>
                      <td>{categoryLabel(e.category)}</td>
                      <td className="mono">{e.action}</td>
                      <td className="mono">{e.target}</td>
                      <td>{resultLabel(e.result)}</td>
                      <td>
                        {source.text}
                        {source.raw && <div className="text-muted mono">{source.raw}</div>}
                      </td>
                      <td>
                        {detail === '{}' ? (
                          '—'
                        ) : (
                          <details onClick={(ev) => ev.stopPropagation()}>
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
          <div className="adm-pager">
            <p role="status">{d ? `共 ${d.total} 筆，第 ${d.page}／${pages} 頁` : data.loading ? '載入中…' : ''}</p>
            <div className="adm-pager__controls">
              <button type="button" className="btn btn--secondary btn--small" disabled={page <= 1 || data.loading} onClick={() => setPage((p) => p - 1)}>
                上一頁
              </button>
              <button
                type="button"
                className="btn btn--secondary btn--small"
                disabled={!d || page >= pages || data.loading}
                onClick={() => setPage((p) => p + 1)}
              >
                下一頁
              </button>
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
        </section>
      </SplitLayout>
    </div>
  );
}
