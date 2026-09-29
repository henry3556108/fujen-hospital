import { NavLink, Outlet } from 'react-router-dom';
import { Alert } from '../../components/Alert';
import { useSession } from '../../auth/SessionContext';

export const LLM_TABS = [
  { to: '/llm/playground', label: 'Playground' },
  { to: '/llm/models', label: '模型管理' },
  { to: '/llm/prompts', label: 'Prompt 範本' },
  { to: '/llm/knowledge', label: '知識庫' },
  { to: '/llm/services', label: '發布 API' },
  { to: '/llm/workflows', label: '工作流' },
  { to: '/llm/wiki', label: 'Wiki' },
];

export function LlmLayout() {
  const { project } = useSession();
  return (
    <>
      <h1>LLM No-code 開發</h1>
      <nav aria-label="LLM 功能分頁" className="tabs">
        {LLM_TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className="tabs__item">
            {t.label}
          </NavLink>
        ))}
      </nav>
      {project ? <Outlet /> : <Alert tone="info">請先在上方選擇專案。</Alert>}
    </>
  );
}
