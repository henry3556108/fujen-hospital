import { useMemo } from 'react';
import { useSession } from '../../auth/SessionContext';
import { llmApi, type LlmApi } from './api';

/** 目前專案的 LLM API；尚未選專案時回 null（入口守門會先擋下）。 */
export function useLlm(): { llm: LlmApi | null; projectName: string } {
  const { api, auth, project } = useSession();
  const llm = useMemo(
    () => (project ? llmApi(api, project.id, { auth, apiBase: import.meta.env.VITE_API_BASE ?? '' }) : null),
    [api, auth, project],
  );
  return { llm, projectName: project?.name ?? '' };
}
