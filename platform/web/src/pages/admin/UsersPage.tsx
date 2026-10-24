import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { Link } from 'react-router-dom';
import { ACCOUNT_TYPE_LABELS, ROLE_LABELS, type AccountType, type MemberRow, type Project, type User } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon, InfoList, PageHeader, SidePanel, SplitLayout } from '../../components/ui';
import './admin.css';

const invalid = (error: unknown, field: string) =>
  error instanceof ApiError && error.fieldErrors.some((f) => f.field === field) ? true : undefined;

type UserProject = { id: number; name: string; role: string };

function CreateUserForm({ onCreated }: { onCreated: (u: User) => void }) {
  const { api } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [accountType, setAccountType] = useState<AccountType>('user');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await api.post<User>('/api/admin/users', { username, password, account_type: accountType });
      setUsername('');
      setPassword('');
      onCreated(u);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="新增帳號" className="adm-form" onSubmit={submit} noValidate>
      <ApiErrorAlert error={error} />
      <div className="field">
        <label htmlFor="new-username">帳號（必填）</label>
        <input
          id="new-username"
          className="input"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-required="true"
          aria-invalid={invalid(error, 'username')}
        />
      </div>
      <div className="field">
        <label htmlFor="new-password">初始密碼（必填）</label>
        <input
          id="new-password"
          className="input"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-required="true"
          aria-invalid={invalid(error, 'password')}
        />
      </div>
      <div className="field">
        <label htmlFor="new-account-type">帳號類型</label>
        <select id="new-account-type" className="select" value={accountType} onChange={(e) => setAccountType(e.target.value as AccountType)}>
          <option value="user">{ACCOUNT_TYPE_LABELS.user}</option>
          <option value="admin">{ACCOUNT_TYPE_LABELS.admin}</option>
        </select>
        <span className="field__hint">帳號類型（Admin／User）與專案角色分開；新增後到專案頁的「成員與權限」把他加入專案。</span>
      </div>
      <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
        新增帳號
      </button>
    </form>
  );
}

function ResetPasswordForm({ target, onDone, onCancel }: { target: User; onDone: () => void; onCancel: () => void }) {
  const { api } = useSession();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/admin/users/${target.id}/reset-password`, { new_password: password });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label={`重設密碼：${target.username}`} className="adm-form adm-subbox" onSubmit={submit} noValidate>
      <h3>重設密碼：{target.username}</h3>
      <ApiErrorAlert error={error} />
      <div className="field">
        <label htmlFor="reset-password">新密碼（必填）</label>
        <input
          id="reset-password"
          className="input"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-required="true"
          aria-invalid={invalid(error, 'new_password')}
          autoFocus
        />
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          確認重設
        </button>
        <button type="button" className="btn btn--secondary" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/** 每個帳號所屬的專案：逐一讀各專案成員（專案數不多）；讀不到就不顯示這一欄的內容。 */
function useUserProjects(nonce: unknown) {
  const { api } = useSession();
  return useResource(async () => {
    const projects = await api.get<Project[]>('/api/admin/projects');
    const lists = await Promise.all(
      projects.map(async (p) => ({ p, members: await api.get<MemberRow[]>(`/api/admin/projects/${p.id}/members`) })),
    );
    const out = new Map<number, UserProject[]>();
    for (const { p, members } of lists) {
      for (const m of members) {
        const list = out.get(m.user_id) ?? [];
        list.push({ id: p.id, name: p.name, role: ROLE_LABELS[m.role] ?? m.role });
        out.set(m.user_id, list);
      }
    }
    return out;
  }, [nonce]);
}

function ProjectLinks({ user, list }: { user: User; list: UserProject[] | undefined }) {
  if (!list) return <span className="text-muted">—</span>;
  if (list.length === 0) return <span className="text-muted">{user.account_type === 'admin' ? '（Admin 可檢視全部）' : '未加入'}</span>;
  return (
    <>
      {list.map((m, i) => (
        <span key={m.id}>
          {i > 0 && '、'}
          <Link to={`/admin/projects/${m.id}`}>{m.name}</Link>（{m.role}）
        </span>
      ))}
    </>
  );
}

/** 右側：選中帳號的編輯欄（設計稿 B18）。類型改在下拉選好後按「儲存變更」。 */
function UserPanel({
  target,
  projects,
  resetting,
  onClose,
  onSaveType,
  onReset,
  onResetDone,
  onResetCancel,
  onDelete,
}: {
  target: User;
  projects: UserProject[] | undefined;
  resetting: boolean;
  onClose: () => void;
  onSaveType: (t: AccountType) => void;
  onReset: () => void;
  onResetDone: () => void;
  onResetCancel: () => void;
  onDelete: () => void;
}) {
  const [type, setType] = useState<AccountType>(target.account_type);
  const changed = type !== target.account_type;
  return (
    <SidePanel title={target.username} onClose={onClose}>
      <div className="field">
        <label htmlFor="panel-account-type">類型</label>
        <select id="panel-account-type" className="select" value={type} onChange={(e) => setType(e.target.value as AccountType)}>
          <option value="user">{ACCOUNT_TYPE_LABELS.user}</option>
          <option value="admin">{ACCOUNT_TYPE_LABELS.admin}</option>
        </select>
      </div>
      <InfoList items={[{ label: '所屬專案', value: <ProjectLinks user={target} list={projects} /> }]} />
      <p className="field__hint">專案角色（PI、MD…）在各專案的「成員與權限」設定，與帳號類型分開。</p>
      {changed && (
        <div className="adm-summary" role="status">
          <strong>變更摘要</strong>
          <p>
            將帳號類型從 {ACCOUNT_TYPE_LABELS[target.account_type]} 改為 {ACCOUNT_TYPE_LABELS[type]}
          </p>
        </div>
      )}
      <div className="adm-stack-actions">
        <button type="button" className="btn btn--primary btn--block" disabled={!changed} onClick={() => onSaveType(type)}>
          儲存變更
        </button>
        <button type="button" className="btn btn--secondary btn--block" onClick={onReset}>
          重設密碼
        </button>
        {resetting && <ResetPasswordForm key={target.id} target={target} onCancel={onResetCancel} onDone={onResetDone} />}
        <button type="button" className="btn adm-btn--danger-outline btn--block" onClick={onDelete}>
          <Icon name="close" /> 刪除帳號
        </button>
      </div>
    </SidePanel>
  );
}

/** 帳號管理（設計稿 B18）：搜尋、類型篩選、表格，右側新增或編輯 */
export function UsersPage() {
  const { api } = useSession();
  const users = useResource(() => api.get<User[]>('/api/admin/users'));
  const memberships = useUserProjects(users.data);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | AccountType>('');

  const selected = users.data?.find((u) => u.id === selectedId) ?? null;

  function clearMessages() {
    setNotice(null);
    setError(null);
  }

  function select(u: User | null, reset = false) {
    clearMessages();
    setSelectedId(u?.id ?? null);
    setResetting(reset);
  }

  async function changeType(u: User, accountType: AccountType) {
    clearMessages();
    try {
      await api.patch<User>(`/api/admin/users/${u.id}`, { account_type: accountType });
      setNotice(`已將「${u.username}」改為 ${ACCOUNT_TYPE_LABELS[accountType]}`);
    } catch (e) {
      setError(e);
    }
    users.reload(); // 失敗時也重新載入，下拉選單回到伺服器上的值
  }

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setBusy(true);
    clearMessages();
    try {
      await api.delete(`/api/admin/users/${target.id}`);
      setNotice(`已刪除帳號「${target.username}」`);
      if (selectedId === target.id) setSelectedId(null);
      users.reload();
    } catch (e) {
      setError(e);
    } finally {
      setDeleting(null);
      setBusy(false);
    }
  }

  const needle = q.trim().toLowerCase();
  const rows = (users.data ?? []).filter((u) => {
    if (typeFilter && u.account_type !== typeFilter) return false;
    if (!needle) return true;
    const projects = memberships.data?.get(u.id) ?? [];
    return u.username.toLowerCase().includes(needle) || projects.some((p) => p.name.toLowerCase().includes(needle));
  });

  const side = selected ? (
    <UserPanel
      key={`${selected.id}-${selected.account_type}`}
      target={selected}
      projects={memberships.data ? (memberships.data.get(selected.id) ?? []) : undefined}
      resetting={resetting}
      onClose={() => select(null)}
      onSaveType={(t) => void changeType(selected, t)}
      onReset={() => {
        clearMessages();
        setResetting(true);
      }}
      onResetCancel={() => setResetting(false)}
      onResetDone={() => {
        setNotice(`已重設「${selected.username}」的密碼`);
        setResetting(false);
      }}
      onDelete={() => {
        clearMessages();
        setDeleting(selected);
      }}
    />
  ) : (
    <SidePanel title="新增帳號">
      <CreateUserForm
        onCreated={(u) => {
          clearMessages();
          setNotice(`已新增帳號「${u.username}」`);
          users.reload();
        }}
      />
    </SidePanel>
  );

  return (
    <div className="adm-page">
      <PageHeader
        title="帳號管理"
        subtitle="管理平台使用者帳號與帳號類型（Admin／User）；專案角色在各專案的「成員與權限」設定。"
        actions={
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              select(null);
              setTimeout(() => document.getElementById('new-username')?.focus(), 0);
            }}
          >
            新增帳號 ＋
          </button>
        }
      />
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={error} />
      <ApiErrorAlert error={users.error} />
      <SplitLayout side={side}>
        <section className="ui-card adm-card" aria-label="帳號清單">
          <div className="adm-toolbar">
            <div className="adm-search">
              <Icon name="search" />
              <input
                className="input"
                type="search"
                aria-label="搜尋帳號名稱或所屬專案"
                placeholder="搜尋帳號名稱或所屬專案"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <select
              className="select adm-toolbar__select"
              aria-label="帳號類型篩選"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as '' | AccountType)}
            >
              <option value="">全部類型</option>
              <option value="user">{ACCOUNT_TYPE_LABELS.user}</option>
              <option value="admin">{ACCOUNT_TYPE_LABELS.admin}</option>
            </select>
          </div>
          <div className="table-wrap">
            <table aria-label="帳號列表">
              <thead>
                <tr>
                  <th scope="col">帳號</th>
                  <th scope="col">帳號類型</th>
                  <th scope="col">所屬專案</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.loading && !users.data && (
                  <tr>
                    <td colSpan={4} role="status">
                      載入中…
                    </td>
                  </tr>
                )}
                {users.data && rows.length === 0 && (
                  <tr>
                    <td colSpan={4}>沒有符合條件的帳號。</td>
                  </tr>
                )}
                {rows.map((u) => (
                  <tr key={u.id} className={u.id === selectedId ? 'adm-row--selected' : undefined}>
                    <th scope="row">{u.username}</th>
                    <td>
                      <select
                        className="select adm-inline-select"
                        aria-label={`${u.username} 的帳號類型`}
                        value={u.account_type}
                        onChange={(e) => void changeType(u, e.target.value as AccountType)}
                      >
                        <option value="user">{ACCOUNT_TYPE_LABELS.user}</option>
                        <option value="admin">{ACCOUNT_TYPE_LABELS.admin}</option>
                      </select>
                    </td>
                    <td>
                      <ProjectLinks user={u} list={memberships.data ? (memberships.data.get(u.id) ?? []) : undefined} />
                    </td>
                    <td>
                      <div className="adm-row-actions">
                        <button type="button" className="adm-link-btn" aria-label={`編輯 ${u.username}`} onClick={() => select(u)}>
                          編輯 ›
                        </button>
                        <button type="button" className="adm-link-btn" aria-label={`重設 ${u.username} 的密碼`} onClick={() => select(u, true)}>
                          重設密碼
                        </button>
                        <button
                          type="button"
                          className="adm-link-btn adm-link-btn--danger"
                          aria-label={`刪除 ${u.username}`}
                          onClick={() => {
                            clearMessages();
                            setDeleting(u);
                          }}
                        >
                          刪除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </SplitLayout>

      {deleting && (
        <ConfirmDialog title="刪除帳號" confirmLabel="確認刪除" busy={busy} onConfirm={() => void confirmDelete()} onCancel={() => setDeleting(null)}>
          <p>
            確定要刪除帳號「<strong>{deleting.username}</strong>」嗎？該帳號的專案成員資格與登入身分會一併移除，此動作無法復原。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}


