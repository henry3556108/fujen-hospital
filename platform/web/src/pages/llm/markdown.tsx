// 團隊文件的 Markdown 預覽與編輯工具列。只處理常用語法（標題、粗體、斜體、程式碼、清單、連結），
// 一律產生 React 元素，不用 innerHTML。
import type { ReactNode, RefObject } from 'react';
import { Icon } from '../../components/Icon';

const SAFE_URL = /^(https?:\/\/|\/|#|\.{0,2}\/)/i;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push(SAFE_URL.test(url) ? <a key={k} href={url} target="_blank" rel="noreferrer">{label}</a> : label);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${n++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={key}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 1, 6);
      const H = `h${level}` as 'h2';
      blocks.push(<H key={key}>{inline(h[2], key)}</H>);
      i++;
      continue;
    }
    if (/^\s*([-*•])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•])\s+/, ''));
      blocks.push(<ul key={key}>{items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      blocks.push(<ol key={key}>{items.map((t, j) => <li key={j}>{inline(t, `${key}-${j}`)}</li>)}</ol>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*•]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key}>{para.flatMap((t, j) => (j ? [<br key={`br${j}`} />, ...inline(t, `${key}-${j}`)] : inline(t, `${key}-${j}`)))}</p>);
  }
  return blocks;
}

type Edit = { wrap?: [string, string]; prefix?: string; placeholder: string };

const TOOLS: { label: string; text: ReactNode; edit: Edit }[] = [
  { label: '插入標題', text: 'H', edit: { prefix: '# ', placeholder: '標題' } },
  { label: '粗體', text: 'B', edit: { wrap: ['**', '**'], placeholder: '粗體文字' } },
  { label: '斜體', text: 'I', edit: { wrap: ['*', '*'], placeholder: '斜體文字' } },
  { label: '程式碼', text: '</>', edit: { wrap: ['`', '`'], placeholder: 'code' } },
  { label: '項目清單', text: '•', edit: { prefix: '- ', placeholder: '項目' } },
  { label: '編號清單', text: '1.', edit: { prefix: '1. ', placeholder: '項目' } },
  { label: '連結', text: <Icon name="external" />, edit: { wrap: ['[', '](https://)'], placeholder: '連結文字' } },
];

/** 在游標位置套用語法，回傳新內容與新的選取範圍 */
export function applyEdit(value: string, start: number, end: number, edit: Edit): { value: string; start: number; end: number } {
  const selected = value.slice(start, end) || edit.placeholder;
  if (edit.wrap) {
    const [a, b] = edit.wrap;
    const next = value.slice(0, start) + a + selected + b + value.slice(end);
    return { value: next, start: start + a.length, end: start + a.length + selected.length };
  }
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const prefix = edit.prefix ?? '';
  const body = value.slice(start, end) ? value.slice(lineStart, end).replace(/^/gm, prefix) : prefix + selected;
  const from = value.slice(start, end) ? lineStart : start;
  const next = value.slice(0, from) + body + value.slice(end);
  return { value: next, start: from + prefix.length, end: from + body.length };
}

export function MarkdownToolbar({ target, value, onChange, disabled }: { target: RefObject<HTMLTextAreaElement | null>; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div role="toolbar" aria-label="Markdown 工具列" className="llm-md-toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.label}
          type="button"
          className="llm-md-toolbar__btn"
          aria-label={t.label}
          title={t.label}
          disabled={disabled}
          onClick={() => {
            const el = target.current;
            const r = applyEdit(value, el?.selectionStart ?? value.length, el?.selectionEnd ?? value.length, t.edit);
            onChange(r.value);
            requestAnimationFrame(() => {
              el?.focus();
              el?.setSelectionRange(r.start, r.end);
            });
          }}
        >
          <span aria-hidden="true">{t.text}</span>
        </button>
      ))}
    </div>
  );
}
