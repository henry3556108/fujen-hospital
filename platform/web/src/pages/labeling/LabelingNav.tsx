import { Tabs } from '../../components/Tabs';

/** 影像標註區的分頁：待處理、標註資料集、自動標註。 */
export function LabelingNav() {
  return (
    <Tabs
      label="影像標註分頁"
      items={[
        { to: '/labeling', label: '待處理', end: true },
        { to: '/labeling/datasets', label: '標註資料集' },
        { to: '/labeling/auto', label: '自動標註' },
      ]}
    />
  );
}
