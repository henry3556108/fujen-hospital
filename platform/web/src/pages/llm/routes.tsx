import { Navigate, Route } from 'react-router-dom';
import { KnowledgePage } from './KnowledgePage';
import { LlmLayout } from './LlmLayout';
import { ModelsPage } from './ModelsPage';
import { PlaygroundPage } from './PlaygroundPage';
import { PromptsPage } from './PromptsPage';
import { ServicesPage } from './ServicesPage';
import { WikiPage } from './WikiPage';
import { WorkflowsPage } from './WorkflowsPage';
import './llm.css';

export { LlmApprovalsPanel } from './LlmApprovalsPanel';

/** /llm/* 底下的分頁（相對路徑）。入口權限由 App.tsx 檢查。 */
export function llmRoutes() {
  return (
    <Route element={<LlmLayout />}>
      <Route index element={<Navigate to="chat" replace />} />
      <Route path="chat" element={<PlaygroundPage />} />
      <Route path="docs" element={<KnowledgePage />} />
      <Route path="prompts" element={<PromptsPage />} />
      <Route path="services" element={<ServicesPage />} />
      <Route path="models" element={<ModelsPage />} />
      <Route path="workflows" element={<WorkflowsPage />} />
      <Route path="wiki" element={<WikiPage />} />
      <Route path="playground" element={<Navigate to="/llm/chat" replace />} />
      <Route path="knowledge" element={<Navigate to="/llm/docs" replace />} />
    </Route>
  );
}
