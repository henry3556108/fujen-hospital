import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { ROLE_LABELS, type LabelGroup, type MemberRow, type Project } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';

const invalid = (error: unknown, field: string) =>
  error instanceof ApiError && error.fieldErrors.some((f) => f.field === field) ? true : undefined;

function GroupForm({
  project,
  members,
  editing,
  onSaved,
  onCancel,
}: {
  project: Project;
  members: MemberRow[];
  editing: LabelGroup | null;
  onSaved: (g: LabelGroup, created: boolean) => void;
  onCancel: () => void;
}) {
  const { api } = useSession();
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [chosen, setChosen] = useState<number[]>(editing?.members.map((m) => m.user_id) ?? []);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const title = editing ? `編輯標註群組：${editing.name}` : '新增標註群組';
  // 群組成員已不在專案（理論上會被一併移除）時仍列出，避免儲存時默默丟掉
  const extra = (editing?.members ?? []).filter((m) => !members.some((x) => x.user_id === m.user_id));

  function toggle(id: number) {
    setChosen((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, description, member_ids: chosen };
      const base = `/api/admin/projects/${project.id}/labeling-groups`;
      const g = editing
        ? await api.patch<LabelGroup>(`${base}/${editing.id}`, body)
        : await api.post<LabelGroup>(base, body);
      onSaved(g, !editing);
      if (!editing) {
        setName('');
        setDescription('');
        setChosen([]);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label={title} className="card section" onSubmit={submit} noValidate>
      <h2>{title}</h2>
      <ApiErrorAlert error={error} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="group-name">群組名稱（必填）</label>
          <input
            id="group-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-required="true"
            aria-invalid={invalid(error, 'name')}
          />
        </div>
        <div className="field">
          <label htmlFor="group-description">說明</label>
          <input
            id="group-description"
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <fieldset aria-describedby="group-members-hint">
        <legend>成員</legend>
        <p id="group-members-hint" className="field__hint">
          只能從「{project.name}」的專案成員中挑選；要加入其他人，請先到「專案成員」把他加入專案。
        </p>
        {members.length === 0 && extra.length === 0 ? (
          <p className="text-muted">這個專案還沒有成員。</p>
        ) : (
          <div className="checkbox-row">
            {members.map((m) => (
              <label key={m.user_id} className="checkbox">
                <input type="checkbox" checked={chosen.includes(m.user_id)} onChange={() => toggle(m.user_id)} />
                <span>
                  {m.username}
                  <span className="text-muted">（{ROLE_LABELS[m.role] ?? m.role}）</span>
                </span>
              </label>
            ))}
            {extra.map((m) => (
              <label key={m.user_id} className="checkbox">
                <input type="checkbox" checked={chosen.includes(m.user_id)} onChange={() => toggle(m.user_id)} />
                <span>
                  {m.username}
                  <span className="text-muted">（已不是專案成員）</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {editing ? '儲存變更' : '新增群組'}
        </button>
        {editing && (
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}

/** fixedProjectId：管理區單一專案頁傳入路由的專案，不顯示頁內的專案下拉。 */
export function LabelGroupsPage({ fixedProjectId }: { fixedProjectId?: number } = {}) {
  const { api } = useSession();
  const projects = useResource(() => api.get<Project[]>('/api/admin/projects'));
  const [projectId, setProjectId] = useState<number | null>(null);
  const project = projects.data?.find((p) => p.id === (fixedProjectId ?? projectId ?? projects.data?.[0]?.id)) ?? null;
  const detail = useResource(async () => {
    if (!project) return null;
    const [groups, members] = await Promise.all([
      api.get<LabelGroup[]>(`/api/admin/projects/${project.id}/labeling-groups`),
      api.get<MemberRow[]>(`/api/admin/projects/${project.id}/members`),
    ]);
    return { groups, members };
  }, [project?.id]);
  const [editing, setEditing] = useState<LabelGroup | null>(null);
  const [deleting, setDeleting] = useState<LabelGroup | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function confirmDelete() {
    if (!deleting || !project) return;
    const target = deleting;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await api.delete(`/api/admin/projects/${project.id}/labeling-groups/${target.id}`);
      setNotice(`已刪除標註群組「${target.name}」`);
      if (editing?.id === target.id) setEditing(null);
      detail.reload();
    } catch (e) {
      setError(e);
    } finally {
      setDeleting(null);
      setBusy(false);
    }
  }

  const groups = detail.data?.groups ?? [];
  return (
    <div className="section">
      <h2>標註群組</h2>
      <p className="text-muted">每個專案可以建立多個標註群組，把負責標註的成員分組；影像標註分派工作時以群組為單位。</p>
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={error} />
      <ApiErrorAlert error={projects.error} />
      <ApiErrorAlert error={detail.error} />
      <div className="field" hidden={fixedProjectId !== undefined}>
        <label htmlFor="group-project">專案</label>
        <select
          id="group-project"
          className="select"
          value={project?.id ?? ''}
          onChange={(e) => {
            setProjectId(Number(e.target.value));
            setEditing(null);
            setNotice(null);
          }}
        >
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="table-wrap">
        <table aria-label="標註群組列表">
          <thead>
            <tr>
              <th scope="col">群組名稱</th>
              <th scope="col">說明</th>
              <th scope="col">成員</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {detail.loading && !detail.data && (
              <tr>
                <td colSpan={4} role="status">
                  載入中…
                </td>
              </tr>
            )}
            {detail.data && groups.length === 0 && (
              <tr>
                <td colSpan={4}>這個專案還沒有標註群組。</td>
              </tr>
            )}
            {groups.map((g) => (
              <tr key={g.id}>
                <th scope="row">{g.name}</th>
                <td>{g.description || '—'}</td>
                <td>{g.members.map((m) => m.username).join('、') || '（無）'}</td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      aria-label={`編輯 ${g.name}`}
                      onClick={() => {
                        setNotice(null);
                        setEditing(g);
                      }}
                    >
                      編輯
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      aria-label={`刪除 ${g.name}`}
                      onClick={() => {
                        setNotice(null);
                        setDeleting(g);
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

      {project && detail.data && (
        <GroupForm
          key={`${project.id}-${editing?.id ?? 'new'}`}
          project={project}
          members={detail.data.members}
          editing={editing}
          onCancel={() => setEditing(null)}
          onSaved={(g, created) => {
            setNotice(created ? `已新增標註群組「${g.name}」` : `已更新標註群組「${g.name}」`);
            setEditing(null);
            detail.reload();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="刪除標註群組"
          confirmLabel="確認刪除"
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        >
          <p>
            確定要刪除標註群組「<strong>{deleting.name}</strong>」嗎？成員仍留在專案中，只是不再屬於這個群組。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
