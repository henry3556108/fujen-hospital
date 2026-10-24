import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert, Card, Icon, Pagination, SegmentedTabs, tabPanelId, type IconName } from '../../components/ui';
import { RESOURCE_TYPES, resourceLabel, type FhirGraph, type FhirSummary, type ResourcePage, type ResourceType } from './types';

const PAGE = 20;

export const TYPE_ICONS: Record<ResourceType, IconName> = { Patient: 'user', Encounter: 'clock', Observation: 'doc' };

function TypeCell({ type }: { type: ResourceType }) {
  return (
    <span className="fhir-type">
      <Icon name={TYPE_ICONS[type]} className={`fhir-type__icon fhir-type__icon--${type}`} />
      {type}
    </span>
  );
}

/** 病人中心的關聯摘要：Patient 在上，各型別資源數在下（完整的圖在「關聯圖」分頁） */
function PatientSummary({ graph }: { graph: FhirGraph }) {
  const patient = graph.nodes.find((n) => n.type === 'Patient');
  const others = RESOURCE_TYPES.filter((t) => t !== 'Patient').map((t) => ({
    type: t,
    nodes: graph.nodes.filter((n) => n.type === t),
  }));
  return (
    <div className="fhir-tree" role="group" aria-label={`病人 ${graph.patient} 的資源關聯`}>
      <div className="fhir-tree__node fhir-tree__node--Patient">
        <Icon name="user" />
        <strong>Patient</strong>
        <span>{graph.patient}</span>
      </div>
      <div className="fhir-tree__links" aria-hidden="true" />
      <div className="fhir-tree__row">
        {others.map(({ type, nodes }) => (
          <div key={type} className={`fhir-tree__node fhir-tree__node--${type}`}>
            <Icon name={TYPE_ICONS[type]} />
            <strong>{type}</strong>
            {nodes[0] && <span className="fhir-code">{nodes[0].id.split('/')[1]}</span>}
            <span>（{nodes.length} 筆）</span>
          </div>
        ))}
      </div>
      {!patient && <p className="text-muted">找不到 Patient 資源。</p>}
    </div>
  );
}

/** 以病歷號查詢：列出這位病人的所有資源＋關聯摘要（設計稿 B24） */
function PatientResults({ patient }: { patient: string }) {
  const { api, project } = useSession();
  const graph = useResource(
    () => api.get<FhirGraph>(`/api/projects/${project!.id}/fhir/graph?patient=${encodeURIComponent(patient)}`),
    [project!.id, patient],
  );
  if (graph.error) return <ApiErrorAlert error={graph.error} />;
  if (!graph.data) return <p role="status">載入中…</p>;
  const g = graph.data;
  return (
    <div className="fhir-split">
      <Card title={`FHIR 資源列表（共 ${g.nodes.length} 筆）`} flush>
        <div className="table-wrap">
          <table aria-label={`病人 ${patient} 的資源`}>
            <thead>
              <tr>
                <th scope="col">資源類型</th>
                <th scope="col">資源 ID</th>
                <th scope="col">識別碼</th>
                <th scope="col">摘要</th>
              </tr>
            </thead>
            <tbody>
              {g.nodes.map((n) => (
                <tr key={n.id} className={n.type === 'Patient' ? 'fhir-row--selected' : undefined}>
                  <td>
                    <TypeCell type={n.type} />
                  </td>
                  <th scope="row" className="fhir-code">
                    {n.id}
                  </th>
                  <td className="fhir-code">{n.identifier || '—'}</td>
                  <td>{n.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {g.truncated && <p className="text-muted fhir-card-note">資源太多，只顯示每種型別的前 200 筆。</p>}
      </Card>
      <Card
        title="病人關聯圖（Patient 中心）"
        extra={
          <Link to="/admin/fhir/graph" className="fhir-more">
            查看完整關聯圖 ›
          </Link>
        }
      >
        <PatientSummary graph={g} />
      </Card>
    </div>
  );
}

export function ResourcesPage() {
  const { api, project } = useSession();
  const base = `/api/projects/${project!.id}/fhir`;
  const [type, setType] = useState<ResourceType>('Patient');
  const [offset, setOffset] = useState(0);
  const [input, setInput] = useState('');
  const [patient, setPatient] = useState('');
  const summary = useResource(() => api.get<FhirSummary>(`${base}/summary`), [base]);
  const page = useResource(
    () => api.get<ResourcePage>(`${base}/resources/${type}?count=${PAGE}&offset=${offset}`),
    [base, type, offset],
  );

  function search(e: FormEvent) {
    e.preventDefault();
    setPatient(input.trim());
  }

  return (
    <div className="stack">
      <ApiErrorAlert error={summary.error} />
      <ul className="fhir-stats" aria-label="資源筆數">
        {RESOURCE_TYPES.map((t) => (
          <li key={t} className="ui-stat fhir-stat">
            <span className="ui-stat__icon ui-stat__icon--primary" aria-hidden="true">
              <Icon name={TYPE_ICONS[t]} />
            </span>
            <span className="ui-stat__text">
              <span className="ui-stat__label fhir-stat__label">{t}</span>
              <span className="ui-stat__value fhir-stat__value">{summary.data ? summary.data.counts[t] : '…'}</span>
            </span>
          </li>
        ))}
      </ul>

      <form className="fhir-search" aria-label="以病歷號查詢資源" onSubmit={search}>
        <label htmlFor="fhir-patient">病歷號</label>
        <input
          id="fhir-patient"
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="例如 SYN-42-0001"
        />
        {patient && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              setInput('');
              setPatient('');
            }}
          >
            清除
          </button>
        )}
        <button type="submit" className="btn btn--primary" disabled={!input.trim()}>
          查詢資源
        </button>
      </form>

      {patient ? (
        <PatientResults key={patient} patient={patient} />
      ) : (
        <Card
          title={`FHIR 資源列表${page.data ? `（共 ${page.data.total} 筆）` : ''}`}
          flush
          extra={
            <SegmentedTabs
              label="資源型別"
              idPrefix="fhir-type"
              items={RESOURCE_TYPES.map((t) => ({ key: t, label: t }))}
              value={type}
              onChange={(k) => {
                setType(k as ResourceType);
                setOffset(0);
              }}
            />
          }
        >
          <ApiErrorAlert error={page.error} />
          <div className="table-wrap" role="tabpanel" id={tabPanelId('fhir-type', type)} aria-labelledby={`fhir-type-${type}-tab`}>
            <table aria-label={`${type} 列表`}>
              <thead>
                <tr>
                  <th scope="col">資源類型</th>
                  <th scope="col">資源編號</th>
                  <th scope="col">識別碼</th>
                  <th scope="col">摘要</th>
                </tr>
              </thead>
              <tbody>
                {page.loading && !page.data && (
                  <tr>
                    <td colSpan={4} role="status">
                      載入中…
                    </td>
                  </tr>
                )}
                {page.data?.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <TypeCell type={r.resourceType} />
                    </td>
                    <th scope="row">{`${r.resourceType}/${r.id}`}</th>
                    <td className="fhir-code">{r.identifier?.[0]?.value ?? '—'}</td>
                    <td>{resourceLabel(r)}</td>
                  </tr>
                ))}
                {page.data?.items.length === 0 && (
                  <tr>
                    <td colSpan={4}>這個租戶還沒有 {type}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {page.data && page.data.total > 0 && (
            <Pagination
              page={Math.floor(offset / PAGE) + 1}
              pageSize={PAGE}
              total={page.data.total}
              onPageChange={(p) => setOffset((p - 1) * PAGE)}
            />
          )}
        </Card>
      )}
    </div>
  );
}
