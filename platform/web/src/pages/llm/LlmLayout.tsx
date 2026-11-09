import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/ui';
import { useSession } from '../../auth/SessionContext';

/** 大型語言模型的七個分頁（依使用順序；名稱依契約 B-07、B-08，說明放在提示文字）。 */
export const LLM_TABS = [
  { to: '/llm/chat', label: 'LLM Playground', hint: 'Free Chat 與 Chat with Knowledge Base' },
  { to: '/llm/docs', label: 'RAG 知識庫', hint: '把文件製作成向量資料庫（Vector DB）' },
  { to: '/llm/prompts', label: 'Prompt Template', hint: '個人 Prompt 與公開 Prompt' },
  { to: '/llm/services', label: '內部服務', hint: '開啟為內部服務並提供 RESTful API' },
  { to: '/llm/models', label: 'LLM 模型管理', hint: '下載、載入、量化與資源' },
  { to: '/llm/workflows', label: 'LangGraph 工作流', hint: '多步驟節點與狀態管理' },
  { to: '/llm/wiki', label: 'Wiki 知識庫', hint: '文件編輯、版本管理與全文檢索' },
];

function LlmTabs() {
  return (
    <nav aria-label="大型語言模型分頁" className="tabs">
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
        <LlmHeader title="大型語言模型" />
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
