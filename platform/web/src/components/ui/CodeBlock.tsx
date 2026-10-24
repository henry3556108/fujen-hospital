import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import './ui.css';

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 改用下面的舊方法
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 程式碼區塊：等寬字、行號、右上「複製」（設計稿 B08 流程程式碼、B11 模型下載 Python 範例）。 */
export function CodeBlock({
  code,
  title,
  language,
  lineNumbers = true,
  maxHeight,
}: {
  code: string;
  /** 左上檔名或說明，例：predict.py */
  title?: string;
  language?: string;
  lineNumbers?: boolean;
  /** CSS 高度，超過時捲動 */
  maxHeight?: string;
}) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const lines = code.replace(/\n$/, '').split('\n');

  const onCopy = async () => {
    const ok = await copyText(code);
    setCopied(ok ? 'ok' : 'fail');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied('idle'), 2000);
  };

  return (
    <figure className="ui-code">
      <div className="ui-code__head">
        <span className="ui-code__title">{title ?? language ?? ''}</span>
        <button type="button" className="btn btn--secondary btn--small" onClick={() => void onCopy()}>
          <Icon name={copied === 'ok' ? 'check' : 'copy'} />
          {copied === 'ok' ? '已複製' : copied === 'fail' ? '複製失敗，請手動選取' : '複製'}
        </button>
      </div>
      <pre className="ui-code__pre" style={maxHeight ? { maxHeight } : undefined} tabIndex={0} aria-label={title ?? '程式碼'}>
        <code data-language={language}>
          {lines.map((l, i) => (
            <span key={i} className="ui-code__line">
              {lineNumbers && (
                <span className="ui-code__ln" aria-hidden="true">
                  {i + 1}
                </span>
              )}
              <span className="ui-code__text">{l || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
