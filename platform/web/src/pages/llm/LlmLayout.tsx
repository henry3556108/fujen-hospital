import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/ui';
import { useSession } from '../../auth/SessionContext';

/** 語言模型的七個分頁（依使用順序；用語照提案第 5 節，原名放在說明）。 */
export const LLM_TABS = [
  { to: '/llm/chat', label: '對話', hint: '原 Playground' },
  { to: '/llm/docs', label: '參考文件', hint: '原知識庫' },
  { to: '/llm/prompts', label: '問答範本', hint: '原 Prompt 範本' },
  { to: '/llm/services', label: '內部服務', hint: '原發布 API' },
  { to: '/llm/models', label: '模型', hint: '下載、載入、量化與資源' },
  { to: '/llm/workflows', label: '工作流程', hint: '原工作流' },
  { to: '/llm/wiki', label: '團隊文件', hint: '原 Wiki' },
];

function LlmTabs() {
  return (
    <nav aria-label="語言模型分頁" className="tabs">
      {LLM_TABS.map((t) => (
        <NavLink key={t.to} to={t.to} className="tabs__item" title={t.hint}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** 每個分頁自己的標題列（設計稿 A08、B13～B16），標題下方固定是七個分頁。 */
export function LlmHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <PageHeader title={title} subtitle={subtitle} actions={actions}>
      <LlmTabs />
    </PageHeader>
  );
}

export function LlmLayout() {
  const { project } = useSession();
  if (!project) {
    return (
      <>
        <LlmHeader title="語言模型" />
        <Alert tone="info">請先在上方選擇專案。</Alert>
      </>
    );
  }
  return (
    <div className="llm-page">
      <Outlet />
    </div>
  );
}
