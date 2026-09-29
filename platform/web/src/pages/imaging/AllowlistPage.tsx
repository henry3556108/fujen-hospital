import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { useProjectAccess } from '../data/access';
import type { Allowlist } from './types';

/** 文字框內容 → 清單：以換行、逗號或空白分隔，去掉重複 */
export function parseAccessions(text: string): string[] {
  return [...new Set(text.split(/[\s,，、;；]+/).map((x) => x.trim()).filter(Boolean))];
}

function AllowlistForm({ initial, onSaved }: { initial: string[]; onSaved: (list: string[]) => void }) {
  const { api, project } = useSession();
  const [text, setText] = useState(initial.join('\n'));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseAccessions(text);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<Allowlist>(`/api/projects/${project!.id}/imaging/accession-allowlist`, {
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
    <form aria-label="設定 Accession 清單" className="card section" onSubmit={submit} noValidate>
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

/** TC-B01-08 Accession 清單：只有 Admin 能設定；空清單代表不限制。 */
export function AllowlistPage() {
  const { api, project } = useSession();
  const { isAdmin } = useProjectAccess();
  const list = useResource(() => api.get<Allowlist>(`/api/projects/${project!.id}/imaging/accession-allowlist`), [project!.id]);
  const [notice, setNotice] = useState<string | null>(null);
  const items = list.data?.accession_numbers ?? [];

  return (
    <>
      <h2>Accession 清單</h2>
      <p className="text-muted">
        設定清單後，這個專案在網頁、API、DICOMweb 都只看得到清單內的研究。清單外的影像仍可匯入，但不會顯示；PACS
        取像會直接拒絕清單外的研究。
      </p>
      <ApiErrorAlert error={list.error} />
      {notice && <Alert tone="success">{notice}</Alert>}
      {list.loading && !list.data && <p role="status">載入中…</p>}
      {list.data && (
        <>
          <section className="card" aria-labelledby="allowlist-current">
            <h3 id="allowlist-current">目前清單</h3>
            {items.length === 0 ? (
              <p>未設定清單：這個專案的研究不受 Accession 限制。</p>
            ) : (
              <>
                <p>共 {items.length} 筆，只顯示清單內的研究。</p>
                <ul aria-label="清單內的 Accession Number" className="col-picker mono">
                  {items.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {isAdmin ? (
            <AllowlistForm
              key={items.join(',')}
              initial={items}
              onSaved={(saved) => {
                list.setData({ accession_numbers: saved });
                setNotice(saved.length ? `已儲存 Accession 清單，共 ${saved.length} 筆` : '已清空 Accession 清單，研究不受限制');
              }}
            />
          ) : (
            <Alert tone="info">只有 Admin 可以設定 Accession 清單。</Alert>
          )}
        </>
      )}
    </>
  );
}
