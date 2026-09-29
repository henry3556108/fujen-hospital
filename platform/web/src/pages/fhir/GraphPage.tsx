import { useState, type FormEvent } from 'react';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { RESOURCE_TYPES, type FhirGraph, type GraphNode } from './types';

const SIZE = 560;
const CENTER = SIZE / 2;
const RADIUS = 190;

/** 病人在中心，其他資源平均排在外圈；邊畫成直線。 */
export function layout(graph: FhirGraph): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const center = graph.nodes.find((n) => n.type === 'Patient');
  const others = graph.nodes.filter((n) => n !== center);
  if (center) positions.set(center.id, { x: CENTER, y: CENTER });
  others.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(others.length, 1) - Math.PI / 2;
    positions.set(n.id, { x: CENTER + RADIUS * Math.cos(angle), y: CENTER + RADIUS * Math.sin(angle) });
  });
  return positions;
}

function short(text: string, max = 22) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function GraphSvg({ graph }: { graph: FhirGraph }) {
  const pos = layout(graph);
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  return (
    <svg
      className="fhir-graph card"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-labelledby="graph-title graph-desc"
      data-testid="fhir-graph"
    >
      <title id="graph-title">病人 {graph.patient} 的 FHIR Resource 關聯圖</title>
      <desc id="graph-desc">
        {graph.nodes.length} 個資源、{graph.edges.length} 條參照
      </desc>
      {graph.edges.map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        return (
          <line
            key={`${e.from}->${e.to}:${e.relation}`}
            className="fhir-graph__edge"
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            data-edge={`${e.from}->${e.to}`}
          />
        );
      })}
      {graph.nodes.map((n) => {
        const p = pos.get(n.id)!;
        const r = n.type === 'Patient' ? 46 : 42;   // 放得下「Observation」字樣
        return (
          <g key={n.id} className={`fhir-graph__node fhir-graph__node--${n.type}`} data-node-id={n.id}>
            <circle cx={p.x} cy={p.y} r={r} />
            <text x={p.x} y={p.y - 2} textAnchor="middle" className="fhir-graph__type">
              {n.type}
            </text>
            <text x={p.x} y={p.y + 13} textAnchor="middle">
              {n.id.split('/')[1]}
            </text>
            <text x={p.x} y={p.y + r + 16} textAnchor="middle">
              {short(byId.get(n.id)!.label)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function GraphPage() {
  const { api, project } = useSession();
  const [patient, setPatient] = useState('');
  const [graph, setGraph] = useState<FhirGraph | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function load(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setGraph(
        await api.get<FhirGraph>(`/api/projects/${project!.id}/fhir/graph?patient=${encodeURIComponent(patient.trim())}`),
      );
    } catch (err) {
      setGraph(null);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <form aria-label="查詢關聯圖" className="field field--inline" onSubmit={load}>
        <label htmlFor="graph-patient">病歷號</label>
        <input
          id="graph-patient"
          className="input"
          value={patient}
          onChange={(e) => setPatient(e.target.value)}
          placeholder="例如 SYN-42-0001"
        />
        <button type="submit" className="btn btn--primary" disabled={busy || !patient.trim()}>
          顯示關聯圖
        </button>
      </form>
      <ApiErrorAlert error={error} />
      {graph && (
        <>
          <ul className="fhir-legend" aria-label="圖例">
            {RESOURCE_TYPES.map((t) => (
              <li key={t}>
                <span className={`fhir-legend__swatch fhir-legend__swatch--${t}`} aria-hidden="true" />
                {t}
              </li>
            ))}
          </ul>
          <GraphSvg graph={graph} />
          {graph.truncated && <p className="text-muted">資源太多，只顯示每種型別的前 200 筆。</p>}
          <div className="table-wrap">
            <table aria-label="關聯清單">
              <thead>
                <tr>
                  <th scope="col">資源</th>
                  <th scope="col">識別碼</th>
                  <th scope="col">摘要</th>
                  <th scope="col">參照</th>
                </tr>
              </thead>
              <tbody>
                {graph.nodes.map((n) => (
                  <tr key={n.id}>
                    <th scope="row">{n.id}</th>
                    <td className="fhir-code">{n.identifier || '—'}</td>
                    <td>{n.label}</td>
                    <td>
                      {graph.edges
                        .filter((e) => e.from === n.id)
                        .map((e) => `${e.relation} → ${e.to}`)
                        .join('、') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
