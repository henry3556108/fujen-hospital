import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeFile } from './upload-env';

const ROOT = resolve(__dirname, 'fixtures');

export function fixtureBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(ROOT, path)));
}

export function fixtureText(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

/** 測試夾具檔 → File；name 預設為路徑最後一段。 */
export function fixtureFile(path: string, name = path.split('/').pop()!): File {
  return makeFile(fixtureBytes(path), name);
}
