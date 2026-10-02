import { describe, expect, it } from 'vitest';
import { platformEnv } from '../../src/runtimeConfig';

describe('執行期設定（/config.js）', () => {
  it('執行期的值蓋過打包期的值', () => {
    const env = platformEnv({ VITE_API_BASE: 'http://build', VITE_OHIF_BASE: 'http://ohif-build' },
                            { VITE_API_BASE: '' , VITE_OIDC_AUTHORITY: 'https://kc.example/realms/ai-platform' });
    expect(env.VITE_API_BASE).toBe('');
    expect(env.VITE_OHIF_BASE).toBe('http://ohif-build');
    expect(env.VITE_OIDC_AUTHORITY).toBe('https://kc.example/realms/ai-platform');
  });

  it('只接受 VITE_ 開頭的字串，不能改測試登入之類的其他設定', () => {
    const env = platformEnv({}, { VITE_AUTH_MODE: 'oidc', MODE: 'development', VITE_X: 1 as unknown as string });
    expect(env.MODE).toBeUndefined();
    expect(env.VITE_X).toBeUndefined();
  });

  it('沒有執行期設定時維持打包期的值', () => {
    expect(platformEnv({ VITE_API_BASE: 'http://b' }, undefined).VITE_API_BASE).toBe('http://b');
  });
});
