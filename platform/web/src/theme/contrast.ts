// WCAG 2.x 對比度計算與 tokens.css 解析（測試用，不進入執行期打包）。

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`只支援 #rrggbb：${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type Decls = Record<string, string>;

function decls(body: string): Decls {
  const out: Decls = {};
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name.startsWith('--')) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

interface Block {
  selector: string;
  body: string;
}

function blocks(css: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    out.push({ selector: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

function resolve(raw: Decls): Decls {
  const out: Decls = {};
  const get = (name: string, seen: Set<string>): string => {
    if (seen.has(name)) throw new Error(`循環參照：${name}`);
    const v = raw[name];
    if (v === undefined) throw new Error(`未定義的 token：${name}`);
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    return m ? get(m[1], new Set([...seen, name])) : v;
  };
  for (const name of Object.keys(raw)) out[name] = get(name, new Set());
  return out;
}

export interface ParsedThemes {
  rawLight: Decls;
  rawDark: Decls;
  rawDarkMedia: Decls;
  light: Decls;
  dark: Decls;
}

export function parseThemes(css: string): ParsedThemes {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let rawLight: Decls = {};
  let rawDark: Decls = {};
  let rawDarkMedia: Decls = {};
  for (const b of blocks(clean)) {
    if (b.selector === ':root') rawLight = { ...rawLight, ...decls(b.body) };
    else if (b.selector === ':root[data-theme="dark"]') rawDark = { ...rawDark, ...decls(b.body) };
    else if (b.selector.startsWith('@media') && b.selector.includes('prefers-color-scheme: dark')) {
      for (const inner of blocks(b.body)) rawDarkMedia = { ...rawDarkMedia, ...decls(inner.body) };
    }
  }
  return {
    rawLight,
    rawDark,
    rawDarkMedia,
    light: resolve(rawLight),
    dark: resolve({ ...rawLight, ...rawDark }),
  };
}
