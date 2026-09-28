import { describe, expect, it } from 'vitest';
import { selectAuthMode } from '../../src/auth/adapter';
import { oidcSettings } from '../../src/auth/oidcAdapter';
import { TestAuthAdapter } from '../../src/auth/testAdapter';

describe('selectAuthMode', () => {
  it('uses test mode only on the dev server with VITE_AUTH_MODE=test', () => {
    expect(selectAuthMode({ testAuthAllowed: true, VITE_AUTH_MODE: 'test' })).toBe('test');
  });
  it('defaults to oidc', () => {
    expect(selectAuthMode({ testAuthAllowed: true })).toBe('oidc');
    expect(selectAuthMode({ testAuthAllowed: true, VITE_AUTH_MODE: 'oidc' })).toBe('oidc');
  });
  it('a build (vite build) ignores VITE_AUTH_MODE=test', () => {
    expect(selectAuthMode({ testAuthAllowed: false, VITE_AUTH_MODE: 'test' })).toBe('oidc');
  });
});

describe('oidcSettings', () => {
  it('uses Authorization Code + PKCE with the ai-platform-web public client', () => {
    const s = oidcSettings('http://localhost:5173', {});
    expect(s.authority).toBe('http://localhost:8080/realms/ai-platform');
    expect(s.client_id).toBe('ai-platform-web');
    expect(s.redirect_uri).toBe('http://localhost:5173/auth/callback');
    expect(s.post_logout_redirect_uri).toBe('http://localhost:5173/login');
    expect(s.response_type).toBe('code');
    expect(s.disablePKCE).not.toBe(true);
    expect('client_secret' in s).toBe(false);
  });
  it('can override issuer and client via env', () => {
    const s = oidcSettings('https://p.example', {
      VITE_OIDC_AUTHORITY: 'https://kc/realms/x',
      VITE_OIDC_CLIENT_ID: 'c',
    });
    expect(s.authority).toBe('https://kc/realms/x');
    expect(s.client_id).toBe('c');
  });
});

describe('TestAuthAdapter', () => {
  it('logs in as the chosen seed user and issues a test token', async () => {
    const a = new TestAuthAdapter();
    expect(await a.getUser()).toBeNull();
    await a.login({ username: 'md01' });
    expect(await a.getUser()).toEqual({ username: 'md01', accessToken: 'test-token:md01' });
    await a.logout();
    expect(await a.getUser()).toBeNull();
  });
});
