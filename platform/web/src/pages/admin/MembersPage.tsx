import { useState, type FormEvent } from 'react';
import { ENTRIES } from '../../access/entries';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLES,
  ROLE_LABELS,
  type Membership,
  type MemberRow,
  type Permission,
  type Project,
  type Role,
  type User,
} from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';

/** 每個權限對應開放的入口，讓 Admin 勾選時知道影響範圍。 */
function unlocks(p: Permission): string {
  return ENTRIES.filter((e) => e.rule.kind === 'permission' && e.rule.permission === p)
    .map((e) => e.label)
    .join('、');
}

const ordered = (ps: Iterable<Permission>) => {
  const set = new Set(ps);
  return PERMISSIONS.filter((p) => set.has(p));
};

const permText = (ps: Permission[]) => ordered(ps).map((p) => PERMISSION_LABELS[p]).join('、') || '（無）';
const roleText = (r: Role) => ROLE_LABELS[r] ?? r;
const sameSet = (a: Permission[], b: Permission[]) => ordered(a).join() === ordered(b).join();

interface PendingChange {
  project: Project;
  user: User;
  current: MemberRow;
}

/** fixedProjectId：管理區單一專案頁傳入路由的專案，不顯示頁內的專案下拉。 */
export function MembersPage({ fixedProjectId }: { fixedProjectId?: number } = {}) {
  const { api } = useSession();
  const data = useResource(async () => {
    const [projects, users] = await Promise.all([
      api.get<Project[]>('/api/admin/projects'),
      api.get<User[]>('/api/admin/users'),
    ]);
    return { projects, users };
  });
  const projects = data.data?.projects ?? [];
  const users = data.data?.users ?? [];

  const [projectId, setProjectId] = useState<number | null>(null);
  const selectedProject = projects.find((p) => p.id === (fixedProjectId ?? projectId ?? projects[0]?.id)) ?? null;
  const members = useResource(
    () =>
      selectedProject
        ? api.get<MemberRow[]>(`/api/admin/projects/${selectedProject.id}/members`)
        : Promise.resolve([] as MemberRow[]),
    [selectedProject?.id],
  );
  const rows = members.data ?? [];

  const [userId, setUserId] = useState<number | null>(null);
  const [role, setRole] = useState<Role>('viewer');
  const [perms, setPerms] = useState<Permission[]>(DEFAULT_ROLE_PERMISSIONS.viewer);
  const [formError, setFormError] = useState<unknown>(null);
  const [pageError, setPageError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<{ project: Project; user: User } | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);

  const selectedUser = users.find((u) => u.id === userId) ?? null;
  const current = selectedUser ? (rows.find((r) => r.user_id === selectedUser.id) ?? null) : null;

  function clearMessages() {
    setNotice(null);
    setFormError(null);
    setPageError(null);
  }

  /** 選帳號時帶入目前的角色與權限；還不是成員才帶入 Viewer 預設。 */
  function chooseUser(id: number | null, list: MemberRow[] = rows) {
    setUserId(id);
    const row = id === null ? null : list.find((r) => r.user_id === id);
    if (row) {
      setRole(row.role);
      setPerms(ordered(row.permissions));
    } else {
      setRole('viewer');
      setPerms([...DEFAULT_ROLE_PERMISSIONS.viewer]);
    }
  }

  function chooseProject(id: number) {
    clearMessages();
    setProjectId(id);
    setUserId(null);
    setRole('viewer');
    setPerms([...DEFAULT_ROLE_PERMISSIONS.viewer]);
  }

  function changeRole(r: Role) {
    setRole(r);
    setPerms([...DEFAULT_ROLE_PERMISSIONS[r]]); // 換角色時權限重設為該角色預設
  }

  function toggle(p: Permission) {
    setPerms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : ordered([...cur, p])));
  }

  async function put(project: Project, user: User) {
    clearMessages();
    setBusy(true);
    try {
      const m = await api.put<Membership>(`/api/admin/projects/${project.id}/members/${user.id}`, {
        role,
        permissions: ordered(perms),
      });
      setNotice(`已將「${user.username}」設定為「${project.name}」的 ${roleText(m.role)}（權限：${permText(m.permissions)}）`);
      members.reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!selectedProject || !selectedUser) return;
    if (current && current.role !== role) {
      setPending({ project: selectedProject, user: selectedUser, current }); // 角色變更先確認
      return;
    }
    void put(selectedProject, selectedUser);
  }

  function edit(r: MemberRow) {
    clearMessages();
    chooseUser(r.user_id);
    document.getElementById('member-user')?.focus();
  }

  async function confirmRemove() {
    if (!removing) return;
    const { project, user } = removing;
    clearMessages();
    setBusy(true);
    try {
      await api.delete(`/api/admin/projects/${project.id}/members/${user.id}`);
      setNotice(`已將「${user.username}」移出「${project.name}」`);
      if (userId === user.id) chooseUser(user.id, []);
      members.reload();
    } catch (err) {
      setPageError(err);
    } finally {
      setRemoving(null);
      setBusy(false);
    }
  }

  const unchanged = !!current && current.role === role && sameSet(current.permissions, perms);

  return (
    <div className="section">
      <h2>成員與權限</h2>
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={pageError} />
      <ApiErrorAlert error={data.error} />

      <div className="field" hidden={fixedProjectId !== undefined}>
        <label htmlFor="member-project">專案</label>
        <select
          id="member-project"
          className="select"
          value={selectedProject?.id ?? ''}
          onChange={(e) => chooseProject(Number(e.target.value))}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <ApiErrorAlert error={members.error} />
      <div className="table-wrap">
        <table aria-label="目前的專案成員">
          <thead>
            <tr>
              <th scope="col">帳號</th>
              <th scope="col">角色</th>
              <th scope="col">權限</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {members.loading && !members.data && (
              <tr>
                <td colSpan={4} role="status">
                  載入中…
                </td>
              </tr>
            )}
            {members.data && rows.length === 0 && (
              <tr>
                <td colSpan={4}>這個專案還沒有成員。</td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.user_id}>
                <th scope="row">{r.username}</th>
                <td>{roleText(r.role)}</td>
                <td>
                  {permText(r.permissions)}
                  {r.unknown_permissions?.length ? (
                    <span className="text-muted">（另有無法辨識的權限：{r.unknown_permissions.join('、')}，請重新設定）</span>
                  ) : null}
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      aria-label={`編輯 ${r.username}`}
                      onClick={() => edit(r)}
                    >
                      編輯
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      aria-label={`移除 ${r.username}`}
                      onClick={() => {
                        clearMessages();
                        const user = users.find((u) => u.id === r.user_id);
                        if (selectedProject && user) setRemoving({ project: selectedProject, user });
                      }}
                    >
                      移除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form aria-label="設定專案成員" className="card section" onSubmit={save} noValidate>
        <h2>新增或調整成員</h2>
        <ApiErrorAlert error={formError} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="member-user">帳號</label>
            <select
              id="member-user"
              className="select"
              value={selectedUser?.id ?? ''}
              aria-describedby="member-user-hint"
              onChange={(e) => {
                clearMessages();
                chooseUser(e.target.value ? Number(e.target.value) : null);
              }}
            >
              <option value="">請選擇帳號</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                  {rows.some((r) => r.user_id === u.id) ? '（已是成員）' : ''}
                </option>
              ))}
            </select>
            <span id="member-user-hint" className="field__hint" role="status">
              {!selectedUser
                ? '選擇帳號後，會帶入他在這個專案目前的角色與權限。'
                : current
                  ? `「${selectedUser.username}」目前是 ${roleText(current.role)}，權限：${permText(current.permissions)}`
                  : `「${selectedUser.username}」還不是這個專案的成員，儲存後加入。`}
            </span>
          </div>
          <div className="field">
            <label htmlFor="member-role">角色</label>
            <select
              id="member-role"
              className="select"
              value={role}
              disabled={!selectedUser}
              onChange={(e) => changeRole(e.target.value as Role)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset aria-describedby="perm-hint" disabled={!selectedUser}>
          <legend>權限</legend>
          <p id="perm-hint" className="field__hint">
            預設依角色帶入（需與甲方確認），可逐項調整；更換角色會重設為該角色預設。
          </p>
          <div className="checkbox-row">
            {PERMISSIONS.map((p) => (
              <label key={p} className="checkbox">
                <input type="checkbox" checked={perms.includes(p)} onChange={() => toggle(p)} />
                <span>
                  {PERMISSION_LABELS[p]}
                  <span className="text-muted">（{unlocks(p)}）</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="row-actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || !selectedProject || !selectedUser || unchanged}
          >
            {current ? '儲存變更' : '加入專案'}
          </button>
          {current && (
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => chooseUser(current.user_id)}>
              還原為目前設定
            </button>
          )}
        </div>
      </form>

      {pending && (
        <ConfirmDialog
          title="變更角色"
          confirmLabel="確認變更"
          busy={busy}
          onConfirm={() => void put(pending.project, pending.user)}
          onCancel={() => setPending(null)}
        >
          <p>
            確定要把「<strong>{pending.user.username}</strong>」在專案「<strong>{pending.project.name}</strong>」的角色從{' '}
            <strong>{roleText(pending.current.role)}</strong> 改為 <strong>{roleText(role)}</strong> 嗎？
          </p>
          <p>
            權限：{permText(pending.current.permissions)} → {permText(perms)}。變更立即生效。
          </p>
        </ConfirmDialog>
      )}

      {removing && (
        <ConfirmDialog
          title="移除專案成員"
          confirmLabel="確認移除"
          busy={busy}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoving(null)}
        >
          <p>
            確定要將「<strong>{removing.user.username}</strong>」移出專案「<strong>{removing.project.name}</strong>」嗎？移除後立即失去該專案的存取權，也會移出這個專案的標註群組。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
