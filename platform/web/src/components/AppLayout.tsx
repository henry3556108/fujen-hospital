import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { visibleEntries } from '../access/entries';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_NAMES_ZH, ROLE_LABELS, ROLE_NAMES_ZH } from '../api/types';
import { useMe, useSession } from '../auth/SessionContext';
import { Icon } from './Icon';
import { ThemeToggle } from './ThemeToggle';

function ProjectSwitcher() {
  const me = useMe();
  const { project, selectProject, refreshMe } = useSession();
  if (me.projects.length === 0) {
    return <span className="text-muted">尚未加入任何專案</span>;
  }
  return (
    <div className="field field--inline">
      <label htmlFor="project-switcher">目前專案</label>
      <select
        id="project-switcher"
        className="select"
        value={project?.id ?? ''}
        onFocus={refreshMe}
        onChange={(e) => selectProject(Number(e.target.value))}
      >
        {me.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AppLayout() {
  const me = useMe();
  const { project, logout } = useSession();
  const entries = visibleEntries(me, project);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // 頁首用中文角色名稱，英文原名放在提示文字（與帳號管理頁對照）
  const [roleText, roleEnglish] =
    me.account_type === 'admin'
      ? [ACCOUNT_TYPE_NAMES_ZH.admin, ACCOUNT_TYPE_LABELS.admin]
      : project?.role
        ? [ROLE_NAMES_ZH[project.role], ROLE_LABELS[project.role]]
        : [ACCOUNT_TYPE_NAMES_ZH.user, ACCOUNT_TYPE_LABELS.user];

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        跳到主要內容
      </a>
      <header className="topbar">
        <button
          type="button"
          className="btn btn--ghost topbar__menu"
          aria-expanded={menuOpen}
          aria-controls="main-nav"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <Icon name={menuOpen ? 'close' : 'menu'} />
          <span>選單</span>
        </button>
        <Link to="/" className="topbar__brand">
          AI 模型開發管理平台
        </Link>
        <div className="topbar__tools">
          <ProjectSwitcher />
          <ThemeToggle />
          <span className="topbar__user">
            <span className="topbar__username">{me.username}</span>
            <span className="text-muted" title={roleEnglish} data-testid="header-role">
              （{roleText}）
            </span>
          </span>
          <button type="button" className="btn btn--secondary" onClick={() => void logout()}>
            登出
          </button>
        </div>
      </header>
      <div className="shell__body">
        <nav id="main-nav" aria-label="功能選單" className={`sidenav ${menuOpen ? 'sidenav--open' : ''}`}>
          <ul>
            {entries.map((e) => (
              <li key={e.key}>
                <NavLink to={e.path} className="sidenav__item">
                  {e.label}
                </NavLink>
              </li>
            ))}
          </ul>
          {entries.length === 0 && <p className="sidenav__empty text-muted">目前沒有可使用的功能</p>}
        </nav>
        <main id="main" tabIndex={-1} className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
