// 單一影像視窗：把原始像素套上窗位、旋轉後畫到 canvas，再疊上標註。
// 滑鼠在畫布上的位置會換算回影像座標，交給上層處理（畫框、塗遮罩）。
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ANNOTATION_COLOR_COUNT, annotationRgb, css, readToken } from './colors';
import type { DicomwebClient, InstanceInfo } from './dicomweb';
import {
  boxFromPoints,
  canvasToImage,
  defaultWindow,
  fitTransform,
  imageToCanvas,
  renderGray,
  type Rotation,
  type WindowSetting,
} from './imaging';
import type { DetectionBox } from './types';

/** none＝不動作；pan／zoom／window＝拖曳移動、縮放、調窗位；box／brush／erase＝標註 */
export type Tool = 'none' | 'pan' | 'zoom' | 'window' | 'box' | 'brush' | 'erase';

const NAV_TOOLS: readonly Tool[] = ['pan', 'zoom', 'window'];
export const MAX_ZOOM = 8;

export interface Overlay {
  id: string;
  /** 標註自己的像素格 [高, 寬]；與影像大小不同時會等比縮放到影像上 */
  shape: [number, number];
  mask?: Uint8Array;
  labelNames?: Record<string, number>;
  boxes?: DetectionBox[];
  /** 編輯中的草稿：框線畫虛線 */
  draft?: boolean;
  /** 遮罩內容變動時遞增，觸發重畫 */
  revision?: number;
}

/** 沒有形狀的標註（分類）在影像左上角顯示的文字 */
export interface Badge {
  id: number;
  text: string;
  /** 顏色序號，與圖例相同 */
  color: number;
}

export interface ViewportProps {
  dicomweb: DicomwebClient;
  studyUid: string;
  instance: InstanceInfo;
  position: string;
  window: WindowSetting | null;
  rotation: Rotation;
  invert: boolean;
  overlays: Overlay[];
  badges?: Badge[];
  colorOf: Record<string, number>;
  active: boolean;
  tool: Tool;
  /** 草稿的像素格；畫框與塗抹的座標以它為準 */
  draftShape?: [number, number];
  onBox?: (box: [number, number, number, number]) => void;
  onPaint?: (x: number, y: number) => void;
  /** 筆刷按下、開始新的一筆之前（給「復原」記下目前草稿） */
  onStrokeStart?: () => void;
  onWindow?: (w: WindowSetting) => void;
  /** 縮放倍率（1＝剛好放進視窗）與位移（視窗寬高的百分比），所有視窗共用 */
  zoom?: number;
  pan?: [number, number];
  onZoom?: (zoom: number) => void;
  onPan?: (pan: [number, number]) => void;
  /** 用「窗位」工具拖曳時的新窗位 */
  onWindowDrag?: (w: WindowSetting) => void;
}

interface Gesture {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
  pan: [number, number];
  window: WindowSetting | null;
  moved: boolean;
}

const SIZE = 512;

type Pixels = Int16Array | Uint16Array | Uint8Array;

export function Viewport(props: ViewportProps) {
  const { dicomweb, studyUid, instance, window: windowSetting, rotation, invert, overlays, colorOf, active, tool } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pixels, setPixels] = useState<Pixels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const drag = useRef<[number, number] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPixels(null);
    setError(null);
    dicomweb
      .pixels(studyUid, instance)
      .then((p) => !cancelled && setPixels(p))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : '影像載入失敗'));
    return () => {
      cancelled = true;
    };
  }, [dicomweb, studyUid, instance]);

  const module = useMemo(
    () => ({ rows: instance.rows, columns: instance.columns, slope: instance.slope, intercept: instance.intercept }),
    [instance],
  );

  const effective: WindowSetting | null = useMemo(() => {
    if (windowSetting) return windowSetting;
    if (instance.windowCenter !== null && instance.windowWidth !== null) {
      return { center: instance.windowCenter, width: instance.windowWidth };
    }
    return pixels ? defaultWindow(instance.modality, pixels, module) : null;
  }, [windowSetting, instance, pixels, module]);

  // 讓上層知道目前實際使用的窗位（沒指定時是預設值），工具列才顯示得出數字
  const { onWindow } = props;
  useEffect(() => {
    if (active && !windowSetting && effective) onWindow?.(effective);
  }, [active, windowSetting, effective, onWindow]);

  const transform = useMemo(
    () => fitTransform(SIZE, SIZE, instance.columns, instance.rows, rotation),
    [instance, rotation],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.('2d');
    if (!canvas || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = readToken('--viewer-bg') || 'currentColor';
    ctx.fillRect(0, 0, SIZE, SIZE);
    if (!pixels || !effective) return;

    const image = document.createElement('canvas');
    image.width = instance.columns;
    image.height = instance.rows;
    const rgba = renderGray(pixels, module, effective, invert);
    image.getContext('2d')!.putImageData(new ImageData(rgba, instance.columns, instance.rows), 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.translate(SIZE / 2, SIZE / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(transform.scale, transform.scale);
    ctx.translate(-instance.columns / 2, -instance.rows / 2);
    ctx.drawImage(image, 0, 0);

    for (const overlay of overlays) {
      const [h, w] = overlay.shape;
      ctx.save();
      ctx.scale(instance.columns / w, instance.rows / h);
      if (overlay.mask && overlay.labelNames) {
        const nameOf = new Map(Object.entries(overlay.labelNames).map(([name, value]) => [value, name]));
        const layer = document.createElement('canvas');
        layer.width = w;
        layer.height = h;
        const data = new ImageData(w, h);
        for (let i = 0; i < w * h; i++) {
          const v = overlay.mask[i];
          if (!v) continue;
          const rgb = annotationRgb(colorOf[nameOf.get(v) ?? ''] ?? v);
          data.data.set(rgb ? [rgb[0], rgb[1], rgb[2], 120] : [255, 255, 255, 120], i * 4);
        }
        layer.getContext('2d')!.putImageData(data, 0, 0);
        ctx.drawImage(layer, 0, 0);
      }
      for (const b of overlay.boxes ?? []) {
        const [x1, y1, x2, y2] = b.box;
        ctx.strokeStyle = css(annotationRgb(colorOf[b.label] ?? 1));
        ctx.lineWidth = Math.max(0.5, 2 / transform.scale);
        ctx.setLineDash(overlay.draft ? [4 / transform.scale, 3 / transform.scale] : []);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      }
      ctx.restore();
    }

    // 文字不跟著影像旋轉：回到畫布座標再寫
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = '14px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (const overlay of overlays) {
      const [h, w] = overlay.shape;
      for (const b of overlay.boxes ?? []) {
        const corners = [
          imageToCanvas(transform, (b.box[0] * instance.columns) / w, (b.box[1] * instance.rows) / h),
          imageToCanvas(transform, (b.box[2] * instance.columns) / w, (b.box[3] * instance.rows) / h),
        ];
        const x = Math.min(corners[0][0], corners[1][0]);
        const y = Math.min(corners[0][1], corners[1][1]);
        const text = b.score === undefined ? b.label : `${b.label} ${Math.round(b.score * 100)}%`;
        ctx.fillStyle = readToken('--viewer-bg') || 'currentColor';
        ctx.fillRect(x, Math.max(0, y - 18), ctx.measureText(text).width + 8, 18);
        ctx.fillStyle = css(annotationRgb(colorOf[b.label] ?? 1));
        ctx.fillText(text, x + 4, Math.max(0, y - 18) + 2);
      }
    }
    if (preview) {
      const [ax, ay] = imageToCanvas(transform, preview.a[0], preview.a[1]);
      const [bx, by] = imageToCanvas(transform, preview.b[0], preview.b[1]);
      ctx.strokeStyle = readToken('--viewer-text') || 'currentColor';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.setLineDash([]);
    }
  }, [pixels, effective, invert, rotation, transform, overlays, colorOf, preview, instance, module]);

  function toImage(e: ReactPointerEvent<HTMLCanvasElement>): [number, number] {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = ((e.clientX - rect.left) * SIZE) / rect.width;
    const cy = ((e.clientY - rect.top) * SIZE) / rect.height;
    return canvasToImage(transform, cx, cy);
  }

  function toDraft([x, y]: [number, number]): [number, number] {
    const [h, w] = props.draftShape ?? [instance.rows, instance.columns];
    return [(x * w) / instance.columns, (y * h) / instance.rows];
  }

  const zoom = props.zoom ?? 1;
  const pan = props.pan ?? [0, 0];
  const navigating = NAV_TOOLS.includes(tool) && pixels !== null;
  const drawing = active && !navigating && tool !== 'none' && pixels !== null;
  const gesture = useRef<Gesture | null>(null);

  function startGesture(e: ReactPointerEvent<HTMLCanvasElement>) {
    const stage = e.currentTarget.parentElement?.getBoundingClientRect();
    gesture.current = {
      x: e.clientX,
      y: e.clientY,
      width: stage?.width || SIZE,
      height: stage?.height || SIZE,
      zoom,
      pan: [pan[0], pan[1]],
      window: effective,
      moved: false,
    };
  }

  function moveGesture(e: ReactPointerEvent<HTMLCanvasElement>) {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
    if (tool === 'pan') props.onPan?.([g.pan[0] + (dx / g.width) * 100, g.pan[1] + (dy / g.height) * 100]);
    else if (tool === 'zoom') props.onZoom?.(Math.min(MAX_ZOOM, Math.max(1, g.zoom * Math.exp(-dy / 150))));
    else if (tool === 'window' && g.window) {
      // 左右拖曳改窗寬、上下拖曳改窗位，幅度依目前窗寬
      props.onWindowDrag?.({
        center: g.window.center + (dy / g.height) * g.window.width,
        width: Math.max(1, g.window.width + (dx / g.width) * g.window.width * 2),
      });
    }
  }

  function down(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return;
    if (navigating) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      startGesture(e);
      return;
    }
    if (!drawing) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = toImage(e);
    drag.current = p;
    if (tool === 'box') setPreview({ a: p, b: p });
    else {
      props.onStrokeStart?.();
      props.onPaint?.(...toDraft(p));
    }
  }
  function move(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (gesture.current) {
      moveGesture(e);
      return;
    }
    if (!drawing || !drag.current) return;
    const p = toImage(e);
    if (tool === 'box') setPreview({ a: drag.current, b: p });
    else props.onPaint?.(...toDraft(p));
  }
  function up(e: ReactPointerEvent<HTMLCanvasElement>) {
    const g = gesture.current;
    if (g) {
      gesture.current = null;
      // 放大工具只點一下（沒拖曳）＝放大一級
      if (tool === 'zoom' && !g.moved) props.onZoom?.(Math.min(MAX_ZOOM, g.zoom * 1.5));
      return;
    }
    if (!drag.current) return;
    const start = drag.current;
    drag.current = null;
    setPreview(null);
    if (!drawing || tool !== 'box') return;
    const [h, w] = props.draftShape ?? [instance.rows, instance.columns];
    const box = boxFromPoints(toDraft(start), toDraft(toImage(e)), w, h);
    if (box) props.onBox?.(box);
  }

  const description = effective
    ? `第 ${props.position} 張，窗寬 ${Math.round(effective.width)}、窗位 ${Math.round(effective.center)}，旋轉 ${rotation} 度${invert ? '，反相' : ''}${zoom > 1.001 ? `，放大 ${zoom.toFixed(1)} 倍` : ''}`
    : `第 ${props.position} 張`;

  return (
    <figure
      className={`viewport${active ? ' viewport--active' : ''}`}
      data-testid="viewport"
      data-sop={instance.sopInstanceUid}
      data-rotation={rotation}
      data-window-center={effective ? Math.round(effective.center) : ''}
      data-window-width={effective ? Math.round(effective.width) : ''}
      data-invert={invert ? '1' : '0'}
      data-ready={pixels ? '1' : '0'}
      data-zoom={zoom.toFixed(2)}
    >
      <div className="viewport__stage">
        <canvas
          ref={canvasRef}
          width={SIZE}
          height={SIZE}
          className={`viewport__canvas${drawing ? ' viewport__canvas--drawing' : ''}${navigating ? ` viewport__canvas--${tool}` : ''}`}
          style={zoom !== 1 || pan[0] || pan[1] ? { transform: `translate(${pan[0]}%, ${pan[1]}%) scale(${zoom})` } : undefined}
          role="img"
          aria-label={`影像 ${description}`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => {
            drag.current = null;
            gesture.current = null;
            setPreview(null);
          }}
        />
      </div>
      {props.badges?.length ? (
        <ul className="viewport__badges" aria-label="這張影像的分類標註">
          {props.badges.map((b) => (
            <li key={b.id} className={`viewport__badge viewport__badge--${((b.color - 1) % ANNOTATION_COLOR_COUNT) + 1}`}>
              {b.text}
            </li>
          ))}
        </ul>
      ) : null}
      <figcaption className="viewport__caption">
        {error ? <span role="alert">無法顯示影像：{error}</span> : pixels ? description : '影像載入中…'}
      </figcaption>
    </figure>
  );
}
