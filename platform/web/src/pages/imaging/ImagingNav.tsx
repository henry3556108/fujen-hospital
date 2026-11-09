import { Tabs } from '../../components/Tabs';

/** 影像區的頁內分頁（數據管理區的外框不再有影像分頁列）。 */
export function ImagingNav() {
  return (
    <Tabs
      label="影像分頁"
      items={[
        { to: '/data/imaging', label: '影像清單', end: true },
        { to: '/data/imaging/jobs', label: '匯入紀錄' },
        { to: '/data/imaging/allowlist', label: 'Accession Number 清單' },
      ]}
    />
  );
}
