// 只渲染數據管理（/data/*）與影像標註（/labeling/*）兩區的路由，不經過 App 外框；
// 讓這兩區的測試不受 App.tsx 改版影響。權限守門（EntryGuard）由 App 的測試負責。
import type { ReactNode } from 'react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from '../../src/auth/SessionContext';
import { TestAuthAdapter } from '../../src/auth/testAdapter';
import { dataRoutes } from '../../src/pages/data/routes';
import { labelingRoutes } from '../../src/pages/labeling/routes';

function Ready({ children }: { children: ReactNode }) {
  const { status } = useSession();
  return status === 'ready' ? <>{children}</> : <p>載入中…</p>;
}

/** 目前網址，給測試檢查導向結果 */
function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}

export async function renderArea(path: string, username = 'md01') {
  const auth = new TestAuthAdapter();
  await auth.login({ username });
  const user = userEvent.setup();
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider auth={auth} apiBase="">
        <Ready>
          <Routes>
            <Route path="/data/*">{dataRoutes()}</Route>
            <Route path="/labeling/*">{labelingRoutes()}</Route>
            <Route path="*" element={<p>其他頁面</p>} />
          </Routes>
          <Where />
        </Ready>
      </SessionProvider>
    </MemoryRouter>,
  );
  return { ...utils, user, auth };
}
