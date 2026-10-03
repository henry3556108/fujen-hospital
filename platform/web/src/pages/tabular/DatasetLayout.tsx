import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { Tabs } from '../../components/Tabs';
import { CreateTrainingLink } from '../training/CreateTrainingLink';
import type { CatalogueItem, DatasetDetail, Step, TargetFeature } from './types';

export interface DatasetContext {
  dataset: DatasetDetail;
  /** API 路徑前綴：/api/projects/{pid}/tabular/datasets/{id} */
  base: string;
  catalogue: CatalogueItem[];
  /** 目前編輯中的前處理步驟；「前處理」「Target／Feature」「統計分析」共用 */
  steps: Step[];
  setSteps: (steps: Step[]) => void;
  saved: TargetFeature | null;
  setSaved: (tf: TargetFeature) => void;
}

export const useDataset = () => useOutletContext<DatasetContext>();

/** 資料集分頁與一行說明（「描述統計」與「統計分析」名稱相近，用說明分清楚）。 */
export const TABS = [
  { path: 'describe', label: '描述統計', hint: '每一欄的平均、範圍與分布，先看資料長什麼樣子。' },
  { path: 'preview', label: '預覽', hint: '逐列看原始資料。' },
  { path: 'target', label: 'Target／Feature', hint: '選要預測的結果與用來預測的資料，之後可以直接建立訓練。' },
  { path: 'preprocess', label: '前處理', hint: '進階：轉換或清理欄位。大多數人不需要，Target／Feature 會自動處理類別欄位與缺值。' },
  { path: 'correlation', label: '相關與散佈圖', hint: '看兩個數字欄位是否一起變高或變低。' },
  { path: 'stats', label: '統計分析', hint: '找出哪些因素和結果有關（邏輯斯／線性迴歸、存活分析、Cox 模型），附 p 值與信賴區間；和訓練模型無關。' },
] as const;

/** 單一資料集的外框：載入欄位資訊、前處理方法清單與已儲存的 Target／Feature 設定。 */
export function DatasetLayout() {
  const { api, project } = useSession();
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
      <p>
        <Link to="/data/tabular">回資料集列表</Link>
      </p>
      <ApiErrorAlert error={dataset.error} />
      <ApiErrorAlert error={catalogue.error} />
      <ApiErrorAlert error={saved.error} />
      {!dataset.error && !ready && <p role="status">載入中…</p>}
      {ready && !dataset.error && (
        <>
          <h2>資料集：{d.name}</h2>
          <p className="text-muted">
            {d.valid_rows} 列、{d.columns.length} 欄（上傳時拒絕 {d.rejected_rows} 列）。資料集上傳後不可修改，前處理只作用在副本上。
          </p>
          <CreateTrainingLink datasetId={d.id} />
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
