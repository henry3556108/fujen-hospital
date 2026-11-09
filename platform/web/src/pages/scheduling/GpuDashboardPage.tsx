import { useEffect } from 'react';
import { useResource } from '../../api/useResource';
import { useMe, useSession } from '../../auth/SessionContext';
import { ApiErrorAlert, Card, StatusDot } from '../../components/ui';
import { SchedulingPage } from './SchedulingRoutes';
import type { ClusterNode, GpuAllocation } from './types';

const REFRESH_MS = 5000;

interface Board {
  nodes: ClusterNode[];
  rows: GpuAllocation[];
}

/** 已分配份數的細橫條（數字另外顯示在下方，條本身不帶文字） */
export function SlotBar({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="sch-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={used}>
      <span className="sch-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** TC-C01-04 GPU Dashboard（設計稿 B21）：每張 GPU 一張卡片，下方表格列出時間片上執行中的工作（Project ID、Training ID、使用者）。 */
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
  const nodes = board.data?.nodes ?? [];
  const gpuNodes = nodes.filter((n) => n.gpu_physical > 0);
  const rows = board.data?.rows ?? [];
  const ready = nodes.filter((n) => n.ready).length;

  return (
    <SchedulingPage
      title="GPU／CPU 伺服器管理"
      subtitle="管理 GPU 資源、群組與叢集節點"
      actions={
        <button type="button" className="btn btn--secondary" onClick={reload} disabled={board.loading}>
          重新整理
        </button>
      }
    >
      <p className="text-muted">
        每 5 秒自動更新。GPU 編號與時間片由工作標籤推得；沒有監測資料（DCGM）時不顯示實際使用率，已分配份數不等於使用率。
      </p>
      <ApiErrorAlert error={board.error} />
      {board.loading && !board.data && <p role="status">載入中…</p>}
      {board.data && (
        <>
          <ul className="sch-gpu-grid" aria-label="GPU Dashboard">
            {gpuNodes.flatMap((n) => {
              const replicas = Math.max(1, Math.floor(n.gpu_capacity / n.gpu_physical));
              return Array.from({ length: n.gpu_physical }, (_, gpu) => {
                const busy = rows.filter((r) => r.node === n.name && r.gpu_index === gpu);
                return (
                  <li key={`${n.name}-${gpu}`} className="ui-card sch-gpu">
                    <div className="sch-gpu__head">
                      <strong className="sch-gpu__title">
                        {n.pool} · GPU {gpu}
                      </strong>
                      <StatusDot tone={busy.length > 0 ? 'success' : 'neutral'}>{busy.length > 0 ? '使用中' : '閒置'}</StatusDot>
                    </div>
                    <div className="text-muted mono sch-gpu__node">{n.name}</div>
                    <SlotBar used={busy.length} total={replicas} label={`${n.name} GPU ${gpu} 已分配時間片`} />
                    <div className="sch-gpu__count">
                      使用中 {busy.length}／{replicas} 份
                    </div>
                    <ul className="sch-gpu__slots" aria-label={`${n.name} GPU ${gpu} 目前執行`}>
                      {Array.from({ length: replicas }, (_, slot) => {
                        const row = busy.find((r) => r.slot === slot);
                        return (
                          <li key={slot} className={`sch-slot ${row ? 'sch-slot--busy' : 'sch-slot--free'}`}>
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
          <Card
            title="節點與 GPU 使用狀態"
            flush
            extra={
              <span className="sch-ready">
                節點狀態：<strong>就緒 {ready} / {nodes.length}</strong>
              </span>
            }
          >
            <div className="table-wrap">
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
                    <th scope="col">狀態</th>
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
                      <td>
                        <StatusDot tone="success">執行中</StatusDot>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={10}>目前沒有執行中的 GPU 工作</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </SchedulingPage>
  );
}
