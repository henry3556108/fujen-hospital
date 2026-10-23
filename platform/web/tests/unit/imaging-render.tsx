// 研究資料區的測試渲染：不經過 App.tsx，只掛 /data/* 子路由，外加最小的專案切換器。
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from '../../src/auth/SessionContext';
import { TestAuthAdapter } from '../../src/auth/testAdapter';
import { dataRoutes } from '../../src/pages/data/routes';
import { AllowlistEditor } from '../../src/pages/imaging/AllowlistEditor';

function Shell() {
  const { status, me, project, selectProject } = useSession();
  if (status !== 'ready' || !me) return <p role="status">載入中…</p>;
  return (
    <>
      <label htmlFor="project-switcher">目前專案</label>
      <select id="project-switcher" value={project?.id ?? ''} onChange={(e) => selectProject(Number(e.target.value))}>
        {me.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <Routes>
        <Route path="/data/*">{dataRoutes()}</Route>
        <Route path="/labeling/*" element={<h1>影像標註</h1>} />
        {/* 管理區的專案頁會用到的編輯元件 */}
        <Route path="/admin/allowlist" element={<AllowlistEditor projectId={project?.id ?? 1} />} />
      </Routes>
    </>
  );
}

export async function renderData(path: string, username = 'admin01') {
  const auth = new TestAuthAdapter();
  await auth.login({ username });
  const user = userEvent.setup();
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider auth={auth} apiBase="">
        <Shell />
      </SessionProvider>
    </MemoryRouter>,
  );
  return { ...utils, user, auth };
}
