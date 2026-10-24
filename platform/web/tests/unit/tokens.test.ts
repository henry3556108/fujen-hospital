// @vitest-environment node
// 色彩 Token 檢查（~/.claude/guidelines/color-system.md §2.6、§5、§7、§11）：
// 三層 Token、元件不寫死色碼、Light/Dark 各自驗證對比度。
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseThemes } from '../../src/theme/contrast';

const root = resolve(__dirname, '../..');
const tokensCss = readFileSync(join(root, 'src/theme/tokens.css'), 'utf8');
const themes = parseThemes(tokensCss);

// [前景, 背景, 最低對比]
const TEXT = 4.5;
const UI = 3;
const PAIRS: [string, string, number][] = [
  ['--color-text-primary', '--color-bg-page', TEXT],
  ['--color-text-primary', '--color-bg-surface', TEXT],
  ['--color-text-primary', '--color-bg-subtle', TEXT],
  ['--color-text-secondary', '--color-bg-surface', TEXT],
  ['--color-text-secondary', '--color-bg-page', TEXT],
  ['--color-text-muted', '--color-bg-surface', TEXT],
  ['--color-text-muted', '--color-bg-page', TEXT],
  ['--color-text-muted', '--color-bg-subtle', TEXT],
  ['--color-text-link', '--color-bg-surface', TEXT],
  ['--color-text-link', '--color-bg-page', TEXT],
  ['--color-text-primary', '--color-bg-hover', TEXT],
  ['--color-text-primary', '--color-bg-pressed', TEXT],
  ['--color-text-selected', '--color-bg-selected', TEXT],
  ['--color-text-on-action', '--color-action-primary', TEXT],
  ['--color-text-on-action', '--color-action-primary-hover', TEXT],
  ['--color-text-on-action', '--color-action-primary-pressed', TEXT],
  ['--color-text-on-danger', '--color-action-danger', TEXT],
  ['--color-text-on-danger', '--color-action-danger-hover', TEXT],
  ['--color-text-on-danger', '--color-action-danger-pressed', TEXT],
  ['--color-text-disabled', '--color-bg-disabled', UI],
  ['--color-accent-text', '--color-accent-bg', TEXT],
  ...(['success', 'warning', 'error', 'info'] as const).flatMap(
    (s): [string, string, number][] => [
      [`--color-status-${s}-text`, `--color-status-${s}-bg`, TEXT],
      [`--color-status-${s}-icon`, `--color-status-${s}-bg`, UI],
      [`--color-status-${s}-border`, `--color-bg-surface`, UI],
    ],
  ),
  ['--color-border-strong', '--color-bg-surface', UI],
  ['--color-border-strong', '--color-bg-page', UI],
  ['--color-focus-ring', '--color-bg-surface', UI],
  ['--color-focus-ring', '--color-bg-page', UI],
  ['--color-focus-ring', '--color-bg-subtle', UI],
  ['--color-action-primary', '--color-bg-surface', UI],
  ['--color-border-selected', '--color-bg-surface', UI],
  ['--color-sidebar-text', '--color-sidebar-bg', TEXT],
  ['--color-sidebar-text-muted', '--color-sidebar-bg', TEXT],
  ['--color-sidebar-text', '--color-sidebar-bg-hover', TEXT],
  ['--color-sidebar-text-selected', '--color-sidebar-bg-selected', TEXT],
];

describe('design tokens', () => {
  it('has three layers: primitive, semantic and component tokens', () => {
    const names = Object.keys(themes.light);
    expect(names.some((n) => /^--primitive-/.test(n))).toBe(true);
    expect(names.some((n) => /^--color-/.test(n))).toBe(true);
    expect(names.some((n) => /^--(button|input|nav|alert|badge|card|checkbox|dialog|focus)-/.test(n))).toBe(true);
  });

  it('semantic and component tokens only reference other tokens, never raw colours', () => {
    for (const [name, value] of Object.entries(themes.rawLight).concat(Object.entries(themes.rawDark))) {
      if (name.startsWith('--primitive-')) continue;
      expect(value, `${name} 不可直接寫色碼`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    }
  });

  it('dark theme: data-theme="dark" and the follow-system media query define the same tokens', () => {
    expect(Object.keys(themes.rawDark).length).toBeGreaterThan(20);
    expect(themes.rawDarkMedia).toEqual(themes.rawDark);
    expect(themes.dark['--color-bg-page']).not.toBe(themes.light['--color-bg-page']);
  });

  it('uses the proposal palette', () => {
    const t = themes.light;
    expect(t['--color-action-primary']).toBe('#2458c6');
    expect(t['--color-secondary']).toBe('#087f78');
    expect(t['--color-text-primary']).toBe('#172b4d');
    expect(t['--color-text-secondary']).toBe('#526176');
    expect(t['--color-bg-page']).toBe('#f4f7fb');
    expect(t['--color-bg-surface']).toBe('#ffffff');
    expect(t['--color-border-default']).toBe('#dce3ed');
    expect(t['--color-status-warning-icon']).toBe('#9a5800');
    expect(t['--color-status-error-icon']).toBe('#b42318');
  });

  for (const theme of ['light', 'dark'] as const) {
    it.each(PAIRS)(`${theme}: %s on %s ≥ %s:1`, (fg, bg, min) => {
      const t = themes[theme];
      expect(t[fg], `${fg} 未定義`).toBeDefined();
      expect(t[bg], `${bg} 未定義`).toBeDefined();
      const ratio = contrastRatio(t[fg], t[bg]);
      expect(ratio, `${theme} ${fg} ${t[fg]} on ${bg} ${t[bg]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
    });
  }

  it('component CSS and TSX never hard-code colours', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (/\.(css|tsx)$/.test(d.name) && !p.endsWith('tokens.css')) files.push(p);
      }
    };
    walk(join(root, 'src'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} 含寫死色碼`).not.toMatch(/#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(\s*\d|hsla?\(\s*\d/i);
    }
  });
});

describe('contrastRatio', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
});
