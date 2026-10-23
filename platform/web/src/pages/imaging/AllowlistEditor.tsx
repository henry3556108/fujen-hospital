import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import type { Allowlist } from './types';

/** 文字框內容 → 清單：以換行、逗號或空白分隔，去掉重複 */
export function parseAccessions(text: string): string[] {
  return [...new Set(text.split(/[\s,，、;；]+/).map((x) => x.trim()).filter(Boolean))];
}

/** 目前清單（唯讀）：研究區與管理區共用 */
export function AllowlistView({ items }: { items: string[] }) {
  return (
    <section className="card" aria-labelledby="allowlist-current">
      <h3 id="allowlist-current">目前清單</h3>
      {items.length === 0 ? (
        <p>未設定清單：這個專案的影像不受限制。</p>
      ) : (
        <>
          <p>共 {items.length} 筆，只顯示清單內的影像。</p>
          <ul aria-label="清單內的 Accession Number" className="col-picker mono">
            {items.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function AllowlistForm({ projectId, initial, onSaved }: { projectId: number; initial: string[]; onSaved: (list: string[]) => void }) {
  const { api } = useSession();
  const [text, setText] = useState(initial.join('\n'));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseAccessions(text);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<Allowlist>(`/api/projects/${projectId}/imaging/accession-allowlist`, {
        accession_numbers: parsed,
      });
      setText(saved.accession_numbers.join('\n'));
      onSaved(saved.accession_numbers);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="設定影像存取清單" className="card section" onSubmit={submit} noValidate>
      <h3>設定清單</h3>
      <ApiErrorAlert error={error} />
      <div className="field">
        <label htmlFor="allowlist-text">Accession Number（一行一筆）</label>
        <textarea
          id="allowlist-text"
          className="textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby="allowlist-hint"
          spellCheck={false}
        />
        <span id="allowlist-hint" className="field__hint">
          最多 16 個字元，只能用英數字、句點、底線、連字號。清空後儲存代表不限制。目前輸入 {parsed.length} 筆。
        </span>
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn--primary" disabled={busy}>
          儲存清單
        </button>
      </div>
    </form>
  );
}

/**
 * 影像存取清單的編輯元件（給管理區的專案頁用；寫入需要 Admin）。
 * projectId：要設定的專案；onSaved：儲存成功後通知（選用）。
 * 元件自己讀取目前清單、顯示清單與編輯表單、儲存結果訊息。
 */
export function AllowlistEditor({ projectId, onSaved }: { projectId: number; onSaved?: (list: string[]) => void }) {
  const { api } = useSession();
  const list = useResource(() => api.get<Allowlist>(`/api/projects/${projectId}/imaging/accession-allowlist`), [projectId]);
  const [notice, setNotice] = useState<string | null>(null);
  const items = list.data?.accession_numbers ?? [];
  return (
    <>
      <p className="text-muted">
        設定清單後，這個專案在網頁、API、DICOMweb 都只看得到清單內的影像。清單外的影像仍可匯入，但不會顯示；從院內影像系統取得時會直接拒絕清單外的影像。
      </p>
      <ApiErrorAlert error={list.error} />
      {notice && <Alert tone="success">{notice}</Alert>}
      {list.loading && !list.data && <p role="status">載入中…</p>}
      {list.data && (
        <>
          <AllowlistView items={items} />
          <AllowlistForm
            key={items.join(',')}
            projectId={projectId}
            initial={items}
            onSaved={(saved) => {
              list.setData({ accession_numbers: saved });
              setNotice(saved.length ? `已儲存影像存取清單，共 ${saved.length} 筆` : '已清空影像存取清單，影像不受限制');
              onSaved?.(saved);
            }}
          />
        </>
      )}
    </>
  );
}
