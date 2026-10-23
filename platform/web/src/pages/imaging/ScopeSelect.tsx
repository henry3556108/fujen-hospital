import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import type { Scope } from './types';

/** 目前專案的資料範圍清單（GET /imaging/scopes）；專案切換時重新載入。 */
export function useScopes() {
  const { api, project } = useSession();
  const pid = project?.id;
  return useResource(() => (pid ? api.get<Scope[]>(`/api/projects/${pid}/imaging/scopes`) : Promise.resolve([] as Scope[])), [pid]);
}

/**
 * 選一個資料範圍（不選＝全部影像）。
 * scopes：useScopes() 的資料；value：目前選的範圍 id；onChange：選了哪個範圍（null＝全部）。
 */
export function ScopeSelect({
  scopes,
  value,
  onChange,
  id = 'scope-select',
  label = '資料範圍',
}: {
  scopes: Scope[];
  value: number | null;
  onChange: (scope: Scope | null) => void;
  id?: string;
  label?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="select"
        value={value ?? ''}
        onChange={(e) => onChange(scopes.find((s) => s.id === Number(e.target.value)) ?? null)}
      >
        <option value="">全部影像</option>
        {scopes.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}（{s.study_count} 筆）
          </option>
        ))}
        {value != null && !scopes.some((s) => s.id === value) && <option value={value}>資料範圍 {value}</option>}
      </select>
    </div>
  );
}
