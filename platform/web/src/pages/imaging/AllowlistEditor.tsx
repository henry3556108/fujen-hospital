import { useState, type DragEvent, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { FileInput } from '../../components/FileInput';
import { Badge, Icon } from '../../components/ui';
import type { Allowlist } from './types';
import '../admin/admin.css';

/** 文字框內容 → 清單：以換行、逗號或空白分隔，去掉重複 */
export function parseAccessions(text: string): string[] {
  return [...new Set(text.split(/[\s,，、;；]+/).map((x) => x.trim()).filter(Boolean))];
}

/** 上傳的 .csv / .txt → 清單：每行一個 Accession；.csv 取第一欄，第一行是欄名（含 accession）時略過 */
export function parseAccessionFile(name: string, text: string): string[] {
  if (!/\.csv$/i.test(name)) return parseAccessions(text);
  const lines = text.split(/\r?\n/).map((l) => l.split(',')[0].replace(/^"|"$/g, '').trim());
  if (lines.length && /accession/i.test(lines[0])) lines.shift();
  return parseAccessions(lines.join('\n'));
}

// 與後端相同的格式限制：最多 16 個字元，只能用英數字、句點、底線、連字號
const VALID = /^[A-Za-z0-9._-]{1,16}$/;
export const invalidAccessions = (list: string[]) => list.filter((a) => !VALID.test(a));

export interface AllowlistDiffRow {
  accession: string;
  before: boolean;
  after: boolean;
}

/** 儲存前差異：新清單依原順序，接著列出會被移除的；空清單代表不限制（所有影像都看得到） */
export function diffAllowlist(current: string[], next: string[]): { added: string[]; removed: string[]; rows: AllowlistDiffRow[] } {
  const cur = new Set(current);
  const nxt = new Set(next);
  const added = next.filter((a) => !cur.has(a));
  const removed = current.filter((a) => !nxt.has(a));
  const rows = [
    ...next.map((a) => ({ accession: a, before: current.length === 0 || cur.has(a), after: true })),
    ...removed.map((a) => ({ accession: a, before: true, after: next.length === 0 })),
  ];
  return { added, removed, rows };
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

const PREVIEW_LIMIT = 50;

function StateBadge({ included, unlimited }: { included: boolean; unlimited?: boolean }) {
  if (unlimited) return <Badge tone="neutral">不限制</Badge>;
  return included ? <Badge tone="success">包含</Badge> : <Badge tone="error">不包含</Badge>;
}

function AllowlistForm({ projectId, initial, onSaved }: { projectId: number; initial: string[]; onSaved: (list: string[]) => void }) {
  const { api } = useSession();
  const [text, setText] = useState(initial.join('\n'));
  const [confirmed, setConfirmed] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const parsed = parseAccessions(text);
  const bad = invalidAccessions(parsed);
  const { added, removed, rows } = diffAllowlist(initial, parsed);
  const changed = added.length > 0 || removed.length > 0;

  function update(next: string) {
    setText(next);
    setConfirmed(false); // 內容變了要重新確認
  }

  async function readFile(file: File | undefined) {
    setFileError(null);
    setFileNote(null);
    if (!file) return;
    if (!/\.(csv|txt)$/i.test(file.name)) {
      setFileError(`「${file.name}」不是 .csv 或 .txt 檔。`);
      return;
    }
    const content = await file.text();
    const list = parseAccessionFile(file.name, content);
    update(list.join('\n'));
    setFileNote(`已讀入「${file.name}」，共 ${list.length} 筆（重複的已去掉）。`);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void readFile(e.dataTransfer.files?.[0]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<Allowlist>(`/api/projects/${projectId}/imaging/accession-allowlist`, {
        accession_numbers: parsed,
      });
      setText(saved.accession_numbers.join('\n'));
      setConfirmed(false);
      onSaved(saved.accession_numbers);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label="設定 Accession Number 清單" className="ui-card adm-allow" onSubmit={submit} noValidate>
      <ApiErrorAlert error={error} />
      <div className="adm-allow__top">
        <div className="adm-allow__input">
          <h3 className="ui-card__title">上傳識別號或單號（Accession Number）清單</h3>
          <div
            className={`adm-drop ${dragging ? 'adm-drop--over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Icon name="upload" />
            <label htmlFor="allowlist-file" className="adm-drop__label">
              選擇檔案或拖曳上傳
            </label>
            <FileInput id="allowlist-file" accept=".csv,.txt,text/csv,text/plain" onFiles={(files) => void readFile(files[0])} />
            <span className="field__hint">支援 .csv、.txt（每行一個 Accession）</span>
          </div>
          {fileNote && <p className="field__hint">{fileNote}</p>}
          {fileError && <Alert tone="error">{fileError}</Alert>}
          <div className="field">
            <label htmlFor="allowlist-text">Accession Number（一行一筆，也可以直接貼上）</label>
            <textarea
              id="allowlist-text"
              className="textarea"
              value={text}
              onChange={(e) => update(e.target.value)}
              aria-describedby="allowlist-hint"
              spellCheck={false}
            />
            <span id="allowlist-hint" className="field__hint">
              最多 16 個字元，只能用英數字、句點、底線、連字號。清空後儲存代表不限制。目前輸入 {parsed.length} 筆。
            </span>
          </div>
          {bad.length > 0 && (
            <Alert tone="warning">
              格式不符 {bad.length} 筆：{bad.slice(0, 5).join('、')}
              {bad.length > 5 ? '…' : ''}。儲存時會被拒絕，請先修正。
            </Alert>
          )}
        </div>
        <div className="adm-allow__diff" aria-label="與目前清單的差異" role="group">
          <dl className="adm-allow__counts">
            <div>
              <dt>新清單</dt>
              <dd>
                <strong>{parsed.length}</strong> 筆
              </dd>
            </div>
            <div>
              <dt>目前</dt>
              <dd>
                <strong>{initial.length}</strong> 筆
              </dd>
            </div>
          </dl>
          <dl className="adm-allow__delta">
            <dt>與目前清單的差異</dt>
            <dd className="adm-allow__added">
              新增 <strong>{added.length}</strong>
            </dd>
            <dd className="adm-allow__removed">
              移除 <strong>{removed.length}</strong>
            </dd>
          </dl>
        </div>
      </div>

      {changed && (
        <section aria-labelledby="allowlist-preview">
          <h3 id="allowlist-preview" className="adm-subhead">
            預覽（{rows.length > PREVIEW_LIMIT ? `前 ${PREVIEW_LIMIT} 筆，共 ${rows.length} 筆` : `${rows.length} 筆`}）
          </h3>
          <div className="table-wrap">
            <table aria-label="變更預覽">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Accession 編號</th>
                  <th scope="col">目前狀態</th>
                  <th scope="col">變更後狀態</th>
                  <th scope="col">變更說明</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, PREVIEW_LIMIT).map((r, i) => (
                  <tr key={r.accession}>
                    <td>{i + 1}</td>
                    <th scope="row" className="mono">
                      {r.accession}
                    </th>
                    <td>
                      <StateBadge included={r.before} unlimited={initial.length === 0} />
                    </td>
                    <td>
                      <StateBadge included={r.after} unlimited={parsed.length === 0} />
                    </td>
                    <td>{added.includes(r.accession) ? '新增' : removed.includes(r.accession) ? '移除' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <Alert tone="info">
        清空清單表示不限制。此清單是本專案的影像範圍：清單外的影像仍可匯入，但網頁、API、DICOMweb 都看不到；從影像儲傳系統取得時會直接拒絕。
      </Alert>

      <div className="adm-allow__foot">
        <label className="checkbox adm-allow__confirm">
          <input type="checkbox" checked={confirmed} disabled={!changed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>
            <strong>已確認變更範圍</strong>
            <span className="field__hint">我已檢視上述清單與差異，確認內容正確。</span>
          </span>
        </label>
        <div className="row-actions">
          <button type="button" className="btn btn--secondary" disabled={busy || parsed.length === 0} onClick={() => update('')}>
            清空清單
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !changed || !confirmed}>
            儲存清單
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * Accession Number 清單的編輯元件（設計稿 B07，給管理區的專案頁用；寫入需要 Admin）。
 * projectId：要設定的專案；onSaved：儲存成功後通知（選用）。
 * 元件自己讀取目前清單、上傳或貼上新清單、儲存前顯示差異並要求確認。
 */
export function AllowlistEditor({ projectId, projectName, onSaved }: { projectId: number; projectName?: string; onSaved?: (list: string[]) => void }) {
  const { api } = useSession();
  const list = useResource(() => api.get<Allowlist>(`/api/projects/${projectId}/imaging/accession-allowlist`), [projectId]);
  const [notice, setNotice] = useState<string | null>(null);
  const items = list.data?.accession_numbers ?? [];
  return (
    <div className="adm-allowlist">
      <p className="text-muted">
        用 DICOM 影像中的識別號或單號（Accession Number，標籤 0008,0050）限制{projectName ? `專案「${projectName}」` : '這個專案'}能看的資料，與一般篩選分開。設定後網頁、API、DICOMweb 都只看得到清單內的影像。數據管理頁只能看，不能修改。
      </p>
      <ApiErrorAlert error={list.error} />
      {notice && <Alert tone="success">{notice}</Alert>}
      {list.loading && !list.data && <p role="status">載入中…</p>}
      {list.data && (
        <>
          <AllowlistForm
            key={items.join(',')}
            projectId={projectId}
            initial={items}
            onSaved={(saved) => {
              list.setData({ accession_numbers: saved });
              setNotice(saved.length ? `已儲存 Accession Number 清單，共 ${saved.length} 筆` : '已清空 Accession Number 清單，影像不受限制');
              onSaved?.(saved);
            }}
          />
          <AllowlistView items={items} />
        </>
      )}
    </div>
  );
}
