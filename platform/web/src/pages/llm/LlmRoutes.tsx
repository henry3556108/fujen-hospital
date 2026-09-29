import { Navigate, Route, Routes } from 'react-router-dom';
import { KnowledgePage } from './KnowledgePage';
import { LlmLayout } from './LlmLayout';
import { ModelsPage } from './ModelsPage';
import { PlaygroundPage } from './PlaygroundPage';
import { PromptsPage } from './PromptsPage';
import { ServicesPage } from './ServicesPage';
import { WikiPage } from './WikiPage';
import { WorkflowsPage } from './WorkflowsPage';
import './llm.css';

/** /llm/* 底下的分頁。入口權限（coding）由 App.tsx 的 EntryGuard 檢查。 */
export function LlmRoutes() {
  return (
    <Routes>
      <Route element={<LlmLayout />}>
        <Route index element={<Navigate to="playground" replace />} />
        <Route path="playground" element={<PlaygroundPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="prompts" element={<PromptsPage />} />
        <Route path="knowledge" element={<KnowledgePage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="workflows" element={<WorkflowsPage />} />
        <Route path="wiki" element={<WikiPage />} />
      </Route>
    </Routes>
  );
}
