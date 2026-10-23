import { useEffect, useState, type MouseEvent } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ADMIN_NAV, AREAS, isActive, visibleNav, type AdminNavItem, type NavArea } from '../access/entries';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_NAMES_ZH, ROLE_LABELS, ROLE_NAMES_ZH, type Me, type MeProject } from '../api/types';
import { useMe, useSession } from '../auth/SessionContext';
import { Icon, type IconName } from './Icon';
import { confirmLeave } from './unsaved';

/** 我在這個專案的身分：中文角色名稱，英文原名放在提示文字 */
export function projectRoleText(me: Me, project: MeProject | null): [string, string] {
  if (project?.role) return [ROLE_NAMES_ZH[project.role], ROLE_LABELS[project.role]];
  if (me.account_type === 'admin') return [ACCOUNT_TYPE_NAMES_ZH.admin, ACCOUNT_TYPE_LABELS.admin];
  return [ACCOUNT_TYPE_NAMES_ZH.user, ACCOUNT_TYPE_LABELS.user];
}

/** 側欄連結點下去前，有沒存的內容先問 */
function guardClick(e: MouseEvent) {
  if (!confirmLeave()) e.preventDefault();
}

function ProjectSwitcher() {
  const me = useMe();
  const { project, selectProject, refreshMe } = useSession();
  if (me.projects.length === 0) {
    return <span className="topbar__project-name">尚未加入任何專案</span>;
  }
  return (
    <div className="field field--inline topbar__project">
      <label htmlFor="project-switcher">目前專案</label>
      <select
        id="project-switcher"
        className="select"
        value={project?.id ?? ''}
        onFocus={refreshMe}
        onChange={(e) => {
          if (confirmLeave('切換專案')) selectProject(Number(e.target.value));
        }}
      >
        {!project && <option value="">（請選擇）</option>}
        {me.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function SideLink({ to, label, icon, active }: { to: string; label: string; icon: IconName; active: boolean }) {
  return (
    <Link
      to={to}
      className="sidenav__item"
      aria-current={active ? 'page' : undefined}
      title={label}
      onClick={guardClick}
    >
      <Icon name={icon} className="sidenav__icon" />
      <span className="sidenav__label">{label}</span>
    </Link>
  );
}

function ResearchNav({ items, pathname, isAdmin }: { items: NavArea[]; pathname: string; isAdmin: boolean }) {
  return (
    <>
      <ul>
        {items.map((a) => (
          <li key={a.key} className={a.divider ? 'sidenav__divided' : undefined}>
            <SideLink to={a.path} label={a.label} icon={a.icon} active={isActive(a, pathname)} />
          </li>
        ))}
      </ul>
      <ul className="sidenav__bottom">
        <li>
          <SideLink to="/catalog" label="功能目錄" icon="grid" active={pathname === '/catalog'} />
        </li>
        {isAdmin && (
          <li>
            <SideLink to={AREAS.admin.path} label={AREAS.admin.label} icon={AREAS.admin.icon} active={false} />
          </li>
        )}
      </ul>
    </>
  );
}

function AdminNav({ items, pathname }: { items: readonly AdminNavItem[]; pathname: string }) {
  return (
    <>
      <ul>
        {items.map((a) => (
          <li key={a.key}>
            <SideLink to={a.path} label={a.label} icon={a.icon} active={isActive(a, pathname)} />
          </li>
        ))}
      </ul>
      <ul className="sidenav__bottom">
        <li>
          <SideLink to="/catalog" label="功能目錄" icon="grid" active={false} />
        </li>
        <li>
          <SideLink to="/projects" label="回研究區" icon="back" active={false} />
        </li>
      </ul>
    </>
  );
}

export function AppLayout() {
  const me = useMe();
  const { project, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const pathname = location.pathname;
  useEffect(() => setMenuOpen(false), [pathname]);

  const isAdmin = me.account_type === 'admin';
  const adminArea = isAdmin && (pathname === '/admin' || pathname.startsWith('/admin/'));
  const items = visibleNav(me, project);
  // 標註工作台一律收起側欄（03 規格 4.2）
  const collapsed = /^\/labeling\/studies\//.test(pathname);
  const [roleText, roleEnglish] = projectRoleText(me, project);

  return (
    <div className={`shell ${collapsed ? 'shell--collapsed' : ''} ${adminArea ? 'shell--admin' : ''}`}>
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
        <Link to={adminArea ? '/admin' : '/'} className="topbar__brand" onClick={guardClick}>
          AI 模型開發管理平台
        </Link>
        {adminArea ? (
          <div className="topbar__context">
            <span className="topbar__area">系統管理區</span>
            <Link to="/projects" className="btn btn--secondary btn--small">
              切到研究區
            </Link>
          </div>
        ) : (
          <div className="topbar__context">
            <ProjectSwitcher />
            {project && (
              <span className="topbar__role" title={roleEnglish} data-testid="header-role">
                我的身分（{roleText}）
              </span>
            )}
          </div>
        )}
        <div className="topbar__tools">
          <Link to="/account" className="topbar__user" onClick={guardClick} aria-label={`個人設定（${me.username}）`}>
            <Icon name="user" />
            <span className="topbar__username">{me.username}</span>
          </Link>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              if (confirmLeave('登出')) void logout();
            }}
          >
            登出
          </button>
        </div>
      </header>
      <div className="shell__body">
        <nav
          id="main-nav"
          aria-label={adminArea ? '系統管理選單' : '功能選單'}
          className={`sidenav ${menuOpen ? 'sidenav--open' : ''}`}
        >
          {adminArea ? <AdminNav items={ADMIN_NAV} pathname={pathname} /> : <ResearchNav items={items} pathname={pathname} isAdmin={isAdmin} />}
        </nav>
        <main id="main" tabIndex={-1} className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
