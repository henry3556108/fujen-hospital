// WP7 LLM API 的 MSW 模擬（回應形狀照 platform/api/app/llm）。
// 故障注入給瀏覽器測試用：POST /api/__mock/llm-fault {mode: 'none' | 'down' | 'hang'}。
import { delay, http, HttpResponse, type JsonBodyType } from 'msw';

type Fault = 'none' | 'down' | 'hang';

interface LlmMock {
  fault: Fault;
  params: Record<string, unknown>;
  kbs: { id: number; name: string; description: string; embed_model: string; documents: number; chunks: number }[];
  docs: { id: number; kb_id: number; filename: string; format: string; chunks: number; size: number; uploaded_by: string }[];
  prompts: { id: number; owner: string; visibility: string; title: string; content: string; tags: string[] }[];
  services: { id: number; slug: string; name: string; model: string; kb_id: number | null; enabled: boolean; grants: string[]; endpoint: string }[];
  workflows: { id: number; name: string; description: string; definition: Record<string, unknown> }[];
  pages: { id: number; path: string; title: string; content: string; description: string; versions: string[] }[];
  sessions: number;
  next: number;
}

const DEFAULT_PARAMS = {
  temperature: 0.7, max_new_tokens: 512, repetition_penalty: 1, length_penalty: 1, top_k: 50, top_p: 0.9, system_prompt: '',
};

function seed(): LlmMock {
  return {
    fault: 'none',
    params: { ...DEFAULT_PARAMS },
    kbs: [{ id: 1, name: '院內作業規範', description: '', embed_model: 'fake-embed-small', documents: 6, chunks: 6 }],
    docs: [],
    prompts: [{ id: 1, owner: 'ca01', visibility: 'public', title: '出院摘要', content: '請整理成出院摘要：{input}', tags: ['摘要'] }],
    services: [],
    workflows: [],
    pages: [],
    sessions: 0,
    next: 100,
  };
}

let db = seed();
export function resetLlmMock(): void {
  db = seed();
}

const json = (body: unknown, status = 200) => HttpResponse.json(body as JsonBodyType, { status });
const P = '*/api/projects/:pid/llm';

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export const llmHandlers = [
  http.post('*/api/__mock/llm-fault', async ({ request }) => {
    db.fault = ((await body(request)).mode as Fault) ?? 'none';
    return json({ fault: db.fault });
  }),

  // ---- Playground
  http.post(`${P}/chat`, async ({ request }) => {
    const b = await body(request);
    if (db.fault === 'down') return json({ detail: { code: 'llm_unavailable', message: '模型服務中斷，請稍後重試', retry: true } }, 503);
    if (db.fault === 'hang') await delay('infinite');
    if (b.mode === 'kb' && !b.kb_id) return json({ detail: 'Chat with Knowledge Base 需要指定知識庫' }, 422);
    const session = (b.session_id as number | null) ?? ++db.sessions;
    const sources = b.mode === 'kb' ? [{ document_id: 1, filename: 'outpatient_hours.pdf', chunk_index: 0, score: 0.8 }] : [];
    return json({
      session_id: session,
      mode: b.mode,
      model: 'fake-llm-small',
      message: { id: ++db.next, role: 'assistant', content: `[fake-llm] echo: ${b.message}`, sources, call_id: db.next },
      call_id: db.next,
      latency_ms: 5,
    });
  }),
  http.get(`${P}/generation-params`, () => json(db.params)),
  http.put(`${P}/generation-params`, async ({ request }) => {
    db.params = await body(request);
    return json(db.params);
  }),

  // ---- 知識庫
  http.get(`${P}/knowledge-bases`, () => json(db.kbs)),
  http.post(`${P}/knowledge-bases`, async ({ request }) => {
    const b = await body(request);
    if (!b.name) return json({ detail: [{ type: 'string_too_short', loc: ['body', 'name'], msg: 'x' }] }, 422);
    if (db.kbs.some((k) => k.name === b.name)) return json({ detail: `專案內已有知識庫「${b.name}」` }, 409);
    const kb = { id: ++db.next, name: String(b.name), description: String(b.description ?? ''), embed_model: 'fake-embed-small', documents: 0, chunks: 0 };
    db.kbs.push(kb);
    return json(kb, 201);
  }),
  http.delete(`${P}/knowledge-bases/:id`, ({ params }) => {
    db.kbs = db.kbs.filter((k) => k.id !== Number(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${P}/knowledge-bases/:id/documents`, ({ params }) => json(db.docs.filter((d) => d.kb_id === Number(params.id)))),
  http.post(`${P}/knowledge-bases/:id/documents`, async ({ request, params }) => {
    const form = await request.formData();
    const kb = db.kbs.find((k) => k.id === Number(params.id))!;
    const results = form.getAll('files').map((f) => {
      const file = f as File;
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (!['pdf', 'docx', 'txt', 'csv', 'json', 'html'].includes(ext)) {
        return { filename: file.name, status: 'failed', reason: '不支援的檔案格式', document: null };
      }
      const doc = { id: ++db.next, kb_id: kb.id, filename: file.name, format: ext, chunks: 1, size: file.size, uploaded_by: 'ca01' };
      db.docs.push(doc);
      kb.documents++;
      kb.chunks++;
      return { filename: file.name, status: 'indexed', reason: '', document: doc };
    });
    const count = (s: string) => results.filter((r) => r.status === s).length;
    return json({ kb_id: kb.id, counts: { indexed: count('indexed'), duplicate: 0, failed: count('failed') }, results }, 201);
  }),

  // ---- Prompt
  http.get(`${P}/prompts`, ({ request }) => {
    const q = new URL(request.url).searchParams.get('q') ?? '';
    return json(db.prompts.filter((p) => !q || p.title.includes(q) || p.content.includes(q) || p.tags.some((t) => t.includes(q))));
  }),
  http.post(`${P}/prompts`, async ({ request }) => {
    const b = await body(request);
    const p = { id: ++db.next, owner: 'me', visibility: String(b.visibility), title: String(b.title), content: String(b.content), tags: (b.tags as string[]) ?? [] };
    db.prompts.push(p);
    return json(p, 201);
  }),
  http.delete(`${P}/prompts/:id`, ({ params }) => {
    db.prompts = db.prompts.filter((p) => p.id !== Number(params.id));
    return new HttpResponse(null, { status: 204 });
  }),

  // ---- 模型
  http.get(`${P}/models/catalog`, () =>
    json([
      { name: 'fake-llm-small', source: 'models.test.invalid', repo: 'fake-org/fake-llm-small', revision: 'a'.repeat(40), sha256: 'f'.repeat(64),
        license: 'apache-2.0', requires_token: false, has_remote_code: false, installed: false, loaded: false, remote_code_approved: false },
    ]),
  ),
  http.get(`${P}/models/downloads`, () => json([])),
  http.get('*/api/admin/llm/downloads', () => json([])),

  // ---- 發布 API
  http.get(`${P}/services`, () => json(db.services)),
  http.post(`${P}/services`, async ({ request }) => {
    const b = await body(request);
    const s = { id: ++db.next, slug: String(b.slug), name: String(b.name), model: 'fake-llm-small', kb_id: (b.kb_id as number) ?? null,
      enabled: true, grants: (b.grants as string[]) ?? [], endpoint: `/api/llm-services/${b.slug}/invoke` };
    db.services.push(s);
    return json(s, 201);
  }),

  // ---- 工作流
  http.get(`${P}/workflows`, () => json(db.workflows)),
  http.post(`${P}/workflows`, async ({ request }) => {
    const b = await body(request);
    const w = { id: ++db.next, name: String(b.name), description: '', definition: b.definition as Record<string, unknown> };
    db.workflows.push(w);
    return json(w, 201);
  }),
  http.post(`${P}/workflows/:id/runs`, () =>
    json({ id: ++db.next, status: 'succeeded', error: '', final_state: { answer: '答覆：…' },
      nodes: ['retrieve', 'draft', 'final'].map((node, i) => ({ seq: i + 1, node, type: node === 'draft' ? 'llm' : 'template', status: 'succeeded',
        state_out: {}, error: '', context_source: node === 'draft' ? 'vector' : null, llm_request: null, llm_response: null })) }, 201),
  ),

  // ---- Wiki
  http.get(`${P}/wiki/pages`, () => json(db.pages.map(({ id, path, title }) => ({ id, path, title })))),
  http.post(`${P}/wiki/pages`, async ({ request }) => {
    const b = await body(request);
    const page = { id: ++db.next, path: String(b.path), title: String(b.title), content: String(b.content), description: '', versions: [] as string[] };
    db.pages.push(page);
    return json(page, 201);
  }),
  http.get(`${P}/wiki/pages/:id`, ({ params }) => {
    const page = db.pages.find((p) => p.id === Number(params.id));
    return page ? json(page) : json({ detail: '找不到 Wiki 頁面' }, 404);
  }),
  http.put(`${P}/wiki/pages/:id`, async ({ request, params }) => {
    const page = db.pages.find((p) => p.id === Number(params.id))!;
    const b = await body(request);
    page.versions.push(page.content);
    page.title = String(b.title);
    page.content = String(b.content);
    return json(page);
  }),
  http.get(`${P}/wiki/pages/:id/history`, ({ params }) => {
    const page = db.pages.find((p) => p.id === Number(params.id))!;
    return json(page.versions.map((_, i) => ({ version_id: i + 1, date: '2026-09-29T00:00:00Z', author: 'platform', action: i ? 'edit' : 'initial' })));
  }),
  http.get(`${P}/wiki/pages/:id/history/:v`, ({ params }) => {
    const page = db.pages.find((p) => p.id === Number(params.id))!;
    return json({ title: page.title, content: page.versions[Number(params.v) - 1] });
  }),
  http.get(`${P}/wiki/search`, ({ request }) => {
    const q = new URL(request.url).searchParams.get('q') ?? '';
    return json(db.pages.filter((p) => p.content.includes(q) || p.title.includes(q)).map(({ id, path, title }) => ({ id, path, title })));
  }),
  http.post(`${P}/wiki/ask`, async ({ request }) => {
    const b = await body(request);
    const page = db.pages.find((p) => p.id === b.page_id)!;
    return json({ answer: `[fake-llm] context: ${page.content.slice(0, 20)} | echo: ${b.question}`, context_source: 'wiki_api',
      pages: [{ page_id: page.id, title: page.title, path: page.path }], call_id: ++db.next });
  }),
];
