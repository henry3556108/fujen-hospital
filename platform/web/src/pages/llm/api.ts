// WP7「LLM No-code 開發」的 API 型別與呼叫。回應形狀與 platform/api/app/llm 相同。
import { ApiError, type ApiClient } from '../../api/client';
import type { AuthAdapter } from '../../auth/adapter';

export interface GenerationParams {
  temperature: number;
  max_new_tokens: number;
  repetition_penalty: number;
  length_penalty: number;
  top_k: number;
  top_p: number;
  system_prompt: string;
}

export const PARAM_FIELDS: { key: keyof Omit<GenerationParams, 'system_prompt'>; label: string; min: number; max: number; step: number }[] = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.05 },
  { key: 'max_new_tokens', label: 'Max New Tokens', min: 1, max: 8192, step: 1 },
  { key: 'repetition_penalty', label: 'Repetition Penalty', min: 0.1, max: 2, step: 0.05 },
  { key: 'length_penalty', label: 'Length Penalty', min: -2, max: 2, step: 0.05 },
  { key: 'top_k', label: 'Top K', min: 1, max: 1000, step: 1 },
  { key: 'top_p', label: 'Top P', min: 0.01, max: 1, step: 0.01 },
];

export interface Source {
  document_id: number;
  filename: string;
  chunk_index: number;
  score: number;
  content?: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[];
  call_id: number | null;
}

export interface ChatReply {
  session_id: number;
  mode: 'free' | 'kb';
  model: string;
  message: ChatMessage;
  call_id: number;
  latency_ms: number;
}

export interface KnowledgeBase {
  id: number;
  name: string;
  description: string;
  embed_model: string;
  documents: number;
  chunks: number;
}

export interface KbDocument {
  id: number;
  filename: string;
  format: string;
  chunks: number;
  size: number;
  uploaded_by: string;
}

export interface UploadResult {
  counts: { indexed: number; duplicate: number; failed: number };
  results: { filename: string; status: 'indexed' | 'duplicate' | 'failed'; reason: string }[];
}

export interface PromptTemplate {
  id: number;
  owner: string;
  visibility: 'personal' | 'public';
  title: string;
  content: string;
  tags: string[];
}

export interface CatalogModel {
  name: string;
  source: string;
  repo: string;
  revision: string;
  sha256: string;
  license: string;
  requires_token: boolean;
  has_remote_code: boolean;
  installed: boolean;
  loaded: boolean;
  remote_code_approved: boolean;
}

export interface Download {
  id: number;
  name: string;
  status: 'pending' | 'approved' | 'rejected' | 'downloading' | 'completed' | 'failed';
  user: string;
  reviewer: string | null;
  commit: string | null;
  hash: string | null;
  time: string | null;
  mode: string | null;
  message: string;
  progress?: { done: number; total: number | null } | null;
}

/** 模型服務回報的實際載入狀態（Ollama：量化等級、執行緒數、在 GPU 或 CPU、顯示記憶體） */
export interface ModelRuntimeStatus {
  name: string;
  loaded: boolean;
  config: LoadConfig;
  runtime: {
    running: boolean;
    quantization_level?: string | null;
    quantization?: string;
    num_thread: number | null;
    processor: string | null;
    vram_bytes?: number | null;
    runtime: string;
  } | null;
}

export interface LoadConfig {
  quantization: 'none' | '4bit' | '8bit';
  cpu: number;
  memory_gb: number;
  gpu_type: 'gpu-exclusive' | 'gpu-shared' | 'cpu';
  gpu_count: number;
}

export interface PublishedService {
  id: number;
  slug: string;
  name: string;
  model: string;
  kb_id: number | null;
  enabled: boolean;
  grants: string[];
  endpoint: string;
}

export interface Workflow {
  id: number;
  name: string;
  description: string;
  definition: { state: Record<string, unknown>; entry: string; nodes: { id: string; type: string }[]; edges: string[][] };
}

export interface NodeRecord {
  seq: number;
  node: string;
  type: string;
  status: string;
  state_out: Record<string, unknown>;
  error: string;
  context_source: string | null;
  llm_request: unknown;
  llm_response: unknown;
}

export interface WorkflowRun {
  id: number;
  status: 'succeeded' | 'failed';
  error: string;
  final_state: Record<string, unknown> | null;
  nodes: NodeRecord[];
}

export interface WikiPageSummary {
  id: number;
  path: string;
  title: string;
  updated_by?: string;
}

export interface WikiPage extends WikiPageSummary {
  content: string;
  description: string;
}

export interface WikiVersion {
  version_id: number;
  date: string;
  author: string;
  action: string;
}

export interface WikiAnswer {
  answer: string;
  context_source: string;
  pages: { page_id: number; title: string; path: string }[];
  call_id: number;
}

/** 平台對模型服務的逾時是 25 秒；網頁再設一道上限，保證 30 秒內一定出現重試提示。 */
export const CHAT_TIMEOUT_MS = 28_000;

export class ChatTimeout extends ApiError {
  constructor() {
    super(504, '模型回應逾時，請重試', [], 'llm_timeout');
  }
}

/** 逾時或模型服務中斷：可以直接重試。 */
export function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'llm_timeout' || error.code === 'llm_unavailable' || error.status === 0);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ChatTimeout()), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function llmApi(api: ApiClient, projectId: number, options: { auth?: AuthAdapter; apiBase?: string } = {}) {
  const base = `/api/projects/${projectId}/llm`;
  return {
    // Playground
    chat: (body: { mode: 'free' | 'kb'; message: string; kb_id?: number | null; session_id?: number | null; prompt_id?: number | null }, timeoutMs = CHAT_TIMEOUT_MS) =>
      withTimeout(api.post<ChatReply>(`${base}/chat`, body), timeoutMs),
    getParams: () => api.get<GenerationParams>(`${base}/generation-params`),
    putParams: (p: GenerationParams) => api.put<GenerationParams>(`${base}/generation-params`, p),
    // 知識庫
    knowledgeBases: () => api.get<KnowledgeBase[]>(`${base}/knowledge-bases`),
    createKb: (name: string, description: string) => api.post<KnowledgeBase>(`${base}/knowledge-bases`, { name, description }),
    deleteKb: (id: number) => api.delete(`${base}/knowledge-bases/${id}`),
    documents: (id: number) => api.get<KbDocument[]>(`${base}/knowledge-bases/${id}/documents`),
    async upload(id: number, files: File[]): Promise<UploadResult> {
      // 多檔上傳用 multipart，不經 JSON 用的 ApiClient
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      const token = (await options.auth?.getUser())?.accessToken;
      const url = new URL(`${base}/knowledge-bases/${id}/documents`, options.apiBase || window.location.origin);
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', body: form, headers: token ? { Authorization: `Bearer ${token}` } : {} });
      } catch {
        throw new ApiError(0, '無法連線到伺服器，請確認網路或稍後再試');
      }
      const data = (await res.json().catch(() => null)) as { detail?: unknown } | null;
      if (!res.ok) {
        const d = data?.detail;
        throw new ApiError(res.status, typeof d === 'string' ? d : ((d as { message?: string })?.message ?? `上傳失敗（HTTP ${res.status}）`));
      }
      return data as unknown as UploadResult;
    },
    // Prompt 範本
    prompts: (q = '', tag = '') => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (tag) params.set('tag', tag);
      const qs = params.toString();
      return api.get<PromptTemplate[]>(`${base}/prompts${qs ? `?${qs}` : ''}`);
    },
    createPrompt: (p: Pick<PromptTemplate, 'title' | 'content' | 'tags' | 'visibility'>) => api.post<PromptTemplate>(`${base}/prompts`, p),
    deletePrompt: (id: number) => api.delete(`${base}/prompts/${id}`),
    // 模型
    catalog: () => api.get<CatalogModel[]>(`${base}/models/catalog`),
    downloads: () => api.get<Download[]>(`${base}/models/downloads`),
    requestDownload: (name: string) => api.post<Download>(`${base}/models/downloads`, { name }),
    executeDownload: (id: number, token: string) => api.post<Download>(`${base}/models/downloads/${id}/execute`, { token: token || null }),
    deleteModel: (name: string) => api.delete(`${base}/models/${name}`),
    getLoadConfig: (name: string) => api.get<LoadConfig>(`${base}/models/${name}/load-config`),
    putLoadConfig: (name: string, c: LoadConfig) => api.put<LoadConfig>(`${base}/models/${name}/load-config`, c),
    loadModel: (name: string) => api.post<{ loaded: boolean; trust_remote_code: boolean }>(`${base}/models/${name}/load`),
    unloadModel: (name: string) => api.post(`${base}/models/${name}/unload`),
    modelRuntime: (name: string) => api.get<ModelRuntimeStatus>(`${base}/models/${name}/runtime`),
    adminDownloads: () => api.get<Download[]>('/api/admin/llm/downloads'),
    review: (id: number, approve: boolean) => api.post<Download>(`/api/admin/llm/downloads/${id}/${approve ? 'approve' : 'reject'}`, {}),
    approveRemoteCode: (name: string) => api.post(`/api/admin/llm/models/${name}/remote-code-approval`),
    // 發布 API
    services: () => api.get<PublishedService[]>(`${base}/services`),
    publish: (body: { slug: string; name: string; kb_id: number | null; grants: string[] }) => api.post<PublishedService>(`${base}/services`, body),
    setGrants: (id: number, grants: string[]) => api.put<PublishedService>(`${base}/services/${id}/grants`, { grants }),
    setEnabled: (id: number, enabled: boolean) => api.patch<PublishedService>(`${base}/services/${id}`, { enabled }),
    unpublish: (id: number) => api.delete(`${base}/services/${id}`),
    // 工作流
    workflows: () => api.get<Workflow[]>(`${base}/workflows`),
    createWorkflow: (name: string, definition: unknown) => api.post<Workflow>(`${base}/workflows`, { name, definition }),
    deleteWorkflow: (id: number) => api.delete(`${base}/workflows/${id}`),
    runWorkflow: (id: number, input: unknown) => api.post<WorkflowRun>(`${base}/workflows/${id}/runs`, { input }),
    // Wiki
    wikiPages: () => api.get<WikiPageSummary[]>(`${base}/wiki/pages`),
    wikiPage: (id: number) => api.get<WikiPage>(`${base}/wiki/pages/${id}`),
    createWikiPage: (p: { path: string; title: string; content: string }) => api.post<WikiPage>(`${base}/wiki/pages`, p),
    updateWikiPage: (id: number, p: { title: string; content: string }) => api.put<WikiPage>(`${base}/wiki/pages/${id}`, p),
    deleteWikiPage: (id: number) => api.delete(`${base}/wiki/pages/${id}`),
    wikiHistory: (id: number) => api.get<WikiVersion[]>(`${base}/wiki/pages/${id}/history`),
    wikiVersion: (id: number, version: number) => api.get<{ content: string; title: string }>(`${base}/wiki/pages/${id}/history/${version}`),
    wikiSearch: (q: string) => api.get<WikiPageSummary[]>(`${base}/wiki/search?q=${encodeURIComponent(q)}`),
    wikiAsk: (question: string, pageId: number) => withTimeout(api.post<WikiAnswer>(`${base}/wiki/ask`, { question, page_id: pageId }), CHAT_TIMEOUT_MS),
  };
}

export type LlmApi = ReturnType<typeof llmApi>;
