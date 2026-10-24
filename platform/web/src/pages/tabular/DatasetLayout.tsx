import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { formatTime } from '../../components/format';
import { Icon } from '../../components/Icon';
import { Tabs } from '../../components/Tabs';
import { useProjectAccess } from '../data/access';
import type { CatalogueItem, DatasetDetail, Step, TargetFeature } from './types';

export interface DatasetContext {
  dataset: DatasetDetail;
  /** API 路徑前綴：/api/projects/{pid}/tabular/datasets/{id} */
  base: string;
  catalogue: CatalogueItem[];
  /** 目前編輯中的整理步驟；「整理資料」「統計分析」共用 */
  steps: Step[];
  setSteps: (steps: Step[]) => void;
  saved: TargetFeature | null;
  setSaved: (tf: TargetFeature) => void;
}

export const useDataset = () => useOutletContext<DatasetContext>();

/** 資料集的三個分頁與一行說明。 */
export const TABS = [
  { path: 'view', label: '查看資料', hint: '逐列預覽、每一欄的平均與分布、欄位之間的相關。' },
  { path: 'prepare', label: '整理資料', hint: '選想預測的欄位與用來預測的欄位，處理缺值與格式，在本頁儲存。' },
  { path: 'stats', label: '統計分析', hint: '找出哪些因素和結果有關（邏輯斯／線性迴歸、存活分析、Cox 模型），附 p 值與信賴區間；和建立模型無關。' },
] as const;

/** 單一資料集的外框：頁首固定顯示名稱、筆數、欄數；載入欄位資訊、整理方法清單與已儲存的設定。 */
export function DatasetLayout() {
  const { api, project } = useSession();
  const { can } = useProjectAccess();
  const { datasetId = '' } = useParams();
  const { pathname } = useLocation();
  const pid = project!.id;
  const base = `/api/projects/${pid}/tabular/datasets/${datasetId}`;
  const dataset = useResource(() => api.get<DatasetDetail>(base), [base]);
  const catalogue = useResource(() => api.get<CatalogueItem[]>(`/api/projects/${pid}/tabular/preprocessing/catalogue`), [pid]);
  const saved = useResource(async () => {
    try {
      return await api.get<TargetFeature>(`${base}/target-feature`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null; // 尚未設定
      throw e;
    }
  }, [base]);
  const [steps, setSteps] = useState<Step[]>([]);

  useEffect(() => {
    if (saved.data) setSteps(saved.data.config.steps);
  }, [saved.data]);

  const root = `/data/tabular/${datasetId}`;
  const tabs = TABS.map((t) => ({ to: `${root}/${t.path}`, label: t.label }));
  const current = TABS.find((t) => pathname.startsWith(`${root}/${t.path}`));
  const d = dataset.data;
  const ready = d && catalogue.data && !saved.loading;

  return (
    <>
      <p className="rd-crumbs">
        <Link to="/data/tabular">
          <Icon name="chevron-left" /> 回表格資料清單
        </Link>
      </p>
      <ApiErrorAlert error={dataset.error} />
      <ApiErrorAlert error={catalogue.error} />
      <ApiErrorAlert error={saved.error} />
      {!dataset.error && !ready && <p role="status">載入中…</p>}
      {ready && !dataset.error && (
        <>
          <header className="rd-dataset-head dataset-head">
            <div>
              <h2>資料集：{d.name}</h2>
              <p className="text-muted" data-testid="dataset-size">
                {d.valid_rows} 筆・{d.columns.length} 個欄位
                {d.rejected_rows ? `（上傳時拒絕 ${d.rejected_rows} 列）` : ''}。原始資料不會被修改，整理步驟只套用在副本上。
              </p>
            </div>
            <div className="rd-dataset-head__side">
              {saved.data && (
                <span className="text-muted" data-testid="dataset-updated">
                  整理設定最後更新 {formatTime(saved.data.updated_at)}
                </span>
              )}
              {can('training') && (
                <Link className="btn btn--secondary" to={`/training/new?tabular=${d.id}`}>
                  用這份資料建立模型
                </Link>
              )}
            </div>
          </header>
          <Tabs label="資料集分頁" items={tabs} />
          {current ? (
            <p className="text-muted tab-hint" data-testid="tab-hint">
              {current.label}：{current.hint}
            </p>
          ) : null}
          <Outlet
            context={
              {
                dataset: d,
                base,
                catalogue: catalogue.data!,
                steps,
                setSteps,
                saved: saved.data,
                setSaved: (tf) => saved.setData(tf),
              } satisfies DatasetContext
            }
          />
        </>
      )}
    </>
  );
}
