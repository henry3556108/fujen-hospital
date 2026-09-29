import { useEffect, useState } from 'react';
import { Link, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { ApiErrorAlert } from '../../components/Alert';
import { Tabs } from '../../components/Tabs';
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

/** 單一資料集的外框：載入欄位資訊、前處理方法清單與已儲存的 Target／Feature 設定。 */
export function DatasetLayout() {
  const { api, project } = useSession();
  const { datasetId = '' } = useParams();
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
  const tabs = [
    { to: root, label: '預覽', end: true },
    { to: `${root}/describe`, label: '描述統計' },
    { to: `${root}/target`, label: 'Target／Feature' },
    { to: `${root}/preprocess`, label: '前處理' },
    { to: `${root}/correlation`, label: '相關與散佈圖' },
    { to: `${root}/stats`, label: '統計分析' },
  ];
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
          <Tabs label="資料集分頁" items={tabs} />
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
