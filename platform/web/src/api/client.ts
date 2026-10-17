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
  time_slice_replicas: '時間片份數',
  job_timeout_minutes: '工作時限（分鐘）',
  duration_seconds: '執行秒數',
  memory_mb: '記憶體（MB）',
  gpu_count: 'GPU 數量',
  pool: 'GPU 池',
  mode: '模式',
  accession_numbers: 'Accession 清單',
  study_instance_uid: 'Study Instance UID',
};

function validationMessage(type: string | undefined, msg: string | undefined): string {
  if (type === 'string_too_short' || type === 'missing') return '不可空白';
  if (type === 'enum' || type === 'literal_error') return '值不在允許清單中';
  if (type === 'greater_than_equal' || type === 'less_than_equal') return '數值超出允許範圍';
  if (type === 'int_parsing' || type === 'int_type') return '必須是整數';
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
    const d = detail as { code?: string; permission?: string; message: string; errors?: unknown };
    // 一次列出全部錯誤的回應（例如流程程式碼不符合框架）：{"message", "errors": [str, ...]}
    const list = Array.isArray(d.errors) ? d.errors.map((m) => ({ field: '', message: String(m) })) : [];
    return new ApiError(status, d.message, list, d.code, d.permission);
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
  /** multipart/form-data 上傳（檔案）；Content-Type 由瀏覽器帶 boundary。 */
  postForm<T>(path: string, form: FormData): Promise<T>;
}

/** 組查詢字串：略過 undefined／null／空字串；陣列展開成重複參數。 */
export function withQuery(path: string, params: Record<string, string | number | string[] | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else q.append(k, String(v));
  }
  const text = q.toString();
  return text ? `${path}?${text}` : path;
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path, opts.base || window.location.origin);
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = await opts.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      });
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
    postForm: (p, f) => request('POST', p, f),
  };
}
