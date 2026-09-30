// TC-B04-02 欄位顯示／隱藏：設定存在伺服器（GET／PUT .../datasets/{id}/column-view，每位使用者、每個資料集一份）。
// 舊版把設定存在瀏覽器 localStorage（鍵：帳號＋專案＋資料集）；第一次開啟時若伺服器還沒有設定，搬到伺服器後清掉本機值。
const legacyKey = (username: string, projectId: number, datasetId: number) =>
  `ai-platform.tabular.hidden.${username}.${projectId}.${datasetId}`;

export interface ColumnView {
  hidden: string[];
  saved: boolean;
}

export function loadLegacyHidden(username: string, projectId: number, datasetId: number): string[] {
  try {
    const raw = window.localStorage.getItem(legacyKey(username, projectId, datasetId));
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function clearLegacyHidden(username: string, projectId: number, datasetId: number): void {
  try {
    window.localStorage.removeItem(legacyKey(username, projectId, datasetId));
  } catch {
    /* 儲存空間不可用：沒有舊值可清 */
  }
}
