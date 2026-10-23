import { useSearchParams } from 'react-router-dom';
import { CorrelationTab } from './CorrelationTab';
import { DescribeTab } from './DescribeTab';
import { PreviewTab } from './PreviewTab';

/** 「查看資料」的三個段落；網址 ?show= 記住目前段落，可直接連結。 */
const SECTIONS = [
  { key: 'preview', label: '資料預覽' },
  { key: 'describe', label: '欄位統計' },
  { key: 'correlation', label: '相關與散佈圖' },
] as const;

type Section = (typeof SECTIONS)[number]['key'];

/** 查看資料：預覽（可隱藏欄位）、描述統計、相關矩陣與散佈圖。 */
export function ViewTab() {
  const [params, setParams] = useSearchParams();
  const show = (SECTIONS.find((s) => s.key === params.get('show'))?.key ?? 'preview') as Section;
  return (
    <>
      <div className="row-actions" role="group" aria-label="查看資料的段落">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`btn btn--small ${show === s.key ? 'btn--secondary is-active' : 'btn--ghost'}`}
            aria-pressed={show === s.key}
            onClick={() => setParams(s.key === 'preview' ? {} : { show: s.key }, { replace: true })}
          >
            {s.label}
          </button>
        ))}
      </div>
      <section className="section" aria-label={SECTIONS.find((s) => s.key === show)!.label}>
        {show === 'preview' && <PreviewTab />}
        {show === 'describe' && <DescribeTab />}
        {show === 'correlation' && <CorrelationTab />}
      </section>
    </>
  );
}
