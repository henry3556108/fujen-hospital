import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { Link } from 'react-router-dom';
import { ACCOUNT_TYPE_LABELS, ROLE_LABELS, type AccountType, type MemberRow, type Project, type User } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';

const invalid = (error: unknown, field: string) =>
  error instanceof ApiError && error.fieldErrors.some((f) => f.field === field) ? true : undefined;

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
    <form aria-label="新增帳號" className="card section" onSubmit={submit} noValidate>
      <h2>新增帳號</h2>
      <ApiErrorAlert error={error} />
      <div className="form-grid">
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
          <select
            id="new-account-type"
            className="select"
            value={accountType}
            onChange={(e) => setAccountType(e.target.value as AccountType)}
          >
            <option value="user">{ACCOUNT_TYPE_LABELS.user}</option>
            <option value="admin">{ACCOUNT_TYPE_LABELS.admin}</option>
          </select>
        </div>
      </div>
      <button type="submit" className="btn btn--primary" disabled={busy}>
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
    <form aria-label={`重設密碼：${target.username}`} className="card section" onSubmit={submit} noValidate>
      <h2>重設密碼：{target.username}</h2>
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
    const out = new Map<number, { id: number; name: string; role: string }[]>();
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

export function UsersPage() {
  const { api } = useSession();
  const users = useResource(() => api.get<User[]>('/api/admin/users'));
  const memberships = useUserProjects(users.data);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);

  function clearMessages() {
    setNotice(null);
    setError(null);
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
      users.reload();
    } catch (e) {
      setError(e);
    } finally {
      setDeleting(null);
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <h1>帳號</h1>
      <p className="text-muted">
        平台的所有帳號與帳號類型（Admin／User）；可新增帳號、變更類型、重設密碼與刪除。帳號在各專案的角色請到「專案」頁的「成員與權限」設定。
      </p>
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={error} />
      <ApiErrorAlert error={users.error} />
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
            {users.data?.map((u) => (
              <tr key={u.id}>
                <th scope="row">{u.username}</th>
                <td>
                  <select
                    className="select"
                    aria-label={`${u.username} 的帳號類型`}
                    value={u.account_type}
                    onChange={(e) => void changeType(u, e.target.value as AccountType)}
                  >
                    <option value="user">{ACCOUNT_TYPE_LABELS.user}</option>
                    <option value="admin">{ACCOUNT_TYPE_LABELS.admin}</option>
                  </select>
                </td>
                <td>
                  {memberships.data ? (
                    (memberships.data.get(u.id) ?? []).length === 0 ? (
                      <span className="text-muted">{u.account_type === 'admin' ? '（Admin 可檢視全部）' : '未加入'}</span>
                    ) : (
                      (memberships.data.get(u.id) ?? []).map((m, i) => (
                        <span key={m.id}>
                          {i > 0 && '、'}
                          <Link to={`/admin/projects/${m.id}`}>{m.name}</Link>（{m.role}）
                        </span>
                      ))
                    )
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      aria-label={`重設 ${u.username} 的密碼`}
                      onClick={() => {
                        clearMessages();
                        setResetting(u);
                      }}
                    >
                      重設密碼
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
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

      {resetting && (
        <ResetPasswordForm
          key={resetting.id}
          target={resetting}
          onCancel={() => setResetting(null)}
          onDone={() => {
            setNotice(`已重設「${resetting.username}」的密碼`);
            setResetting(null);
          }}
        />
      )}

      <CreateUserForm
        onCreated={(u) => {
          clearMessages();
          setNotice(`已新增帳號「${u.username}」`);
          users.reload();
        }}
      />

      {deleting && (
        <ConfirmDialog
          title="刪除帳號"
          confirmLabel="確認刪除"
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        >
          <p>
            確定要刪除帳號「<strong>{deleting.username}</strong>」嗎？該帳號的專案成員資格與登入身分會一併移除，此動作無法復原。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
