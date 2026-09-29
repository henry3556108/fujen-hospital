import { useState } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { RESOURCE_TYPES, resourceLabel, type FhirSummary, type ResourcePage, type ResourceType } from './types';

const PAGE = 20;

export function ResourcesPage() {
  const { api, project } = useSession();
  const base = `/api/projects/${project!.id}/fhir`;
  const [type, setType] = useState<ResourceType>('Patient');
  const [offset, setOffset] = useState(0);
  const summary = useResource(() => api.get<FhirSummary>(`${base}/summary`), [base]);
  const page = useResource(
    () => api.get<ResourcePage>(`${base}/resources/${type}?count=${PAGE}&offset=${offset}`),
    [base, type, offset],
  );

  return (
    <div className="section">
      <ApiErrorAlert error={summary.error} />
      <ul className="fhir-stats" aria-label="資源筆數">
        {RESOURCE_TYPES.map((t) => (
          <li key={t} className="card fhir-stat">
            <span className="fhir-stat__value">{summary.data ? summary.data.counts[t] : '…'}</span>
            <span className="fhir-stat__label">{t}</span>
          </li>
        ))}
      </ul>

      <div className="field field--inline">
        <label htmlFor="fhir-type">資源型別</label>
        <select
          id="fhir-type"
          className="select"
          value={type}
          onChange={(e) => {
            setType(e.target.value as ResourceType);
            setOffset(0);
          }}
        >
          {RESOURCE_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <ApiErrorAlert error={page.error} />
      <div className="table-wrap">
        <table aria-label={`${type} 列表`}>
          <thead>
            <tr>
              <th scope="col">資源編號</th>
              <th scope="col">識別碼</th>
              <th scope="col">摘要</th>
            </tr>
          </thead>
          <tbody>
            {page.loading && !page.data && (
              <tr>
                <td colSpan={3} role="status">
                  載入中…
                </td>
              </tr>
            )}
            {page.data?.items.map((r) => (
              <tr key={r.id}>
                <th scope="row">{`${r.resourceType}/${r.id}`}</th>
                <td className="fhir-code">{r.identifier?.[0]?.value ?? '—'}</td>
                <td>{resourceLabel(r)}</td>
              </tr>
            ))}
            {page.data?.items.length === 0 && (
              <tr>
                <td colSpan={3}>這個租戶還沒有 {type}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {page.data && page.data.total > PAGE && (
        <div className="row-actions" aria-label="分頁">
          <button
            type="button"
            className="btn btn--secondary btn--small"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            上一頁
          </button>
          <span className="text-muted">
            第 {offset + 1}–{Math.min(offset + PAGE, page.data.total)} 筆，共 {page.data.total} 筆
          </span>
          <button
            type="button"
            className="btn btn--secondary btn--small"
            disabled={offset + PAGE >= page.data.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            下一頁
          </button>
        </div>
      )}
    </div>
  );
}
