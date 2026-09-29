import { Link } from 'react-router-dom';
import type { Entry } from '../../access/entries';
import { ModulePlaceholder } from '../SimplePages';
import '../../styles/pages.css';

/** 建模管理（B-05）在訓練功能完成前仍是骨架頁；排程工作（WP4）已可使用，從這裡進入。 */
export function TrainingLanding({ entry }: { entry: Entry }) {
  return (
    <>
      <ModulePlaceholder entry={entry} />
      <section className="section" aria-labelledby="training-available">
        <h2 id="training-available">已可使用</h2>
        <Link to="/training/jobs" className="card link-card">
          <span className="link-card__title">專案工作</span>
          <span>送出排程工作、查看排隊與執行狀態、取消工作</span>
        </Link>
      </section>
    </>
  );
}
