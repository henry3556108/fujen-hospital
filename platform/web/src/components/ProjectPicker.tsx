import { useMe, useSession } from '../auth/SessionContext';
import { confirmLeave } from './unsaved';

/** 管理區頁內的專案選單（管理區頂端沒有「目前專案」）：選了等於切換目前專案。 */
export function ProjectPicker({ id, label }: { id: string; label: string }) {
  const me = useMe();
  const { project, selectProject } = useSession();
  if (me.projects.length === 0) return null;
  return (
    <div className="field field--inline">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="select"
        value={project?.id ?? ''}
        onChange={(e) => {
          if (confirmLeave('切換專案')) selectProject(Number(e.target.value));
        }}
      >
        {!project && <option value="">（請選擇）</option>}
        {me.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
