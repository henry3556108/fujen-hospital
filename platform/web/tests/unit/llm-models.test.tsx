// 模型管理：申請下載後的狀態、載入設定只送設定欄位（API 不接受多餘欄位）。
import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { renderApp } from '../render';

const P = '*/api/projects/:pid/llm';
const CONFIG_FIELDS = ['cpu', 'gpu_count', 'gpu_type', 'memory_gb', 'quantization'];

function catalog(installed: boolean, loaded: boolean) {
  return http.get(`${P}/models/catalog`, () =>
    HttpResponse.json([{ name: 'gemma-test', source: 'huggingface.co', repo: 'org/gemma-test', revision: 'a'.repeat(40), sha256: 'f'.repeat(64),
      license: 'gemma', requires_token: false, has_remote_code: false, installed, loaded, remote_code_approved: false }]));
}

describe('模型管理', () => {
  it('a requested download shows 申請中 and no second 申請下載 button', async () => {
    const downloads: Record<string, unknown>[] = [];
    server.use(
      catalog(false, false),
      http.get(`${P}/models/downloads`, () => HttpResponse.json(downloads)),
      http.post(`${P}/models/downloads`, async ({ request }) => {
        const { name } = (await request.json()) as { name: string };
        const d = { id: 1, name, status: 'pending', requested_by: 'ca01', reviewed_by: null, commit: null, sha256: null, created_at: '2026-10-13T00:00:00Z' };
        downloads.push(d);
        return HttpResponse.json(d, { status: 201 });
      }),
    );
    const { user } = await renderApp('/llm/models', 'ca01');
    const row = (await screen.findByRole('rowheader', { name: 'gemma-test' })).closest('tr')!;
    expect(within(row).getByText('可申請')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: '申請下載' }));
    await waitFor(() => expect(within(row).getByText('申請中')).toBeInTheDocument());
    expect(within(row).queryByRole('button', { name: '申請下載' })).not.toBeInTheDocument();
  });

  it('套用並重新載入 sends only the five load settings', async () => {
    const sent: Record<string, unknown>[] = [];
    let loads = 0;
    server.use(
      catalog(true, true),
      http.get(`${P}/models/:name/load-config`, () =>
        HttpResponse.json({ name: 'gemma-test', quantization: '4bit', cpu: 8, memory_gb: 16, gpu_type: 'gpu-exclusive', gpu_count: 1,
          updated_by: 'system-setup', updated_at: '2026-10-12T16:14:00Z' })),
      http.put(`${P}/models/:name/load-config`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        sent.push(body);
        // 與 API 相同：多餘欄位回 422
        if (Object.keys(body).sort().join() !== CONFIG_FIELDS.join()) return HttpResponse.json({ detail: '多餘的欄位' }, { status: 422 });
        return HttpResponse.json(body);
      }),
      http.post(`${P}/models/:name/load`, () => { loads += 1; return HttpResponse.json({ loaded: true, trust_remote_code: false }); }),
      http.get(`${P}/models/:name/runtime`, () =>
        HttpResponse.json({ name: 'gemma-test', config: {}, runtime: { running: true, quantization_level: 'Q8_0', num_thread: 4, processor: 'gpu', vram_bytes: 0, runtime: 'ollama' } })),
    );
    const { user } = await renderApp('/llm/models', 'ca01');
    const form = await screen.findByRole('form', { name: 'gemma-test 載入設定' });
    await user.click(within(form).getByLabelText('8-bit'));
    await user.click(within(form).getByRole('button', { name: '套用並重新載入' }));
    expect(await within(form).findByText(/已依新設定重新載入/)).toBeInTheDocument();
    expect(sent).toEqual([{ quantization: '8bit', cpu: 8, memory_gb: 16, gpu_type: 'gpu-exclusive', gpu_count: 1 }]);
    expect(loads).toBe(1);
  });

  it('admin adds a model by Hugging Face name after inspecting it', async () => {
    const inspected: Record<string, unknown>[] = [];
    const added: Record<string, unknown>[] = [];
    server.use(
      catalog(false, false),
      http.post('*/api/admin/llm/whitelist/inspect', async ({ request }) => {
        inspected.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ source: 'huggingface.co', repo: 'ggml-org/new-GGUF', commit: 'c'.repeat(40), sha256: 'd'.repeat(64),
          has_remote_code: false, gated: true, files: ['new-Q4_K_M.gguf'], sizes: {}, total_bytes: 2 * 1024 * 1024 });
      }),
      http.post('*/api/admin/llm/whitelist', async ({ request }) => {
        added.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    const { user } = await renderApp('/llm/models', 'admin01');
    await user.click(await screen.findByRole('button', { name: '新增模型' }));
    await user.type(screen.getByLabelText('Hugging Face 模型名稱'), 'ggml-org/new-GGUF');
    await user.type(screen.getByLabelText('Token（選填）'), 'hf_x');
    await user.type(screen.getByLabelText('只下載這些檔案（選填）'), '*Q4_K_M.gguf');
    await user.click(screen.getByRole('button', { name: '檢查模型' }));
    await screen.findByRole('region', { name: '檢查結果' });
    expect(inspected).toEqual([{ repo: 'ggml-org/new-GGUF', token: 'hf_x', files: ['*Q4_K_M.gguf'] }]);
    await user.click(screen.getByRole('button', { name: '加入白名單' }));
    await screen.findByText(/已將 new-GGUF 加入白名單/);
    expect(added).toEqual([{ name: 'new-GGUF', source: 'huggingface.co', repo: 'ggml-org/new-GGUF', revision: 'c'.repeat(40),
      sha256: 'd'.repeat(64), requires_token: true, has_remote_code: false, files: ['*Q4_K_M.gguf'] }]);
  });

  it('editing the form after inspecting hides the old result', async () => {
    server.use(
      catalog(false, false),
      http.post('*/api/admin/llm/whitelist/inspect', () =>
        HttpResponse.json({ source: 'huggingface.co', repo: 'org/a', commit: 'c'.repeat(40), sha256: 'd'.repeat(64),
          has_remote_code: false, gated: false, files: ['config.json'], sizes: {}, total_bytes: 10 })),
    );
    const { user } = await renderApp('/llm/models', 'admin01');
    await user.click(await screen.findByRole('button', { name: '新增模型' }));
    await user.type(screen.getByLabelText('Hugging Face 模型名稱'), 'org/a');
    await user.click(screen.getByRole('button', { name: '檢查模型' }));
    await screen.findByText(/沒有 GGUF 檔案/);
    await user.type(screen.getByLabelText('Hugging Face 模型名稱'), 'b');
    expect(screen.queryByRole('button', { name: '加入白名單' })).not.toBeInTheDocument();
  });

  it('only admins see 新增模型', async () => {
    server.use(catalog(false, false));
    await renderApp('/llm/models', 'ca01');
    await screen.findByRole('rowheader', { name: 'gemma-test' });
    expect(screen.queryByRole('button', { name: '新增模型' })).not.toBeInTheDocument();
  });

  it('刪除模型 is a visible button on both the catalog and 載入設定 tabs', async () => {
    const deleted: string[] = [];
    server.use(
      catalog(true, false),
      http.get(`${P}/models/:name/load-config`, () =>
        HttpResponse.json({ name: 'gemma-test', quantization: '4bit', cpu: 8, memory_gb: 16, gpu_type: 'gpu-exclusive', gpu_count: 1 })),
      http.delete(`${P}/models/:name`, ({ params }) => {
        deleted.push(String(params.name));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = await renderApp('/llm/models', 'ca01');
    const row = (await screen.findByRole('rowheader', { name: 'gemma-test' })).closest('tr')!;
    expect(within(row).getByRole('button', { name: '刪除模型' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '載入設定' }));
    const loadRow = (await screen.findByRole('rowheader', { name: 'gemma-test' })).closest('tr')!;
    await user.click(within(loadRow).getByRole('button', { name: '刪除模型' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '刪除模型' }));
    await waitFor(() => expect(deleted).toEqual(['gemma-test']));
  });
});
