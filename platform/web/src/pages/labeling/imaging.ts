// 影像運算（純函式，不碰 DOM）：窗位、器官窗、旋轉與座標轉換、RLE。

export interface WindowSetting {
  center: number;
  width: number;
}

export interface WindowPreset extends WindowSetting {
  key: string;
  label: string;
  /** 對應的數字快捷鍵 */
  hotkey: string;
}

/** 預設器官窗（CT，單位 HU）。驗收要求不少於 3 組。 */
export const WINDOW_PRESETS: readonly WindowPreset[] = [
  { key: 'soft-tissue', label: '軟組織窗', hotkey: '1', center: 40, width: 400 },
  { key: 'lung', label: '肺窗', hotkey: '2', center: -600, width: 1500 },
  { key: 'bone', label: '骨窗', hotkey: '3', center: 400, width: 1800 },
  { key: 'brain', label: '腦窗', hotkey: '4', center: 40, width: 80 },
  { key: 'abdomen', label: '腹部窗', hotkey: '5', center: 50, width: 350 },
];

export type Rotation = 0 | 90 | 180 | 270;

export function rotate(current: Rotation, direction: 'cw' | 'ccw'): Rotation {
  return ((current + (direction === 'cw' ? 90 : 270)) % 360) as Rotation;
}

export const LAYOUTS = ['1x1', '1x2', '2x2'] as const;
export type Layout = (typeof LAYOUTS)[number];
export const LAYOUT_LABELS: Record<Layout, string> = { '1x1': '1×1', '1x2': '1×2', '2x2': '2×2' };

export function layoutCells(layout: Layout): number {
  return layout === '1x1' ? 1 : layout === '1x2' ? 2 : 4;
}

export function nextLayout(layout: Layout): Layout {
  return LAYOUTS[(LAYOUTS.indexOf(layout) + 1) % LAYOUTS.length];
}

export interface PixelModule {
  rows: number;
  columns: number;
  slope: number;
  intercept: number;
}

/** DICOM PS3.3 C.11.2.1.2 線性窗位：回傳 0–255 的灰階。 */
export function windowedGray(value: number, w: WindowSetting): number {
  const width = Math.max(1, w.width);
  const low = w.center - 0.5 - (width - 1) / 2;
  const high = w.center - 0.5 + (width - 1) / 2;
  if (value <= low) return 0;
  if (value > high) return 255;
  return Math.round(((value - (w.center - 0.5)) / (width - 1) + 0.5) * 255);
}

/** 原始像素 → RGBA（套用 Rescale、窗位、反相）。 */
export function renderGray(
  pixels: ArrayLike<number>,
  module: PixelModule,
  w: WindowSetting,
  invert = false,
): Uint8ClampedArray<ArrayBuffer> {
  const n = module.rows * module.columns;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const g = windowedGray((pixels[i] ?? 0) * module.slope + module.intercept, w);
    const v = invert ? 255 - g : g;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** 中繼資料沒有窗位時的預設值：CT 用軟組織窗，其餘取像素值的最小到最大。 */
export function defaultWindow(modality: string, pixels: ArrayLike<number>, module: PixelModule): WindowSetting {
  if (modality === 'CT') return { center: 40, width: 400 };
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < module.rows * module.columns; i++) {
    const v = (pixels[i] ?? 0) * module.slope + module.intercept;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || max <= min) return { center: 128, width: 256 };
  return { center: Math.round((min + max) / 2), width: Math.max(1, Math.round(max - min)) };
}

// ---------- 座標轉換 ----------

export interface ViewTransform {
  scale: number;
  rotation: Rotation;
  canvasWidth: number;
  canvasHeight: number;
  columns: number;
  rows: number;
}

/** 影像等比縮放到畫布內；旋轉 90／270 度時長寬對調。 */
export function fitTransform(
  canvasWidth: number,
  canvasHeight: number,
  columns: number,
  rows: number,
  rotation: Rotation,
): ViewTransform {
  const swapped = rotation === 90 || rotation === 270;
  const w = swapped ? rows : columns;
  const h = swapped ? columns : rows;
  return { scale: Math.min(canvasWidth / w, canvasHeight / h), rotation, canvasWidth, canvasHeight, columns, rows };
}

const COS: Record<Rotation, number> = { 0: 1, 90: 0, 180: -1, 270: 0 };
const SIN: Record<Rotation, number> = { 0: 0, 90: 1, 180: 0, 270: -1 };

/** 影像座標（像素格，左上為原點）→ 畫布座標。 */
export function imageToCanvas(t: ViewTransform, x: number, y: number): [number, number] {
  const dx = (x - t.columns / 2) * t.scale;
  const dy = (y - t.rows / 2) * t.scale;
  return [
    t.canvasWidth / 2 + dx * COS[t.rotation] - dy * SIN[t.rotation],
    t.canvasHeight / 2 + dx * SIN[t.rotation] + dy * COS[t.rotation],
  ];
}

/** 畫布座標 → 影像座標（未裁切，可能落在影像外）。 */
export function canvasToImage(t: ViewTransform, cx: number, cy: number): [number, number] {
  const dx = cx - t.canvasWidth / 2;
  const dy = cy - t.canvasHeight / 2;
  return [
    (dx * COS[t.rotation] + dy * SIN[t.rotation]) / t.scale + t.columns / 2,
    (-dx * SIN[t.rotation] + dy * COS[t.rotation]) / t.scale + t.rows / 2,
  ];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 兩個影像座標點 → 合法的 xyxy 整數框；太小（寬或高為 0）回 null。 */
export function boxFromPoints(
  a: [number, number],
  b: [number, number],
  columns: number,
  rows: number,
): [number, number, number, number] | null {
  const x1 = clamp(Math.floor(Math.min(a[0], b[0])), 0, columns);
  const y1 = clamp(Math.floor(Math.min(a[1], b[1])), 0, rows);
  const x2 = clamp(Math.ceil(Math.max(a[0], b[0])), 0, columns);
  const y2 = clamp(Math.ceil(Math.max(a[1], b[1])), 0, rows);
  if (x2 <= x1 || y2 <= y1) return null;
  return [x1, y1, x2, y2];
}

// ---------- 遮罩 ----------

export function rleEncode(mask: ArrayLike<number>): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i];
    const last = out[out.length - 1];
    if (last && last[0] === v) last[1] += 1;
    else out.push([v, 1]);
  }
  return out;
}

export function rleDecode(rle: readonly (readonly [number, number])[], size: number): Uint8Array {
  const mask = new Uint8Array(size);
  let at = 0;
  for (const [value, run] of rle) {
    mask.fill(value, at, Math.min(size, at + run));
    at += run;
  }
  return mask;
}

/** 以圓形筆刷在遮罩上塗一筆；回傳有沒有改到任何像素。 */
export function paintDisc(
  mask: Uint8Array,
  columns: number,
  rows: number,
  cx: number,
  cy: number,
  radius: number,
  value: number,
): boolean {
  let changed = false;
  const r = Math.max(0.5, radius);
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(rows - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(columns - 1, Math.ceil(cx + r)); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r && mask[y * columns + x] !== value) {
        mask[y * columns + x] = value;
        changed = true;
      }
    }
  }
  return changed;
}

/** 標籤名稱 → 標籤值；新標籤取目前最大值加 1。 */
export function labelValue(names: Record<string, number>, label: string): [Record<string, number>, number] {
  if (label in names) return [names, names[label]];
  const next = Math.max(0, ...Object.values(names)) + 1;
  return [{ ...names, [label]: next }, next];
}

/** 遮罩中實際出現的標籤（不含 background）。 */
export function usedLabels(mask: ArrayLike<number>, names: Record<string, number>): string[] {
  const seen = new Set<number>();
  for (let i = 0; i < mask.length; i++) seen.add(mask[i]);
  return Object.entries(names)
    .filter(([, v]) => v !== 0 && seen.has(v))
    .map(([k]) => k)
    .sort();
}
