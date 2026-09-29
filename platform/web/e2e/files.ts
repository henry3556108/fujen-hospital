import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');

/** tests/fixtures 底下的檔案路徑（與單元測試共用同一份合成資料）。 */
export const fixture = (path: string) => join(FIXTURES, path);
