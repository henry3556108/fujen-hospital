import { useState } from 'react';
import { Link, Navigate, Route, useParams } from 'react-router-dom';
import type { Project } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { Icon, PageHeader, Tabs } from '../../components/ui';
import { AllowlistEditor } from '../imaging/AllowlistEditor';
import type { GpuGroup } from '../scheduling/types';
import { LabelGroupsPage } from './LabelGroupsPage';
import { MembersPage } from './MembersPage';
import { ProjectForm, type FormValues } from './ProjectsPage';
import './admin.css';

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
    <div className="adm-narrow">
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
    </div>
  );
}

function AllowlistTab({ project }: { project: Project }) {
  return (
    <div className="adm-allowlist-tab">
      <h2 className="visually-hidden">Accession Number 清單</h2>
      <AllowlistEditor projectId={project.id} projectName={project.name} />
    </div>
  );
}

/** 管理區單一專案頁（設計稿 B19）：四個分頁都用路由的 projectId（03 規格第二節管理區） */
function ProjectDetail({ tab }: { tab: 'basic' | 'members' | 'groups' | 'allowlist' }) {
  const { api } = useSession();
  const id = useProjectId();
  const projects = useResource(() => api.get<Project[]>('/api/admin/projects'));
  const project = projects.data?.find((p) => p.id === id) ?? null;
  const base = `/admin/projects/${id}`;
  return (
    <div className="adm-page">
      <PageHeader
        breadcrumbs={[{ label: '專案', to: '/admin/projects' }, { label: project?.name ?? `專案 ${id}` }]}
        title={project ? `專案：${project.name}` : '專案'}
        subtitle={project?.description || undefined}
        actions={
          project && (
            <>
              <Link to="/admin/compute/groups" className="adm-header-link">
                <Icon name="gear" /> GPU 群組
              </Link>
              <Link to={`${base}/allowlist`} className="adm-header-link">
                <Icon name="database" /> Accession Number 清單
              </Link>
            </>
          )
        }
      >
        {project && (
          <Tabs
            label="專案設定分頁"
            items={[
              { to: base, label: '基本資料與 GPU 群組', end: true },
              { to: `${base}/members`, label: '成員與權限' },
              { to: `${base}/groups`, label: '標註群組' },
              { to: `${base}/allowlist`, label: 'Accession Number 清單' },
            ]}
          />
        )}
      </PageHeader>
      <ApiErrorAlert error={projects.error} />
      {projects.loading && !projects.data && <p role="status">載入中…</p>}
      {projects.data && !project && <Alert tone="error">找不到專案 {id}，可能已被刪除。請回專案清單重新選擇。</Alert>}
      {project && (
        <>
          {tab === 'basic' && <BasicTab project={project} onSaved={projects.reload} />}
          {tab === 'members' && <MembersPage fixedProjectId={project.id} />}
          {tab === 'groups' && <LabelGroupsPage fixedProjectId={project.id} />}
          {tab === 'allowlist' && <AllowlistTab project={project} />}
        </>
      )}
    </div>
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
