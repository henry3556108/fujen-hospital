import { useState } from 'react';
import { Link, Navigate, Route, useParams } from 'react-router-dom';
import type { Project } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { Tabs } from '../../components/Tabs';
import { AllowlistEditor } from '../imaging/AllowlistEditor';
import type { GpuGroup } from '../scheduling/types';
import { LabelGroupsPage } from './LabelGroupsPage';
import { MembersPage } from './MembersPage';
import { ProjectForm, type FormValues } from './ProjectsPage';

function useProjectId(): number {
  return Number(useParams().projectId);
}

function BasicTab({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const { api } = useSession();
  const groups = useResource(() => api.get<GpuGroup[]>('/api/admin/gpu-groups'));
  const [notice, setNotice] = useState<string | null>(null);
  async function update(v: FormValues) {
    const p = await api.patch<Project>(`/api/admin/projects/${project.id}`, {
      name: v.name,
      description: v.description,
      gpu_group: v.gpu_group || null,
    });
    setNotice(`已更新專案「${p.name}」`);
    onSaved();
  }
  return (
    <>
      {notice && <Alert tone="success">{notice}</Alert>}
      <ProjectForm
        key={`${project.id}-${project.name}-${project.gpu_group}`}
        title="基本資料與 GPU 群組"
        submitLabel="儲存"
        initial={{ name: project.name, description: project.description, gpu_group: project.gpu_group ?? '' }}
        onSubmit={update}
        keepValues
        groups={groups.data}
        groupsError={groups.error}
      />
    </>
  );
}

function AllowlistTab({ project }: { project: Project }) {
  return (
    <div className="section">
      <h2>影像存取清單</h2>
      <p className="text-muted">
        設定清單後，專案「{project.name}」在網頁、API、DICOMweb 都只看得到清單內的影像（Accession Number）。清單外的影像仍可匯入，但不會顯示；
        院內影像系統（PACS）取像會直接拒絕清單外的影像。研究資料頁只能看，不能修改。
      </p>
      <AllowlistEditor projectId={project.id} />
    </div>
  );
}

/** 管理區單一專案頁：四個分頁都用路由的 projectId（03 規格第二節管理區） */
function ProjectDetail({ tab }: { tab: 'basic' | 'members' | 'groups' | 'allowlist' }) {
  const { api } = useSession();
  const id = useProjectId();
  const projects = useResource(() => api.get<Project[]>('/api/admin/projects'));
  const project = projects.data?.find((p) => p.id === id) ?? null;
  const base = `/admin/projects/${id}`;
  return (
    <>
      <p>
        <Link to="/admin/projects">← 專案清單</Link>
      </p>
      <h1>{project ? `專案：${project.name}` : '專案'}</h1>
      <ApiErrorAlert error={projects.error} />
      {projects.loading && !projects.data && <p role="status">載入中…</p>}
      {projects.data && !project && <Alert tone="error">找不到專案 {id}，可能已被刪除。請回專案清單重新選擇。</Alert>}
      {project && (
        <>
          <Tabs
            label="專案設定分頁"
            items={[
              { to: base, label: '基本資料與 GPU 群組', end: true },
              { to: `${base}/members`, label: '成員與權限' },
              { to: `${base}/groups`, label: '標註群組' },
              { to: `${base}/allowlist`, label: '影像存取清單' },
            ]}
          />
          {tab === 'basic' && <BasicTab project={project} onSaved={projects.reload} />}
          {tab === 'members' && <MembersPage fixedProjectId={project.id} />}
          {tab === 'groups' && <LabelGroupsPage fixedProjectId={project.id} />}
          {tab === 'allowlist' && <AllowlistTab project={project} />}
        </>
      )}
    </>
  );
}

/** /admin/projects/:projectId 底下的子路由（相對路徑） */
export function projectDetailRoutes() {
  return (
    <>
      <Route index element={<ProjectDetail tab="basic" />} />
      <Route path="members" element={<ProjectDetail tab="members" />} />
      <Route path="groups" element={<ProjectDetail tab="groups" />} />
      <Route path="allowlist" element={<ProjectDetail tab="allowlist" />} />
      <Route path="*" element={<Navigate to=".." replace />} />
    </>
  );
}
