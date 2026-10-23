// 直接呼叫模擬 API（MSW 在測試中攔截 fetch），用 test 登入模式的 token。
export function mockFetch(method: string, path: string, username: string, body?: unknown) {
  return fetch(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer test-token:${username}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
