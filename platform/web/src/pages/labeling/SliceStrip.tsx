// 工作台左側的切片縮圖條（設計稿 A03）：每張影像一格，進畫面才載入縮圖，點一下換到那張。
import { useEffect, useRef, useState } from 'react';
import type { DicomwebClient, InstanceInfo, SeriesInfo } from './dicomweb';

type Status = 'idle' | 'loading' | 'ok' | 'error';

function SliceThumb({
  dicomweb,
  studyUid,
  instance,
  root,
}: {
  dicomweb: DicomwebClient;
  studyUid: string;
  instance: InstanceInfo;
  root: HTMLElement | null;
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
      { root, rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    // 環境沒有 object URL（例如單元測試）就只顯示佔位
    if (!visible || typeof URL.createObjectURL !== 'function') return;
    const ctrl = new AbortController();
    let made: string | null = null;
    let alive = true;
    setStatus('loading');
    dicomweb
      .thumbnail(studyUid, instance, ctrl.signal)
      .then((blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
        setStatus('ok');
      })
      .catch(() => alive && setStatus('error'));
    return () => {
      alive = false;
      ctrl.abort();
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [visible, dicomweb, studyUid, instance]);

  return (
    <span ref={box} className={`lb-slice__img lb-slice__img--${status}`} data-status={status} aria-hidden="true">
      {status === 'ok' && url ? <img src={url} alt="" /> : null}
    </span>
  );
}

export function SliceStrip({
  dicomweb,
  studyUid,
  instances,
  index,
  onPick,
  series,
  seriesUid,
  seriesLocked,
  onSeries,
}: {
  dicomweb: DicomwebClient;
  studyUid: string;
  instances: InstanceInfo[];
  index: number;
  onPick: (index: number) => void;
  series: SeriesInfo[];
  seriesUid: string | null;
  /** 有沒存的草稿時不能換序列 */
  seriesLocked: boolean;
  onSeries: (uid: string) => void;
}) {
  const [list, setList] = useState<HTMLOListElement | null>(null);

  // 目前這張捲到看得見的位置
  useEffect(() => {
    const el = list?.querySelector<HTMLElement>('[aria-current="true"]');
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [list, index]);

  return (
    <nav className="lb-strip" aria-label="影像序列">
      <div className="lb-strip__head">
        <span className="lb-strip__title">影像序列</span>
        <span className="lb-strip__count">
          {instances.length ? index + 1 : 0} / {instances.length}
        </span>
      </div>
      {series.length > 1 ? (
        <div className="field lb-strip__series">
          <label htmlFor="series">序列</label>
          <select id="series" className="select" value={seriesUid ?? ''} disabled={seriesLocked} onChange={(e) => onSeries(e.target.value)}>
            {series.map((s) => (
              <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>
                {s.modality} {s.description}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <ol className="lb-strip__list" ref={setList}>
        {instances.map((inst, i) => (
          <li key={inst.sopInstanceUid}>
            <button
              type="button"
              className="lb-slice"
              aria-label={`切換到第 ${i + 1} 張`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => onPick(i)}
            >
              <SliceThumb dicomweb={dicomweb} studyUid={studyUid} instance={inst} root={list} />
              <span className="lb-slice__no">{i + 1}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
