import { useSearchParams } from 'react-router-dom';
import { CorrelationTab } from './CorrelationTab';
import { DescribeTab } from './DescribeTab';
import { PreviewTab } from './PreviewTab';
import { StatsTab } from './StatsTab';

/** 「資料視覺化」的四個段落（B09）；網址 ?show= 記住目前段落，可直接連結。醫學統計分析與上方「醫學統計分析」分頁是同一個功能。 */
const SECTIONS = [
  { key: 'preview', label: '資料預覽' },
  { key: 'describe', label: '欄位描述性統計' },
  { key: 'correlation', label: 'Correlation Matrix 與 Scatter Chart' },
  { key: 'stats', label: '醫學統計分析' },
] as const;

type Section = (typeof SECTIONS)[number]['key'];

/** 資料視覺化：預覽（可隱藏欄位）、描述性統計、Correlation Matrix 與 Scatter Chart、醫學統計分析。 */
export function ViewTab() {
  const [params, setParams] = useSearchParams();
  const show = (SECTIONS.find((s) => s.key === params.get('show'))?.key ?? 'preview') as Section;
  return (
    <>
      <div className="tabs rd-tabs" role="group" aria-label="資料視覺化的段落">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            className="tabs__item"
            aria-pressed={show === s.key}
            onClick={() => setParams(s.key === 'preview' ? {} : { show: s.key }, { replace: true })}
          >
            {s.label}
          </button>
        ))}
      </div>
      <section aria-label={SECTIONS.find((s) => s.key === show)!.label}>
        {show === 'preview' && <PreviewTab />}
        {show === 'describe' && <DescribeTab />}
        {show === 'correlation' && <CorrelationTab />}
        {show === 'stats' && <StatsTab />}
      </section>
    </>
  );
}
