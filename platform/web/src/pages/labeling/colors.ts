// 標註顏色一律取自 Design Token（src/theme/tokens.css 的 --annotation-color-N），這裡不寫色碼。

export const ANNOTATION_COLOR_COUNT = 6;

export type Rgb = [number, number, number];

function parse(value: string): Rgb | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(text);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

export function readToken(name: string): string {
  if (typeof window === 'undefined') return '';
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 第 index 個標註顏色（1 起算，超過數量時循環）。讀不到 token 時回 null，由呼叫端退回畫布的文字色。 */
export function annotationRgb(index: number): Rgb | null {
  const slot = ((Math.max(1, index) - 1) % ANNOTATION_COLOR_COUNT) + 1;
  return parse(readToken(`--annotation-color-${slot}`));
}

export function css(rgb: Rgb | null, alpha = 1): string {
  return rgb ? `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${alpha})` : 'currentColor';
}

/** 標籤 → 顏色序號：依名稱排序後編號，同一組標籤每次顏色都一樣。 */
export function colorIndexes(labels: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  [...new Set(labels)].sort().forEach((label, i) => {
    out[label] = i + 1;
  });
  return out;
}
