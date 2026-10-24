// 不屬於某個專案的頁面：選擇專案（B30）、沒有任何專案（B31）、個人設定（B32）、功能目錄（B12）。
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ENTRIES, checkAccess, type Entry } from '../../access/entries';
import { ACCOUNT_TYPE_NAMES_ZH, ROLE_LABELS, ROLE_NAMES_ZH, type MeProject, type Project } from '../../api/types';
import { useResource } from '../../api/useResource';
import { useMe, useSession } from '../../auth/SessionContext';
import { confirmLeave } from '../../components/unsaved';
import { Alert, Badge, Card, Icon, PageHeader, type IconName } from '../../components/ui';
import { keycloakAccountUrl } from './keycloak';
import { projectCover } from './projectCover';
import { THEME_OPTIONS, readTheme, saveTheme, type ThemeChoice } from './theme';
import '../home/home.css';
import './global.css';

function roleName(p: MeProject, isAdmin: boolean): string {
  if (p.role) return `${ROLE_NAMES_ZH[p.role]}（${ROLE_LABELS[p.role]}）`;
  return isAdmin ? '系統管理者（未加入，可檢視全部）' : '—';
}

/** 卡片上的短身分：醫師、檢視者… */
function shortRole(p: MeProject, isAdmin: boolean): string {
  if (p.role) return ROLE_NAMES_ZH[p.role];
  return isAdmin ? '系統管理者' : '—';
}

/** 沒有任何專案（B31）：帳號、複製帳號、重新整理專案清單、登出 */
export function NoProjectPage() {
  const me = useMe();
  const { logout, refreshMe } = useSession();
  const [msg, setMsg] = useState<string | null>(null);

  async function copyAccount() {
    try {
      await navigator.clipboard.writeText(me.username);
      setMsg('已複製帳號。');
    } catch {
      setMsg(`無法自動複製，請手動選取帳號：${me.username}`);
    }
  }

  function refresh() {
    refreshMe();
    setMsg('已重新取得專案清單。加入專案後會自動進入。');
  }

  return (
    <section className="ui-card gp-empty" aria-labelledby="no-project-title">
      <Icon name="folder" className="gp-empty__icon" />
      <h1 id="no-project-title" className="gp-empty__title">
        你尚未加入任何專案
      </h1>
      <p className="gp-empty__lead">請聯絡專案管理者，將你的帳號加入研究專案。</p>
      <div className="gp-account-row">
        <span className="gp-account-row__label">你的帳號</span>
        <span className="gp-account-row__value">
          {me.username}
          <span className="text-muted">（{ACCOUNT_TYPE_NAMES_ZH[me.account_type]}）</span>
        </span>
        <button type="button" className="btn btn--ghost gp-account-row__copy" onClick={() => void copyAccount()}>
          <Icon name="copy" /> 複製帳號
        </button>
      </div>
      <button type="button" className="btn btn--primary btn--large gp-empty__main" onClick={refresh}>
        <Icon name="refresh" /> 重新整理專案清單
      </button>
      <p role="status" className="gp-empty__status">
        {msg}
      </p>
      <p className="text-muted">聯絡管理者時，請告訴對方你的帳號和要加入的研究專案名稱。</p>
      <div className="row-actions gp-empty__more">
        {me.account_type === 'admin' && (
          <Link to="/admin/projects" className="btn btn--secondary">
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

/** 選擇專案（B30）：搜尋、卡片（示意封面、身分、描述）、選取後「進入專案」 */
export function ProjectSelectPage() {
  const me = useMe();
  const { api, project, selectProject, recentProjectIds } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState('');
  const isAdmin = me.account_type === 'admin';
  // 專案描述只有管理端 API 有（一般帳號的 /api/me 沒有描述，就不顯示）
  const details = useResource(
    () => (isAdmin ? api.get<Project[]>('/api/admin/projects').catch(() => [] as Project[]) : Promise.resolve([] as Project[])),
    [isAdmin],
  );
  const [selected, setSelected] = useState<number | null>(
    () =>
      project?.id ??
      recentProjectIds.find((id) => me.projects.some((p) => p.id === id)) ??
      (me.projects.length === 1 ? me.projects[0].id : null),
  );
  if (me.projects.length === 0) return <NoProjectPage />;

  const from = (location.state as { from?: string } | null)?.from;
  const enter = (id: number | null) => {
    if (id == null) return;
    if (id !== project?.id && !confirmLeave('切換專案')) return;
    selectProject(id);
    navigate(from && from !== '/projects' ? from : '/');
  };
  const description = (id: number) => details.data?.find((d) => d.id === id)?.description?.trim() || '';
  const needle = q.trim().toLowerCase();
  // 最近使用的排前面，其餘照原順序
  const rank = (p: MeProject) => {
    const i = recentProjectIds.indexOf(p.id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...me.projects].sort((a, b) => rank(a) - rank(b));
  const matched = sorted.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || description(p.id).toLowerCase().includes(needle),
  );
  const selectedProject = me.projects.find((p) => p.id === selected) ?? null;

  return (
    <>
      <PageHeader
        title="選擇研究專案"
        subtitle="請選擇要進入的研究專案，不同專案有不同的研究主題與你的使用權限。之後可以從頂端的「目前專案」切換。"
      />
      {from && <Alert tone="info">這一頁需要先選專案。</Alert>}
      <div className="gp-search">
        <Icon name="search" className="gp-search__icon" />
        <label htmlFor="project-search" className="visually-hidden">
          搜尋專案名稱
        </label>
        <input
          id="project-search"
          className="input gp-search__input"
          placeholder={isAdmin ? '搜尋專案名稱或描述' : '搜尋專案名稱'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button type="button" className="gp-search__clear" aria-label="清除搜尋" onClick={() => setQ('')}>
            <Icon name="close" />
          </button>
        )}
      </div>
      {matched.length === 0 ? (
        <p className="text-muted">找不到含「{q}」的專案。</p>
      ) : (
        <ul className="gp-cards" aria-label="全部專案">
          {matched.map((p) => {
            const desc = description(p.id);
            const cover = projectCover({ name: p.name, description: desc });
            const isSel = p.id === selected;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className="gp-card"
                  aria-pressed={isSel}
                  aria-current={p.id === project?.id ? 'true' : undefined}
                  onClick={() => setSelected(p.id)}
                  onDoubleClick={() => enter(p.id)}
                >
                  <span className="gp-card__name">{p.name}</span>
                  <img className="gp-card__cover" src={cover.src} alt="" loading="lazy" />
                  {isSel && (
                    <span className="gp-card__check">
                      <Icon name="check" />
                      <span className="visually-hidden">（已選取）</span>
                    </span>
                  )}
                  <span className="gp-card__role">
                    <Icon name="user" /> {shortRole(p, isAdmin)}
                  </span>
                  {desc && <span className="gp-card__desc">{desc}</span>}
                  <span className="gp-card__foot">
                    {p.id === project?.id && <Badge tone="info">目前專案</Badge>}
                    {recentProjectIds.includes(p.id) && <Badge tone="neutral">最近使用</Badge>}
                    <span className="text-muted">{p.permissions.length} 項權限</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="gp-actions">
        <span className="text-muted">{selectedProject ? `已選取：${selectedProject.name}` : '請先點選一個專案'}</span>
        <button type="button" className="btn btn--primary btn--large" disabled={!selectedProject} onClick={() => enter(selected)}>
          進入專案 <Icon name="arrow" />
        </button>
      </div>
    </>
  );
}

/** 個人帳號設定（B32）：唯讀帳號資料、各專案身分、介面主題、密碼入口、登出 */
export function AccountPage() {
  const me = useMe();
  const { auth, logout, project } = useSession();
  const isAdmin = me.account_type === 'admin';
  const [theme, setTheme] = useState<ThemeChoice>(() => readTheme());
  const [saved, setSaved] = useState<null | 'ok' | 'fail'>(null);

  return (
    <>
      <PageHeader title="個人帳號設定" subtitle="帳號由醫院統一身分管理；角色與權限由管理者調整。" />
      <div className="gp-settings">
        <Card title="帳號資料">
          <dl className="gp-rows">
            <div>
              <dt>院方帳號</dt>
              <dd>{me.username}</dd>
            </div>
            <div>
              <dt>帳號類型</dt>
              <dd>{ACCOUNT_TYPE_NAMES_ZH[me.account_type]}</dd>
            </div>
            {project && (
              <div>
                <dt>目前專案角色</dt>
                <dd>
                  {roleName(project, isAdmin)}
                  <span className="text-muted">（{project.name}）</span>
                </dd>
              </div>
            )}
          </dl>
          <p className="text-muted">這裡的資料不能修改。</p>
        </Card>

        <Card title="我在各專案的身分" flush>
          {me.projects.length === 0 ? (
            <p className="gp-pad">你尚未加入任何專案，請聯絡管理者將你加入專案。</p>
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
        </Card>

        <Card title="顯示偏好">
          <fieldset className="gp-theme">
            <legend className="gp-theme__legend">介面主題</legend>
            <div className="gp-theme__options">
              {THEME_OPTIONS.map((o) => (
                <label key={o.value} className="gp-theme__option">
                  <input
                    type="radio"
                    name="ui-theme"
                    value={o.value}
                    checked={theme === o.value}
                    onChange={() => {
                      setTheme(o.value);
                      setSaved(null);
                    }}
                  />
                  {o.label}
                </label>
              ))}
            </div>
            <p className="text-muted gp-theme__hint">介面主題會套用於整個系統，只記在這台電腦的瀏覽器。</p>
          </fieldset>
        </Card>

        <Card title="安全性">
          <div className="gp-security">
            <span className="gp-security__label">密碼修改</span>
            <span>如需修改密碼，請前往院方帳號服務進行變更。</span>
            <a className="btn btn--secondary" href={keycloakAccountUrl()} target="_blank" rel="noreferrer">
              <Icon name="external" /> 前往院方帳號服務修改密碼
            </a>
          </div>
          {auth.mode === 'test' && <p className="text-muted">目前是測試登入模式，帳號頁不會有作用。</p>}
        </Card>

        <div className="gp-actions">
          <p role="status" className="gp-actions__status">
            {saved === 'ok' && '已儲存顯示偏好。'}
            {saved === 'fail' && '這個瀏覽器不允許儲存，主題只套用到這次開啟的畫面。'}
          </p>
          <button type="button" className="btn btn--primary" onClick={() => setSaved(saveTheme(theme) ? 'ok' : 'fail')}>
            儲存顯示偏好
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => void logout()}>
            登出
          </button>
        </div>
      </div>
    </>
  );
}

/** 功能目錄分組（B12）：研究功能 5 項、管理 3 項 */
const MANAGE_KEYS = new Set(['deployment', 'inference', 'llm']);

const ENTRY_ICONS: Record<string, IconName> = {
  admin: 'users',
  data: 'database',
  labeling: 'pen',
  'auto-labeling': 'doc',
  training: 'cube',
  deployment: 'server',
  inference: 'play',
  llm: 'chat',
};

function CatalogRows({ entries }: { entries: Entry[] }) {
  return (
    <>
      {entries.map((e) => (
        <tr key={e.key}>
          <td className="gp-cat__icon">
            <span className="gp-cat__icon-box">
              <Icon name={ENTRY_ICONS[e.key] ?? 'grid'} />
            </span>
          </td>
          <th scope="row" className="gp-cat__name">
            <Link to={e.path}>{e.label}</Link>
            {(e.aliases ?? []).map((a) => (
              <span key={a} className="gp-cat__alias">
                別名：<Link to={e.path}>{a}</Link>
              </span>
            ))}
          </th>
          <td className="gp-cat__place">{e.location}</td>
          <td className="gp-cat__desc">
            {e.description}
            <span className="gp-cat__code">模組 {e.moduleCode}</span>
          </td>
          <td className="gp-cat__open">
            <Link to={e.path} aria-label={`開啟${e.label}`}>
              開啟 <Icon name="arrow" />
            </Link>
          </td>
        </tr>
      ))}
    </>
  );
}

/** 功能目錄（B12）：依權限列出契約 8 個入口的原名稱與日常名稱，點了直接進入 */
export function CatalogPage() {
  const me = useMe();
  const { project } = useSession();
  const allowed = ENTRIES.filter((e) => checkAccess(e, me, project).allowed);
  const groups = [
    { key: 'research', title: '研究功能', entries: allowed.filter((e) => !MANAGE_KEYS.has(e.key)) },
    { key: 'manage', title: '管理', entries: allowed.filter((e) => MANAGE_KEYS.has(e.key)) },
  ].filter((g) => g.entries.length > 0);
  return (
    <>
      <PageHeader
        title="功能目錄"
        subtitle={`依照你在${project ? `專案「${project.name}」` : '目前帳號'}的權限，選擇功能進入使用與設定。`}
        actions={<Alert tone="info">選單依目前專案權限顯示。</Alert>}
      />
      {groups.length === 0 ? (
        <Alert tone="info">目前沒有可使用的功能。你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>
      ) : (
        <div className="ui-card ui-card--flush gp-cat">
          <table aria-label="功能目錄" className="gp-cat__table">
            <thead className="visually-hidden">
              <tr>
                <th scope="col">圖示</th>
                <th scope="col">功能名稱</th>
                <th scope="col">日常名稱</th>
                <th scope="col">說明</th>
                <th scope="col">開啟</th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.key} className="gp-cat__group">
                <tr className="gp-cat__group-head">
                  <td colSpan={5}>
                    <span className="gp-cat__group-title">{g.title}</span>
                    <span className="gp-cat__group-count">（{g.entries.length} 項）</span>
                  </td>
                </tr>
                <CatalogRows entries={g.entries} />
              </tbody>
            ))}
          </table>
        </div>
      )}
    </>
  );
}
