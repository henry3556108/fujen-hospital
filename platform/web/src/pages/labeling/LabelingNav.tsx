import { Tabs } from '../../components/Tabs';

/** 影像標註各頁標題下的說明 */
export const LABELING_SUBTITLE = '確認影像的分類、位置與範圍，整理成可以拿去訓練的標註資料集。';

/** 影像標註區的分頁：待處理影像、標註資料集、自動標註（設計稿 A04）。 */
export function LabelingNav() {
  return (
    <Tabs
      label="影像標註分頁"
      items={[
        { to: '/labeling', label: '待處理影像', end: true },
        { to: '/labeling/datasets', label: '標註資料集' },
        { to: '/labeling/auto', label: '自動標註' },
      ]}
    />
  );
}
