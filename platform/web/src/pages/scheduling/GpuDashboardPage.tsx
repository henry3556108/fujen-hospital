import { useEffect } from 'react';
import { useResource } from '../../api/useResource';
import { useMe, useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { SchedulingPage } from './SchedulingRoutes';
import type { ClusterNode, GpuAllocation } from './types';

const REFRESH_MS = 5000;

interface Board {
  nodes: ClusterNode[];
  rows: GpuAllocation[];
}

/** TC-C01-04 GPU Dashboard：每個 GPU 時間片上執行中的工作（Project ID、Training ID、使用者）。 */
export function GpuDashboardPage() {
  const { api } = useSession();
  const me = useMe();
  const board = useResource<Board>(async () => {
    const [nodes, rows] = await Promise.all([
      api.get<ClusterNode[]>('/api/admin/cluster/nodes'),
      api.get<GpuAllocation[]>('/api/admin/cluster/gpu-dashboard'),
    ]);
    return { nodes, rows };
  });
  const { reload } = board;

  useEffect(() => {
    const timer = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const projectName = (id: number | null) => (id === null ? '—' : (me.projects.find((p) => p.id === id)?.name ?? `專案 ${id}`));
  const gpuNodes = (board.data?.nodes ?? []).filter((n) => n.gpu_physical > 0);
  const rows = board.data?.rows ?? [];

  return (
    <SchedulingPage title="GPU Dashboard">
      <div className="page-head">
        <p className="text-muted">每 5 秒自動更新。GPU 編號與時間片由工作標籤推得；實際使用率需在有 DCGM 的環境查看。</p>
        <button type="button" className="btn btn--secondary" onClick={reload} disabled={board.loading}>
          重新整理
        </button>
      </div>
      <ApiErrorAlert error={board.error} />
      {board.loading && !board.data && <p role="status">載入中…</p>}
      {board.data && (
        <>
          <ul className="gpu-grid section" aria-label="GPU 使用狀況">
            {gpuNodes.flatMap((n) => {
              const replicas = Math.max(1, Math.floor(n.gpu_capacity / n.gpu_physical));
              return Array.from({ length: n.gpu_physical }, (_, gpu) => {
                const busy = rows.filter((r) => r.node === n.name && r.gpu_index === gpu);
                return (
                  <li key={`${n.name}-${gpu}`} className="card gpu-card">
                    <strong>
                      {n.pool} · GPU {gpu}
                    </strong>
                    <div className="text-muted mono">{n.name}</div>
                    <div>
                      使用中 {busy.length}／{replicas} 份
                    </div>
                    <ul className="gpu-card__slots">
                      {Array.from({ length: replicas }, (_, slot) => {
                        const row = busy.find((r) => r.slot === slot);
                        return (
                          <li key={slot} className={`gpu-slot ${row ? 'gpu-slot--busy' : 'gpu-slot--free'}`}>
                            {row ? `工作 ${row.job_id ?? '?'}（${row.user ?? '?'}）` : '閒置'}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              });
            })}
          </ul>
          {gpuNodes.length === 0 && <p>叢集沒有 GPU 節點。</p>}
          <div className="table-wrap section">
            <table aria-label="執行中的 GPU 工作">
              <thead>
                <tr>
                  <th scope="col">節點</th>
                  <th scope="col" className="num">
                    GPU 編號
                  </th>
                  <th scope="col" className="num">
                    時間片
                  </th>
                  <th scope="col">專案</th>
                  <th scope="col" className="num">
                    Project ID
                  </th>
                  <th scope="col" className="num">
                    Job ID
                  </th>
                  <th scope="col" className="num">
                    Training ID
                  </th>
                  <th scope="col">使用者</th>
                  <th scope="col">Kubernetes Job</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.node}-${r.gpu_index}-${r.slot}`}>
                    <td className="mono">{r.node}</td>
                    <td className="num">{r.gpu_index}</td>
                    <td className="num">{r.slot}</td>
                    <td>{projectName(r.project_id)}</td>
                    <td className="num">{r.project_id ?? '—'}</td>
                    <td className="num">{r.job_id ?? '—'}</td>
                    <td className="num">{r.training_id ?? '—'}</td>
                    <td>{r.user ?? '—'}</td>
                    <td className="mono">{r.k8s_name}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9}>目前沒有執行中的 GPU 工作</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SchedulingPage>
  );
}
