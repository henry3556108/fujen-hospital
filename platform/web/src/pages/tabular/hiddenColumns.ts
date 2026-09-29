// TC-B04-02 欄位顯示／隱藏：後端沒有保存這個狀態的 API（preview 只接受「目前可見欄位」），
// 所以存在瀏覽器的 localStorage，以帳號＋專案＋資料集為鍵。換瀏覽器或換電腦不會帶過去。
const key = (username: string, projectId: number, datasetId: number) =>
  `ai-platform.tabular.hidden.${username}.${projectId}.${datasetId}`;

export function loadHidden(username: string, projectId: number, datasetId: number): string[] {
  try {
    const raw = window.localStorage.getItem(key(username, projectId, datasetId));
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHidden(username: string, projectId: number, datasetId: number, hidden: string[]): void {
  try {
    if (hidden.length === 0) window.localStorage.removeItem(key(username, projectId, datasetId));
    else window.localStorage.setItem(key(username, projectId, datasetId), JSON.stringify(hidden));
  } catch {
    /* 儲存空間不可用時，狀態只維持到離開頁面 */
  }
}
