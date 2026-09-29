import '../upload-env';
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../src/mocks/server';
import { createApiClient, withQuery } from '../../src/api/client';

const client = () => createApiClient({ base: 'http://localhost', getToken: async () => 'test-token:admin01', onUnauthorized: () => {} });

describe('api client: multipart and query', () => {
  it('postForm sends files as multipart with the bearer token', async () => {
    let seen: { names: string[]; sizes: number[]; schema: string | null; auth: string | null; type: string | null } | null = null;
    server.use(
      http.post('*/api/upload-probe', async ({ request }) => {
        const form = await request.formData();
        const files = form.getAll('files') as File[];
        seen = {
          names: files.map((f) => f.name),
          sizes: await Promise.all(files.map(async (f) => (await f.arrayBuffer()).byteLength)),
          schema: form.get('schema') as string | null,
          auth: request.headers.get('authorization'),
          type: request.headers.get('content-type'),
        };
        return HttpResponse.json({ ok: true }, { status: 201 });
      }),
    );
    const form = new FormData();
    form.append('files', new File([new Uint8Array([1, 2, 3])], 'a.dcm'), 'a.dcm');
    form.append('files', new File(['hello'], 'b.dcm'), 'dir/b.dcm');
    form.append('schema', '{"columns":[]}');
    const out = await client().postForm<{ ok: boolean }>('/api/upload-probe', form);
    expect(out.ok).toBe(true);
    expect(seen!.names).toEqual(['a.dcm', 'dir/b.dcm']);
    expect(seen!.sizes).toEqual([3, 5]);
    expect(seen!.schema).toBe('{"columns":[]}');
    expect(seen!.auth).toBe('Bearer test-token:admin01');
    expect(seen!.type).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('withQuery skips empty values and repeats array parameters', () => {
    expect(withQuery('/x', { a: 'CT', b: '', c: undefined, d: null })).toBe('/x?a=CT');
    expect(withQuery('/x', { columns: ['a b', 'c'], limit: 5 })).toBe('/x?columns=a+b&columns=c&limit=5');
    expect(withQuery('/x', {})).toBe('/x');
  });
});
