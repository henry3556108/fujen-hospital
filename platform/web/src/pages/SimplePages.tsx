import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';

export function AccessDenied({ reason }: { reason: string }) {
  return (
    <section className="denied card" aria-labelledby="denied-title">
      <Icon name="lock" className="denied__icon" />
      <h1 id="denied-title">無法存取此功能</h1>
      <p>{reason}</p>
      <p className="text-muted">如需使用，請聯絡專案負責人或系統管理者調整權限。</p>
      <p>
        <Link to="/">回專案首頁</Link>　<Link to="/catalog">看功能目錄</Link>
      </p>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <>
      <h1>找不到頁面</h1>
      <p>網址可能輸入錯誤，或頁面已移除。可以從功能目錄找到要用的功能。</p>
      <p>
        <Link to="/">回專案首頁</Link>　<Link to="/catalog">看功能目錄</Link>
      </p>
    </>
  );
}
