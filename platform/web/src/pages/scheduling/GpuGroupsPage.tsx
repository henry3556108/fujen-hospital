import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { relabel } from '../../api/relabel';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SchedulingPage } from './SchedulingRoutes';
import { MODE_LABELS, POOL_LABELS, POOL_MODES, type GpuGroup, type GpuMode, type GpuPool } from './types';

const PATH = '/api/admin/gpu-groups';
const POOLS = Object.keys(POOL_MODES) as GpuPool[];

interface FormValues {
  name: string;
  pool: GpuPool;
  gpu_count: string;
}

const EMPTY: FormValues = { name: '', pool: 'gpu-exclusive', gpu_count: '1' };

function GroupForm({
  title,
  initial,
  editing,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: FormValues;
  editing: boolean;
  submitLabel: string;
  onSubmit: (v: FormValues) => Promise<void>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const idp = editing ? 'edit-group' : 'new-group';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
      if (!editing) setValues(EMPTY);
    } catch (err) {
      setError(relabel(err, { name: '群組名稱' }));
    } finally {
      setBusy(false);
    }
  }

  const nameInvalid = error instanceof ApiError && error.fieldErrors.some((f) => f.field === 'name');

  return (
    <form aria-label={title} className="card section" onSubmit={submit} noValidate>
      <h2>{title}</h2>
      <ApiErrorAlert error={error} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${idp}-name`}>群組名稱（必填）</label>
          <input
            id={`${idp}-name`}
            className="input"
            value={values.name}
            disabled={editing}
            onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
            aria-required="true"
            aria-invalid={nameInvalid || undefined}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idp}-pool`}>GPU 池</label>
          <select
            id={`${idp}-pool`}
            className="select"
            value={values.pool}
            onChange={(e) => setValues((v) => ({ ...v, pool: e.target.value as GpuPool }))}
            aria-describedby={`${idp}-pool-hint`}
          >
            {POOLS.map((p) => (
              <option key={p} value={p}>
                {POOL_LABELS[p]}
              </option>
            ))}
          </select>
          <span id={`${idp}-pool-hint`} className="field__hint">
            模式跟著 GPU 池：{MODE_LABELS[POOL_MODES[values.pool]]}
          </span>
        </div>
        <div className="field">
          <label htmlFor={`${idp}-count`}>GPU 數量</label>
          <input
            id={`${idp}-count`}
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            value={values.gpu_count}
            onChange={(e) => setValues((v) => ({ ...v, gpu_count: e.target.value }))}
          />
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

/** TC-C01-02 GPU 群組：建立、修改、刪除；仍綁定專案時不可刪（409）。 */
export function GpuGroupsPage() {
  const { api } = useSession();
  const groups = useResource(() => api.get<GpuGroup[]>(PATH));
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<GpuGroup | null>(null);
  const [deleting, setDeleting] = useState<GpuGroup | null>(null);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const body = (v: FormValues) => ({ pool: v.pool, mode: POOL_MODES[v.pool], gpu_count: Number(v.gpu_count) });

  async function create(v: FormValues) {
    const g = await api.post<GpuGroup>(PATH, { name: v.name, ...body(v) });
    setNotice(`已新增 GPU 群組「${g.name}」`);
    groups.reload();
  }

  async function update(v: FormValues) {
    if (!editing) return;
    const g = await api.patch<GpuGroup>(`${PATH}/${encodeURIComponent(editing.name)}`, body(v));
    setNotice(`已更新 GPU 群組「${g.name}」`);
    setEditing(null);
    groups.reload();
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await api.delete(`${PATH}/${encodeURIComponent(deleting.name)}`);
      setNotice(`已刪除 GPU 群組「${deleting.name}」`);
      groups.reload();
    } catch (e) {
      setDeleteError(e);
    } finally {
      setDeleting(null);
      setBusy(false);
    }
  }

  return (
    <SchedulingPage title="GPU 群組">
      <p className="text-muted">專案綁定一個 GPU 群組後，該專案的訓練工作會進入這個群組所在 GPU 池的佇列。</p>
      {notice && <Alert tone="success">{notice}</Alert>}
      <ApiErrorAlert error={deleteError} />
      <ApiErrorAlert error={groups.error} />
      <div className="table-wrap">
        <table aria-label="GPU 群組列表">
          <thead>
            <tr>
              <th scope="col">群組名稱</th>
              <th scope="col">GPU 池</th>
              <th scope="col">模式</th>
              <th scope="col" className="num">
                GPU 數量
              </th>
              <th scope="col">佇列</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {groups.loading && !groups.data && (
              <tr>
                <td colSpan={6} role="status">
                  載入中…
                </td>
              </tr>
            )}
            {groups.data?.map((g) => (
              <tr key={g.name}>
                <th scope="row">{g.name}</th>
                <td>{g.pool}</td>
                <td>{MODE_LABELS[g.mode as GpuMode] ?? g.mode}</td>
                <td className="num">{g.gpu_count}</td>
                <td>{g.queue}</td>
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
                        setDeleteError(null);
                        setDeleting(g);
                      }}
                    >
                      刪除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {groups.data?.length === 0 && (
              <tr>
                <td colSpan={6}>目前沒有 GPU 群組</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing ? (
        <GroupForm
          key={editing.name}
          title="編輯 GPU 群組"
          submitLabel="儲存"
          editing
          initial={{ name: editing.name, pool: editing.pool as GpuPool, gpu_count: String(editing.gpu_count) }}
          onSubmit={update}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <GroupForm title="新增 GPU 群組" submitLabel="新增群組" editing={false} initial={EMPTY} onSubmit={create} />
      )}

      {deleting && (
        <ConfirmDialog
          title="刪除 GPU 群組"
          confirmLabel="確認刪除"
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        >
          <p>
            確定要刪除 GPU 群組「<strong>{deleting.name}</strong>」嗎？仍有專案綁定時無法刪除。
          </p>
        </ConfirmDialog>
      )}
    </SchedulingPage>
  );
}
