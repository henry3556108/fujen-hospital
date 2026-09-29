import { ApiError } from './client';

/** 422 的欄位名稱在不同表單有不同稱呼（例如 name 在 GPU 群組表單是「群組名稱」）：依表單改寫訊息。 */
export function relabel(error: unknown, labels: Record<string, string>): unknown {
  if (!(error instanceof ApiError) || error.fieldErrors.length === 0) return error;
  const fieldErrors = error.fieldErrors.map((f) => {
    const label = labels[f.field];
    if (!label) return f;
    const i = f.message.indexOf('：');
    return { field: f.field, message: `${label}：${i >= 0 ? f.message.slice(i + 1) : f.message}` };
  });
  return new ApiError(
    error.status,
    `資料驗證失敗：${fieldErrors.map((f) => f.message).join('；')}`,
    fieldErrors,
    error.code,
    error.permission,
  );
}
