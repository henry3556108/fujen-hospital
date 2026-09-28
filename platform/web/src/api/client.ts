// 呼叫 Gateway /api/* 的 fetch 包裝。錯誤形狀依 platform/api：
//   401 {"detail": str}；403 {"detail": str} 或 {"detail": {"code","permission","message"}}；
//   404/409 {"detail": str}；422 FastAPI 驗證 {"detail": [{loc, msg, type}, ...]}。

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fieldErrors: FieldError[] = [],
    readonly code?: string,
    readonly permission?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const FIELD_LABELS: Record<string, string> = {
  name: '專案名稱',
  description: '說明',
  gpu_group: 'GPU 群組',
  username: '帳號',
  password: '密碼',
  new_password: '新密碼',
  account_type: '帳號類型',
  role: '角色',
  permissions: '權限',
};

function validationMessage(type: string | undefined, msg: string | undefined): string {
  if (type === 'string_too_short' || type === 'missing') return '不可空白';
  if (type === 'enum' || type === 'literal_error') return '值不在允許清單中';
  return msg ?? '格式不正確';
}

interface ValidationItem {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
}

function toApiError(status: number, body: unknown): ApiError {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (status === 422 && Array.isArray(detail)) {
    const fieldErrors = (detail as ValidationItem[]).map((d) => {
      const loc = (d.loc ?? []).filter((x) => x !== 'body');
      const field = String(loc[0] ?? '');
      const label = FIELD_LABELS[field] ?? field;
      return { field, message: `${label}：${validationMessage(d.type, d.msg)}` };
    });
    return new ApiError(status, `資料驗證失敗：${fieldErrors.map((f) => f.message).join('；')}`, fieldErrors);
  }
  if (detail && typeof detail === 'object' && 'message' in detail) {
    const d = detail as { code?: string; permission?: string; message: string };
    return new ApiError(status, d.message, [], d.code, d.permission);
  }
  if (typeof detail === 'string') return new ApiError(status, detail);
  const fallback: Record<number, string> = {
    401: '登入已失效，請重新登入',
    403: '你沒有執行此操作的權限',
    404: '找不到資料',
    409: '資料衝突',
  };
  return new ApiError(status, fallback[status] ?? `伺服器錯誤（HTTP ${status}）`);
}

export interface ApiClientOptions {
  /** Gateway 位址，例如 http://localhost:9080；空字串表示同源 */
  base: string;
  getToken: () => Promise<string | null>;
  /** 收到 401 時呼叫（清除登入狀態並回登入頁） */
  onUnauthorized: () => void;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  delete<T = void>(path: string): Promise<T>;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, opts.base || window.location.origin);
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = await opts.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, '無法連線到伺服器，請確認網路或稍後再試');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = toApiError(res.status, data);
      if (res.status === 401) opts.onUnauthorized();
      throw err;
    }
    return data as T;
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
    put: (p, b) => request('PUT', p, b),
    delete: (p) => request('DELETE', p),
  };
}
