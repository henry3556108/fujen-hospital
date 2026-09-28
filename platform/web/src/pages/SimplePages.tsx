import { Link } from 'react-router-dom';
import type { Entry } from '../access/entries';
import { visibleEntries } from '../access/entries';
import { useMe, useSession } from '../auth/SessionContext';
import { Alert } from '../components/Alert';
import { Icon } from '../components/Icon';

export function HomePage() {
  const me = useMe();
  const { project } = useSession();
  const entries = visibleEntries(me, project);
  return (
    <>
      <h1>首頁</h1>
      {me.account_type !== 'admin' && !project ? (
        <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>
      ) : (
        <p className="text-muted">
          目前專案：<strong>{project?.name ?? '（無）'}</strong>。以下為你可使用的功能。
        </p>
      )}
      <ul className="entry-grid">
        {entries.map((e) => (
          <li key={e.key}>
            <Link to={e.path} className="entry-card card">
              <span className="entry-card__title">{e.label}</span>
              <span className="entry-card__desc">{e.description}</span>
              {e.placeholder && <span className="badge badge--m2">M2</span>}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ModulePlaceholder({ entry }: { entry: Entry }) {
  return (
    <>
      <h1>{entry.label}</h1>
      <section className="placeholder card" aria-labelledby="placeholder-title">
        <span className="badge badge--m2">M2 預告</span>
        <h2 id="placeholder-title">此功能將於 M2 提供</h2>
        <p>模組代碼：{entry.moduleCode}</p>
        <p className="text-muted">{entry.description}。目前為頁面骨架，入口與權限檢查已可使用。</p>
      </section>
    </>
  );
}

export function AccessDenied({ reason }: { reason: string }) {
  return (
    <section className="denied card" aria-labelledby="denied-title">
      <Icon name="lock" className="denied__icon" />
      <h1 id="denied-title">無法存取此功能</h1>
      <p>{reason}</p>
      <p className="text-muted">如需使用，請聯絡專案負責人或系統管理者調整權限。</p>
      <Link to="/">回首頁</Link>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <>
      <h1>找不到頁面</h1>
      <p>網址可能輸入錯誤，或頁面已移除。</p>
      <Link to="/">回首頁</Link>
    </>
  );
}
