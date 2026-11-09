import { describe, expect, it } from 'vitest';
import { serviceCallExample, tokenSteps } from '../../src/components/apiToken';

describe('外部工具取得 Token 的說明', () => {
  it('uses the device-code client, because production turns off password grants', () => {
    const text = tokenSteps('https://sso.example/realms/ai-platform/');
    expect(text).toContain('https://sso.example/realms/ai-platform/protocol/openid-connect/auth/device');
    expect(text).toContain('client_id=ai-platform-importer');
    expect(text).toContain('urn:ietf:params:oauth:grant-type:device_code');
    expect(text).not.toMatch(/grant_type=password|client_secret/);
  });

  it('calls the published endpoint with the Bearer token', () => {
    const text = serviceCallExample('https://ai.example', '/api/llm-services/qa/invoke');
    expect(text).toContain('https://ai.example/api/llm-services/qa/invoke');
    expect(text).toContain('Authorization: Bearer $TOKEN');
  });
});
