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
  it('a requested download shows 已申請，待核准 and no second 申請下載 button', async () => {
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
    expect(within(row).getByText('未下載')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: '申請下載' }));
    await waitFor(() => expect(within(row).getByText('已申請，待核准')).toBeInTheDocument());
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
    await user.selectOptions(within(form).getByLabelText('量化'), '8bit');
    await user.click(within(form).getByRole('button', { name: '套用並重新載入' }));
    expect(await within(form).findByText(/已依新設定重新載入/)).toBeInTheDocument();
    expect(sent).toEqual([{ quantization: '8bit', cpu: 8, memory_gb: 16, gpu_type: 'gpu-exclusive', gpu_count: 1 }]);
    expect(loads).toBe(1);
  });
});
