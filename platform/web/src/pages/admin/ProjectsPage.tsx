import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { Project } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PageHeader, SplitLayout } from '../../components/ui';
import './admin.css';
import type { GpuGroup } from '../scheduling/types';

export interface FormValues {
  name: string;
  description: string;
  gpu_group: string;
}

const EMPTY: FormValues = { name: '', description: '', gpu_group: '' };
const MODE_SHORT: Record<string, string> = { exclusive: '獨占', shared: '共享' };

/** GPU 群組選單的選項：不綁定＋已定義的群組；目前綁定的群組若已不存在也列出（標示），避免編輯時被默默改掉。 */
function groupOptions(groups: GpuGroup[] | null, current: string): { value: string; label: string }[] {
  const options = [{ value: '', label: '不綁定' }];
  for (const g of groups ?? []) options.push({ value: g.name, label: `${g.name}（${MODE_SHORT[g.mode] ?? g.mode}，${g.gpu_count} 張）` });
  if (current && !(groups ?? []).some((g) => g.name === current)) {
    options.push({ value: current, label: groups ? `${current}（已不存在）` : current });
  }
  return options;
}

function invalid(error: unknown, field: string): boolean {
  return error instanceof ApiError && error.fieldErrors.some((f) => f.field === field);
}

export function ProjectForm({
  title,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  groups,
  groupsError,
  keepValues = false,
}: {
  title: string;
  initial: FormValues;
  submitLabel: string;
  onSubmit: (v: FormValues) => Promise<void>;
  onCancel?: () => void;
  groups: GpuGroup[] | null;
  groupsError: unknown;
  /** 儲存後保留欄位內容（單一專案頁） */
  keepValues?: boolean;
}) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const idp = title === '新增專案' ? 'new' : 'edit';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
      if (!onCancel && !keepValues) setValues(EMPTY);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof FormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  return (
    <form aria-label={title} className="ui-card adm-form-card" onSubmit={submit} noValidate>
      <h2 className="ui-card__title">{title}</h2>
      <ApiErrorAlert error={error} />
      <ApiErrorAlert error={groupsError} />
      <div className="adm-form">
        <div className="field">
          <label htmlFor={`${idp}-name`}>專案名稱（必填）</label>
          <input
            id={`${idp}-name`}
            className="input"
            value={values.name}
            onChange={set('name')}
            aria-required="true"
            aria-invalid={invalid(error, 'name') || undefined}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idp}-description`}>說明</label>
          <input id={`${idp}-description`} className="input" value={values.description} onChange={set('description')} />
        </div>
        <div className="field">
          <label htmlFor={`${idp}-gpu`}>GPU 群組</label>
          <select
            id={`${idp}-gpu`}
            className="select"
            value={values.gpu_group}
            onChange={set('gpu_group')}
            aria-describedby={`${idp}-gpu-hint`}
          >
            {groupOptions(groups, values.gpu_group).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span id={`${idp}-gpu-hint`} className="field__hint">
            群組在「GPU／CPU 伺服器管理 › GPU 群組」定義
          </span>
        </div>
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </form>
  );
}

export function ProjectsPage() {
  const { api } = useSession();
  const projects = useResource(() => api.get<Project[]>('/api/admin/projects'));
  const groups = useResource(() => api.get<GpuGroup[]>('/api/admin/gpu-groups'));
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function create(v: FormValues) {
    const p = await api.post<Project>('/api/admin/projects', {
      name: v.name,
      description: v.description,
      gpu_group: v.gpu_group || null,
    });
    setNotice(`已新增專案「${p.name}」`);
    projects.reload();
  }

  async function update(v: FormValues) {
    if (!editing) return;
    const p = await api.patch<Project>(`/api/admin/projects/${editing.id}`, {
      name: v.name,
      description: v.description,
      gpu_group: v.gpu_group || null,
    });
    setNotice(`已更新專案「${p.name}」`);
    setEditing(null);
    projects.reload();
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api.delete(`/api/admin/projects/${deleting.id}`);
      setNotice(`已刪除專案「${deleting.name}」`);
      setDeleting(null);
      projects.reload();
    } catch (e) {
      setDeleteError(e);
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  }

  const form = editing ? (
    <ProjectForm
      key={editing.id}
      title="編輯專案"
      submitLabel="儲存"
      initial={{ name: editing.name, description: editing.description, gpu_group: editing.gpu_group ?? '' }}
      onSubmit={update}
      onCancel={() => setEditing(null)}
      groups={groups.data}
      groupsError={groups.error}
    />
  ) : (
    <ProjectForm title="新增專案" submitLabel="新增專案" initial={EMPTY} onSubmit={create} groups={groups.data} groupsError={groups.error} />
  );

  return (
    <div className="adm-page">
      <PageHeader title="專案管理" subtitle="點專案名稱設定 GPU 群組、成員與權限、標註群組、Accession Number 清單。" />
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={deleteError} />
      <ApiErrorAlert error={projects.error} />
      <SplitLayout side={<div className="adm-side">{form}</div>}>
      <section className="ui-card adm-card" aria-labelledby="projects-title">
        <div className="ui-card__head">
          <h2 id="projects-title" className="ui-card__title">
            專案列表{projects.data ? `（${projects.data.length} 個）` : ''}
          </h2>
        </div>
      <div className="table-wrap">
        <table aria-label="專案列表">
          <thead>
            <tr>
              <th scope="col">專案名稱</th>
              <th scope="col">說明</th>
              <th scope="col">GPU 群組</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {projects.loading && !projects.data && (
              <tr>
                <td colSpan={4} role="status">
                  載入中…
                </td>
              </tr>
            )}
            {projects.data?.map((p) => (
              <tr key={p.id}>
                <th scope="row">
                  <Link to={`/admin/projects/${p.id}`}>{p.name}</Link>
                </th>
                <td>{p.description || '—'}</td>
                <td>{p.gpu_group ?? '未綁定'}</td>
                <td>
                  <div className="adm-row-btns">
                    <Link to={`/admin/projects/${p.id}/members`} className="btn btn--secondary btn--small">
                      成員與權限
                    </Link>
                    <button
                      type="button"
                      className="btn btn--secondary btn--small"
                      aria-label={`編輯 ${p.name}`}
                      onClick={() => {
                        setNotice(null);
                        setEditing(p);
                      }}
                    >
                      編輯
                    </button>
                    <button
                      type="button"
                      className="btn btn--small adm-btn--danger-outline"
                      aria-label={`刪除 ${p.name}`}
                      onClick={() => {
                        setNotice(null);
                        setDeleting(p);
                      }}
                    >
                      刪除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {projects.data?.length === 0 && (
              <tr>
                <td colSpan={4}>目前沒有專案</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      </section>
      </SplitLayout>

      {deleting && (
        <ConfirmDialog
          title="刪除專案"
          confirmLabel="確認刪除"
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        >
          <p>
            確定要刪除專案「<strong>{deleting.name}</strong>」嗎？專案成員資格會一併移除，此動作無法復原。
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
