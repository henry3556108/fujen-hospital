import { NavLink } from 'react-router-dom';

export interface TabItem {
  to: string;
  label: string;
  /** true = 只有路徑完全相同才算選中（用於分頁的首頁） */
  end?: boolean;
}

/** 分頁導覽：每個分頁是一個網址，可直接連結與重新載入。 */
export function Tabs({ label, items }: { label: string; items: TabItem[] }) {
  return (
    <nav aria-label={label} className="tabs">
      {items.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className="tabs__item">
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
