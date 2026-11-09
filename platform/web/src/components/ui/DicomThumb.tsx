import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../auth/SessionContext';
import { parseSeries } from '../../pages/labeling/dicomweb';
import { platformEnv } from '../../runtimeConfig';
import { Icon } from '../Icon';
import './ui.css';

const API_BASE: string = platformEnv().VITE_API_BASE ?? '';

type GetToken = () => Promise<string | null>;

// 同一個研究的第一個序列只查一次
const firstSeriesCache = new Map<string, Promise<string | null>>();

/** 測試用：清掉序列快取 */
export function clearDicomThumbCache() {
  firstSeriesCache.clear();
}

async function authHeaders(getToken: GetToken, accept: string): Promise<HeadersInit> {
  const token = await getToken();
  return { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function firstSeries(root: string, studyUid: string, getToken: GetToken): Promise<string | null> {
  const key = `${root}|${studyUid}`;
  let hit = firstSeriesCache.get(key);
  if (!hit) {
    hit = (async () => {
      const res = await fetch(`${root}/studies/${studyUid}/series`, { headers: await authHeaders(getToken, 'application/dicom+json') });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseSeries(await res.json())[0]?.seriesInstanceUid || null;
    })();
    hit.catch(() => firstSeriesCache.delete(key));
    firstSeriesCache.set(key, hit);
  }
  return hit;
}

/** 經 Gateway 的專案範圍 DICOMweb 取縮圖，回傳 object URL（呼叫端負責 revoke）。 */
export async function fetchThumbnail(opts: {
  base: string;
  projectId: number;
  studyUid: string;
  seriesUid?: string;
  getToken: GetToken;
  signal?: AbortSignal;
}): Promise<string> {
  const root = `${opts.base}/dicomweb/projects/${opts.projectId}`;
  const series = opts.seriesUid || (await firstSeries(root, opts.studyUid, opts.getToken));
  if (!series) throw new Error('研究沒有序列');
  const res = await fetch(`${root}/studies/${opts.studyUid}/series/${series}/thumbnail`, {
    // Orthanc 的 Accept 只能列一種格式，列多種會回 400
    headers: await authHeaders(opts.getToken, 'image/jpeg'),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

type Status = 'idle' | 'loading' | 'ok' | 'error';

/**
 * 影像縮圖（設計稿 A01 最近處理、A02 數據管理清單、A06 確認資料、A07 預測結果示例）。
 * 進入畫面才載入（IntersectionObserver），失敗顯示灰色佔位圖示；卸載時釋放 object URL。
 * 一般頁面用 DicomThumb（自動取目前登入的 token）；測試或特殊情況可用 DicomThumbView 自己給 getToken。
 */
export function DicomThumb(props: { projectId: number; studyUid: string; seriesUid?: string; alt?: string; size?: number }) {
  const { auth } = useSession();
  const getToken = useRef<GetToken>(async () => (await auth.getUser())?.accessToken ?? null);
  return <DicomThumbView {...props} base={API_BASE} getToken={getToken.current} />;
}

export function DicomThumbView({
  projectId,
  studyUid,
  seriesUid,
  alt = '影像縮圖',
  size = 56,
  base,
  getToken,
}: {
  projectId: number;
  studyUid: string;
  seriesUid?: string;
  alt?: string;
  /** 邊長 px，預設 56 */
  size?: number;
  base: string;
  getToken: GetToken;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !studyUid) return;
    const ctrl = new AbortController();
    let made: string | null = null;
    let alive = true;
    setStatus('loading');
    fetchThumbnail({ base, projectId, studyUid, seriesUid, getToken, signal: ctrl.signal })
      .then((u) => {
        made = u;
        if (!alive) {
          URL.revokeObjectURL(u);
          return;
        }
        setUrl(u);
        setStatus('ok');
      })
      .catch(() => {
        if (alive) setStatus('error');
      });
    return () => {
      alive = false;
      ctrl.abort();
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [visible, base, projectId, studyUid, seriesUid, getToken]);

  return (
    <span
      ref={box}
      className={`ui-thumb ui-thumb--${status}`}
      style={{ width: size, height: size }}
      data-testid="dicom-thumb"
      data-status={status}
    >
      {status === 'ok' && url ? (
        <img src={url} alt={alt} width={size} height={size} />
      ) : (
        <span role="img" aria-label={status === 'error' ? `${alt}（無法載入）` : `${alt}（載入中）`} className="ui-thumb__placeholder">
          <Icon name="image" />
        </span>
      )}
    </span>
  );
}
