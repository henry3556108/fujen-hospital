import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApiClient, type ApiClient } from '../api/client';
import type { Me, MeProject } from '../api/types';
import type { AuthAdapter } from './adapter';

type Status = 'loading' | 'anonymous' | 'ready' | 'error';

interface SessionValue {
  auth: AuthAdapter;
  api: ApiClient;
  status: Status;
  me: Me | null;
  loadError: unknown;
  /** API 回 401 後為 true，登入頁據此顯示「登入已失效」 */
  expired: boolean;
  project: MeProject | null;
  /** 專案是使用者選的（或上次選過、記在瀏覽器）；false 代表系統自動帶第一個專案。Admin 未選專案時首頁轉到管理區。 */
  projectChosen: boolean;
  /** 最近使用的專案 id（新到舊） */
  recentProjectIds: number[];
  selectProject: (id: number) => void;
  login: (options?: { username?: string; returnTo?: string }) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => void;
  /** 不顯示載入中、重新讀取 /api/me（專案清單）；內容沒變就不更新 */
  refreshMe: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

const projectKey = (username: string) => `ai-platform.project.${username}`;
const recentKey = (username: string) => `ai-platform.recent-projects.${username}`;

function readRecent(username: string): number[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(recentKey(username)) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

export function SessionProvider({ auth, apiBase, children }: { auth: AuthAdapter; apiBase: string; children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [expired, setExpired] = useState(false);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [projectChosen, setProjectChosen] = useState(false);
  const [recentProjectIds, setRecentProjectIds] = useState<number[]>([]);
  const [nonce, setNonce] = useState(0);
  const authRef = useRef(auth);
  authRef.current = auth;

  const onUnauthorized = useCallback(() => {
    void authRef.current.clearSession();
    setMe(null);
    setExpired(true);
    setStatus('anonymous');
  }, []);

  const api = useMemo(
    () =>
      createApiClient({
        base: apiBase,
        getToken: async () => (await authRef.current.getUser())?.accessToken ?? null,
        onUnauthorized,
      }),
    [apiBase, onUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus('loading');
      const user = await auth.getUser();
      if (!user) {
        if (!cancelled) setStatus('anonymous');
        return;
      }
      try {
        const data = await api.get<Me>('/api/me');
        if (cancelled) return;
        setMe(data);
        setExpired(false);
        let stored: number | null = null;
        try {
          stored = Number(window.localStorage.getItem(projectKey(data.username))) || null;
        } catch {
          stored = null;
        }
        const valid = data.projects.some((p) => p.id === stored);
        setProjectId(valid ? stored : (data.projects[0]?.id ?? null));
        setProjectChosen(valid);
        setRecentProjectIds(readRecent(data.username));
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        if ((e as { status?: number }).status === 401) return; // onUnauthorized 已處理
        setLoadError(e);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, api, nonce]);

  // 另一個視窗新增的專案：視窗取得焦點或打開專案下拉時重新讀取，不必按 F5（B-01 已知問題 5）。
  // 背景讀取：失敗就略過（401 仍由 onUnauthorized 處理）；內容相同不更新，頁面狀態不受影響。
  const meRef = useRef(me);
  meRef.current = me;
  const refreshing = useRef(false);
  const refreshMe = useCallback(() => {
    if (!meRef.current || refreshing.current) return;
    refreshing.current = true;
    void (async () => {
      try {
        const data = await api.get<Me>('/api/me');
        if (!meRef.current || JSON.stringify(data) === JSON.stringify(meRef.current)) return;
        setMe(data);
        setProjectId((current) =>
          data.projects.some((p) => p.id === current) ? current : (data.projects[0]?.id ?? null),
        );
      } catch {
        /* 背景更新失敗不影響目前畫面 */
      } finally {
        refreshing.current = false;
      }
    })();
  }, [api]);

  useEffect(() => {
    if (status !== 'ready') return;
    const onFocus = () => refreshMe();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [status, refreshMe]);

  const selectProject = useCallback(
    (id: number) => {
      setProjectId(id);
      setProjectChosen(true);
      if (me) {
        const recent = [id, ...readRecent(me.username).filter((x) => x !== id)].slice(0, 5);
        setRecentProjectIds(recent);
        try {
          window.localStorage.setItem(projectKey(me.username), String(id));
          window.localStorage.setItem(recentKey(me.username), JSON.stringify(recent));
        } catch {
          /* 忽略 */
        }
      }
    },
    [me],
  );

  const login = useCallback(
    async (options?: { username?: string; returnTo?: string }) => {
      await auth.login(options);
      setNonce((n) => n + 1); // test 模式立即生效；OIDC 模式已導向 Keycloak
    },
    [auth],
  );

  const logout = useCallback(async () => {
    await auth.logout();
    setMe(null);
    setExpired(false);
    setStatus('anonymous');
  }, [auth]);

  const project = me?.projects.find((p) => p.id === projectId) ?? null;

  const value: SessionValue = {
    auth,
    api,
    status,
    me,
    loadError,
    expired,
    project,
    projectChosen,
    recentProjectIds,
    selectProject,
    login,
    logout,
    reload: () => setNonce((n) => n + 1),
    refreshMe,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}

/** 已登入且 /api/me 載入完成時使用 */
export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error('useMe called before session is ready');
  return me;
}
