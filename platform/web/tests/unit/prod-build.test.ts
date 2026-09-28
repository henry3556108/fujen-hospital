// @vitest-environment node
// 正式版打包不可啟用測試登入模式，也不可帶入 API 模擬（TC-SS-04 精神：打包檔不含測試後門）。
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

const root = resolve(__dirname, '../..');
const outDir = join(root, 'node_modules/.cache/prod-build-check');

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? allFiles(join(dir, d.name)) : [join(dir, d.name)],
  );
}

describe('production build', () => {
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('cannot use test auth mode or the API mock even when VITE_AUTH_MODE=test', async () => {
    process.env.VITE_AUTH_MODE = 'test';
    process.env.VITE_API_MOCK = '1';
    try {
      await build({ root, mode: 'production', logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    } finally {
      delete process.env.VITE_AUTH_MODE;
      delete process.env.VITE_API_MOCK;
    }
    const files = allFiles(outDir);
    expect(files.some((f) => f.endsWith('.js'))).toBe(true);
    expect(files.some((f) => f.includes('mockServiceWorker'))).toBe(false);
    const bundle = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(bundle).not.toContain('__AI_PLATFORM_TEST_AUTH__');
    expect(bundle).not.toContain('test-token:');
    expect(bundle).toContain('ai-platform-web');
  }, 60_000);
});
