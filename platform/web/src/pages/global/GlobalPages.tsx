// 不屬於某個專案的頁面：選擇專案、沒有任何專案、個人設定、功能目錄。
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ENTRIES, checkAccess } from '../../access/entries';
import { ACCOUNT_TYPE_NAMES_ZH, ROLE_LABELS, ROLE_NAMES_ZH, type MeProject } from '../../api/types';
import { useMe, useSession } from '../../auth/SessionContext';
import { Alert } from '../../components/Alert';
import { confirmLeave } from '../../components/unsaved';
import { keycloakAccountUrl } from './keycloak';
import '../home/home.css';

function roleName(p: MeProject, isAdmin: boolean): string {
  if (p.role) return `${ROLE_NAMES_ZH[p.role]}（${ROLE_LABELS[p.role]}）`;
  return isAdmin ? '系統管理者（未加入，可檢視全部）' : '—';
}

/** 沒有任何專案：帳號資訊、聯絡管理者、登出 */
export function NoProjectPage() {
  const me = useMe();
  const { logout } = useSession();
  return (
    <section className="card narrow" aria-labelledby="no-project-title">
      <h1 id="no-project-title">你還沒有加入任何專案</h1>
      <p>你尚未加入任何專案，請聯絡管理者將你加入專案。加入後重新整理這一頁，就會看到專案。</p>
      <dl className="dl-grid section">
        <dt>帳號</dt>
        <dd>{me.username}</dd>
        <dt>帳號類型</dt>
        <dd>{ACCOUNT_TYPE_NAMES_ZH[me.account_type]}</dd>
      </dl>
      <p className="text-muted">聯絡管理者時，請告訴對方你的帳號和要加入的研究專案名稱。</p>
      <div className="row-actions section">
        {me.account_type === 'admin' && (
          <Link to="/admin/projects" className="btn btn--primary">
            到系統管理建立專案
          </Link>
        )}
        <Link to="/account" className="btn btn--secondary">
          個人設定
        </Link>
        <button type="button" className="btn btn--secondary" onClick={() => void logout()}>
          登出
        </button>
      </div>
    </section>
  );
}

/** 選擇專案：搜尋、最近使用、在該專案的身分 */
export function ProjectSelectPage() {
  const me = useMe();
  const { project, selectProject, recentProjectIds } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState('');
  if (me.projects.length === 0) return <NoProjectPage />;

  const isAdmin = me.account_type === 'admin';
  const from = (location.state as { from?: string } | null)?.from;
  const choose = (id: number) => {
    if (id !== project?.id && !confirmLeave('切換專案')) return;
    selectProject(id);
    navigate(from && from !== '/projects' ? from : '/');
  };
  const needle = q.trim().toLowerCase();
  const matched = me.projects.filter((p) => !needle || p.name.toLowerCase().includes(needle));
  const recent = recentProjectIds
    .map((id) => me.projects.find((p) => p.id === id))
    .filter((p): p is MeProject => !!p);

  const item = (p: MeProject) => (
    <li key={p.id}>
      <button type="button" className="picker-item" aria-current={p.id === project?.id ? 'true' : undefined} onClick={() => choose(p.id)}>
        <span className="picker-item__name">{p.name}</span>
        <span className="text-muted">我的身分：{roleName(p, isAdmin)}</span>
      </button>
    </li>
  );

  return (
    <div className="narrow">
      <h1>選擇專案</h1>
      <p className="text-muted">選一個專案進入研究區。之後可以從頂端的「目前專案」切換。</p>
      {from && <Alert tone="info">這一頁需要先選專案。</Alert>}
      {recent.length > 0 && !needle && (
        <section className="section" aria-labelledby="recent-projects">
          <h2 id="recent-projects">最近使用</h2>
          <ul className="picker-list" aria-label="最近使用的專案">
            {recent.slice(0, 3).map(item)}
          </ul>
        </section>
      )}
      <section className="section" aria-labelledby="all-projects">
        <h2 id="all-projects">全部專案（{me.projects.length}）</h2>
        <div className="field">
          <label htmlFor="project-search">搜尋專案名稱</label>
          <input id="project-search" className="input" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {matched.length === 0 ? (
          <p className="text-muted">找不到名稱含「{q}」的專案。</p>
        ) : (
          <ul className="picker-list" aria-label="全部專案">
            {matched.map(item)}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 個人帳號設定：唯讀帳號資訊、各專案角色、密碼管理入口、登出 */
export function AccountPage() {
  const me = useMe();
  const { auth, logout } = useSession();
  const isAdmin = me.account_type === 'admin';
  return (
    <div className="narrow">
      <h1>個人設定</h1>
      <section className="card section" aria-labelledby="account-info">
        <h2 id="account-info">帳號資訊</h2>
        <dl className="dl-grid">
          <dt>帳號</dt>
          <dd>{me.username}</dd>
          <dt>帳號類型</dt>
          <dd>{ACCOUNT_TYPE_NAMES_ZH[me.account_type]}</dd>
        </dl>
        <p className="text-muted">姓名與帳號由醫院統一身分管理，這裡不能修改。</p>
      </section>
      <section className="card section" aria-labelledby="account-projects">
        <h2 id="account-projects">我在各專案的身分</h2>
        {me.projects.length === 0 ? (
          <p>你尚未加入任何專案，請聯絡管理者將你加入專案。</p>
        ) : (
          <div className="table-wrap">
            <table aria-label="我在各專案的身分">
              <thead>
                <tr>
                  <th scope="col">專案</th>
                  <th scope="col">身分</th>
                  <th scope="col">權限</th>
                </tr>
              </thead>
              <tbody>
                {me.projects.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.name}</th>
                    <td>{roleName(p, isAdmin)}</td>
                    <td>{p.permissions.join('、') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card section" aria-labelledby="account-password">
        <h2 id="account-password">密碼</h2>
        <p>密碼在醫院統一身分的帳號頁修改。</p>
        {auth.mode === 'test' && <p className="text-muted">目前是測試登入模式，帳號頁不會有作用。</p>}
        <div className="row-actions">
          <a className="btn btn--secondary" href={keycloakAccountUrl()} target="_blank" rel="noreferrer">
            前往帳號頁修改密碼
          </a>
          <button type="button" className="btn btn--secondary" onClick={() => void logout()}>
            登出
          </button>
        </div>
      </section>
    </div>
  );
}

/** 功能目錄：依權限列出契約 8 個入口的原名稱，點了直接進入 */
export function CatalogPage() {
  const me = useMe();
  const { project } = useSession();
  const rows = ENTRIES.flatMap((e) =>
    checkAccess(e, me, project).allowed ? [{ entry: e, name: e.label, alias: false }, ...(e.aliases ?? []).map((a) => ({ entry: e, name: a, alias: true }))] : [],
  );
  return (
    <>
      <h1>功能目錄</h1>
      <p className="text-muted">
        依你在{project ? `專案「${project.name}」` : '目前帳號'}的權限，列出平台的功能入口。點名稱直接進入，「新位置」是改版後在側欄的位置。
      </p>
      {rows.length === 0 ? (
        <Alert tone="info">目前沒有可使用的功能。你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>
      ) : (
        <div className="table-wrap section">
          <table aria-label="功能目錄">
            <thead>
              <tr>
                <th scope="col">功能名稱</th>
                <th scope="col">新位置</th>
                <th scope="col">模組代碼</th>
                <th scope="col">說明</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, name, alias }) => (
                <tr key={name}>
                  <th scope="row">
                    <Link to={entry.path}>{name}</Link>
                    {alias && <span className="text-muted">（別名）</span>}
                  </th>
                  <td>{entry.location}</td>
                  <td>{entry.moduleCode}</td>
                  <td>{entry.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
