import { useState, type FormEvent } from 'react';
import { ENTRIES } from '../../access/entries';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLES,
  ROLE_LABELS,
  type Membership,
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

interface SessionRow extends Membership {
  projectName: string;
  username: string;
}

export function MembersPage() {
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
  const [userId, setUserId] = useState<number | null>(null);
  const [role, setRole] = useState<Role>('viewer');
  const [perms, setPerms] = useState<Permission[]>(DEFAULT_ROLE_PERMISSIONS.viewer);
  const [formError, setFormError] = useState<unknown>(null);
  const [pageError, setPageError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [removing, setRemoving] = useState<{ project: Project; user: User } | null>(null);

  const selectedProject = projects.find((p) => p.id === (projectId ?? projects[0]?.id)) ?? null;
  const selectedUser = users.find((u) => u.id === (userId ?? users[0]?.id)) ?? null;

  function changeRole(r: Role) {
    setRole(r);
    setPerms([...DEFAULT_ROLE_PERMISSIONS[r]]); // 換角色時權限重設為該角色預設
  }

  function toggle(p: Permission) {
    setPerms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : ordered([...cur, p])));
  }

  function clearMessages() {
    setNotice(null);
    setFormError(null);
    setPageError(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!selectedProject || !selectedUser) return;
    clearMessages();
    setBusy(true);
    try {
      const m = await api.put<Membership>(`/api/admin/projects/${selectedProject.id}/members/${selectedUser.id}`, {
        role,
        permissions: ordered(perms),
      });
      const row: SessionRow = { ...m, projectName: selectedProject.name, username: selectedUser.username };
      setRows((cur) => [row, ...cur.filter((r) => !(r.project_id === m.project_id && r.user_id === m.user_id))]);
      setNotice(`已將「${selectedUser.username}」設定為「${selectedProject.name}」的 ${ROLE_LABELS[m.role]}`);
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
    }
  }

  function edit(r: SessionRow) {
    clearMessages();
    setProjectId(r.project_id);
    setUserId(r.user_id);
    setRole(r.role);
    setPerms(ordered(r.permissions));
    document.getElementById('member-project')?.focus();
  }

  async function confirmRemove() {
    if (!removing) return;
    const { project, user } = removing;
    clearMessages();
    setBusy(true);
    try {
      await api.delete(`/api/admin/projects/${project.id}/members/${user.id}`);
      setRows((cur) => cur.filter((r) => !(r.project_id === project.id && r.user_id === user.id)));
      setNotice(`已將「${user.username}」移出「${project.name}」`);
    } catch (err) {
      setPageError(err);
    } finally {
      setRemoving(null);
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <Alert tone="info" title="目前限制">
        後端尚未提供列出專案成員的 API（需 WP1a 補上），本頁只列出本次操作過的成員；指定專案與帳號即可新增、調整或移除成員。
      </Alert>
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={pageError} />
      <ApiErrorAlert error={data.error} />

      <form aria-label="設定專案成員" className="card section" onSubmit={save} noValidate>
        <h2>設定專案成員</h2>
        <ApiErrorAlert error={formError} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="member-project">專案</label>
            <select
              id="member-project"
              className="select"
              value={selectedProject?.id ?? ''}
              onChange={(e) => setProjectId(Number(e.target.value))}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="member-user">帳號</label>
            <select
              id="member-user"
              className="select"
              value={selectedUser?.id ?? ''}
              onChange={(e) => setUserId(Number(e.target.value))}
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="member-role">角色</label>
            <select id="member-role" className="select" value={role} onChange={(e) => changeRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset aria-describedby="perm-hint">
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
          <button type="submit" className="btn btn--primary" disabled={busy || !selectedProject || !selectedUser}>
            儲存成員設定
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy || !selectedProject || !selectedUser}
            onClick={() => {
              clearMessages();
              if (selectedProject && selectedUser) setRemoving({ project: selectedProject, user: selectedUser });
            }}
          >
            從專案移除
          </button>
        </div>
      </form>

      {rows.length > 0 && (
        <div className="table-wrap">
          <table aria-label="本次設定的成員">
            <thead>
              <tr>
                <th scope="col">帳號</th>
                <th scope="col">專案</th>
                <th scope="col">角色</th>
                <th scope="col">權限</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.project_id}-${r.user_id}`}>
                  <th scope="row">{r.username}</th>
                  <td>{r.projectName}</td>
                  <td>{ROLE_LABELS[r.role]}</td>
                  <td>{permText(r.permissions)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn--secondary btn--small"
                        aria-label={`編輯 ${r.username}（${r.projectName}）`}
                        onClick={() => edit(r)}
                      >
                        編輯
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary btn--small"
                        aria-label={`移除 ${r.username}（${r.projectName}）`}
                        onClick={() => {
                          const project = projects.find((p) => p.id === r.project_id);
                          const user = users.find((u) => u.id === r.user_id);
                          if (project && user) setRemoving({ project, user });
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
            確定要將「<strong>{removing.user.username}</strong>」移出專案「<strong>{removing.project.name}</strong>」嗎？移除後立即失去該專案的存取權。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
