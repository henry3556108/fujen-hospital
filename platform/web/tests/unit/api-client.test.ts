import { describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ApiError, createApiClient } from '../../src/api/client';
import { server } from '../../src/mocks/server';

const BASE = 'http://api.test';

function client(token: string | null = 'test-token:admin01', onUnauthorized = vi.fn()) {
  return { api: createApiClient({ base: BASE, getToken: async () => token, onUnauthorized }), onUnauthorized };
}

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected ApiError');
}

describe('api client', () => {
  it('sends the bearer token and parses JSON', async () => {
    const { api } = client('test-token:vw01');
    const me = await api.get<{ username: string }>('/api/me');
    expect(me.username).toBe('vw01');
  });

  it('401 calls onUnauthorized (return to login) and throws', async () => {
    const { api, onUnauthorized } = client(null);
    const err = await caught(api.get('/api/me'));
    expect(err.status).toBe(401);
    expect(err.message).toBe('未登入');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('403 with a string detail', async () => {
    const { api } = client('test-token:vw01');
    const err = await caught(api.get('/api/admin/users'));
    expect(err.status).toBe(403);
    expect(err.message).toBe('需要 Admin 權限');
  });

  it('403 with a structured detail {code, permission, message}', async () => {
    server.use(
      http.get(`${BASE}/api/x`, () =>
        HttpResponse.json(
          { detail: { code: 'permission_denied', permission: 'training', message: '你沒有 training 權限' } },
          { status: 403 },
        ),
      ),
    );
    const { api } = client();
    const err = await caught(api.get('/api/x'));
    expect(err.message).toBe('你沒有 training 權限');
    expect(err.code).toBe('permission_denied');
    expect(err.permission).toBe('training');
  });

  it('409 keeps the server message', async () => {
    const { api } = client();
    const err = await caught(api.post('/api/admin/projects', { name: 'P1-lung-ct' }));
    expect(err.status).toBe(409);
    expect(err.message).toBe('專案名稱「P1-lung-ct」已存在');
  });

  it('422 turns FastAPI validation details into zh-TW field messages', async () => {
    const { api } = client();
    const err = await caught(api.post('/api/admin/projects', { name: '' }));
    expect(err.status).toBe(422);
    expect(err.fieldErrors).toEqual([{ field: 'name', message: '專案名稱：不可空白' }]);
    expect(err.message).toBe('資料驗證失敗：專案名稱：不可空白');
  });

  it('204 resolves to undefined', async () => {
    const { api } = client();
    await expect(api.delete('/api/admin/projects/3')).resolves.toBeUndefined();
  });

  it('network failure becomes a readable error', async () => {
    server.use(http.get(`${BASE}/api/down`, () => HttpResponse.error()));
    const { api } = client();
    const err = await caught(api.get('/api/down'));
    expect(err.status).toBe(0);
    expect(err.message).toContain('無法連線');
  });
});
