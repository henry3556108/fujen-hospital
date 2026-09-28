import { existsSync } from 'node:fs';

const EDGE_PATHS: Record<string, string[]> = {
  darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge'],
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

export function edgeInstalled(): boolean {
  return (EDGE_PATHS[process.platform] ?? []).some((p) => existsSync(p));
}

export const EDGE_MISSING =
  '此機器未安裝 Microsoft Edge，略過 msedge 測試（TC-A02-08 的 Edge 部分需在已安裝 Edge 的機器上執行：npx playwright test --project=msedge）';
