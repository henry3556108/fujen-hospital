// 資料集頁的「用這份資料建立訓練任務」（B1）：開啟建模管理的新增表單，帶入資料集、Target、Feature、前處理並預選種類。
// 只放在資料集頁標題下；需要 Training 權限（建模管理的入口規則），沒有時不顯示。
import { Link } from 'react-router-dom';
import { useHasPermission } from './ModelExport';

export function CreateTrainingLink({ datasetId }: { datasetId: number | string }) {
  if (!useHasPermission('training')) return null;
  return (
    <p className="row-actions">
      <Link className="btn btn--primary" to={`/training?dataset=${datasetId}`}>
        用這份資料建立訓練任務
      </Link>
      <span className="text-muted">會帶入這裡設定的 Target、Feature 與前處理，到「建模管理」確認後即可訓練。</span>
    </p>
  );
}
