import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ADMIN_NAV, AREAS, isActive, visibleNav, type AdminNavItem, type NavArea } from '../access/entries';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_NAMES_ZH, ROLE_LABELS, ROLE_NAMES_ZH, type Me, type MeProject } from '../api/types';
import { useMe, useSession } from '../auth/SessionContext';
import { Icon, type IconName } from './Icon';
import { confirmLeave } from './unsaved';

/** 我在這個專案的角色：契約的英文名稱，中文放在提示文字 */
export function projectRoleText(me: Me, project: MeProject | null): [string, string] {
  if (project?.role) return [ROLE_LABELS[project.role], ROLE_NAMES_ZH[project.role]];
  if (me.account_type === 'admin') return [ACCOUNT_TYPE_LABELS.admin, ACCOUNT_TYPE_NAMES_ZH.admin];
  return [ACCOUNT_TYPE_LABELS.user, ACCOUNT_TYPE_NAMES_ZH.user];
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
      <Link to="/projects" className="topbar__all-projects" onClick={guardClick}>
        所有專案
      </Link>
    </div>
  );
}

/** 右上角「帳號・身分」下拉：個人設定。身分文字保留「我的角色（…）」給輔助技術與驗收腳本讀取。 */
function UserMenu({ showRole }: { showRole: boolean }) {
  const me = useMe();
  const { project } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const [roleText, roleEnglish] = projectRoleText(me, project);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="usermenu" ref={ref}>
      <button
        type="button"
        className="topbar__user"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="user-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="topbar__avatar" aria-hidden="true">
          <Icon name="user" />
        </span>
        <span className="topbar__username">{me.username}</span>
        {showRole && (
          <>
            <span className="topbar__sep" aria-hidden="true">
              ・
            </span>
            <span className="topbar__role" title={roleEnglish} data-testid="header-role">
              <span className="visually-hidden">我的角色（</span>
              {roleText}
              <span className="visually-hidden">）</span>
            </span>
          </>
        )}
        <Icon name="chevron-down" className="topbar__chevron" />
      </button>
      {open && (
        <div id="user-menu" className="usermenu__panel">
          <dl className="usermenu__info">
            <dt>帳號</dt>
            <dd>{me.username}</dd>
            <dt>角色</dt>
            <dd>
              {roleText}（{roleEnglish}）
            </dd>
          </dl>
          <Link to="/account" className="usermenu__item" onClick={guardClick}>
            <Icon name="user" />
            個人設定
          </Link>
        </div>
      )}
    </div>
  );
}

function SideLink({
  to,
  label,
  icon,
  active,
  ariaLabel,
}: {
  to: string;
  label: string;
  icon: IconName;
  active: boolean;
  ariaLabel?: string;
}) {
  return (
    <Link
      to={to}
      className="sidenav__item"
      aria-current={active ? 'page' : undefined}
      aria-label={ariaLabel}
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
        <li className="sidenav__back">
          {/* 畫面寫「返回研究區」（設計稿 B12），名稱沿用「回研究區」 */}
          <SideLink to="/projects" label="返回研究區" ariaLabel="回研究區" icon="back" active={false} />
        </li>
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

  return (
    <div className={`shell ${collapsed ? 'shell--collapsed' : ''} ${adminArea ? 'shell--admin' : ''}`}>
      <a className="skip-link" href="#main">
        跳到主要內容
      </a>
      <div className={`sidebar ${menuOpen ? 'sidebar--open' : ''}`}>
        <Link to={adminArea ? '/admin' : '/'} className="sidebar__brand" onClick={guardClick} title="AI 模型開發管理軟體平台">
          <Icon name="lungs" className="sidebar__logo" />
          <span className="sidebar__brand-text">AI 模型開發管理軟體平台</span>
        </Link>
        <nav
          id="main-nav"
          aria-label={adminArea ? '管理後台選單' : '功能選單'}
          className={`sidenav ${menuOpen ? 'sidenav--open' : ''}`}
        >
          {adminArea ? <AdminNav items={ADMIN_NAV} pathname={pathname} /> : <ResearchNav items={items} pathname={pathname} isAdmin={isAdmin} />}
        </nav>
      </div>
      <div className="shell__main">
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
          {adminArea ? (
            <div className="topbar__context">
              <span className="topbar__scope-label">目前範圍</span>
              <span className="topbar__area">管理後台</span>
            </div>
          ) : (
            <div className="topbar__context">
              <ProjectSwitcher />
            </div>
          )}
          <div className="topbar__tools">
            <UserMenu showRole={!adminArea && !!project} />
            <button
              type="button"
              className="btn btn--ghost btn--small topbar__logout"
              onClick={() => {
                if (confirmLeave('登出')) void logout();
              }}
            >
              <Icon name="logout" />
              登出
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
