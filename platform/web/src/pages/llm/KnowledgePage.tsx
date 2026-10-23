import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import type { UploadResult } from './api';
import { useLlm } from './useLlm';
import { FileInput } from '../../components/FileInput';

const STATUS: Record<string, string> = { indexed: '可使用', duplicate: '重複，已略過', failed: '未完成' };

/** 文件的處理狀態：有片段＝可使用，否則未完成。 */
export const docStatus = (chunks: number) => (chunks > 0 ? '可使用' : '未完成');

export function KnowledgePage() {
  const { llm } = useLlm();
  const kbs = useResource(() => llm!.knowledgeBases(), [llm]);
  const [selected, setSelected] = useState<number | null>(null);
  const docs = useResource(() => (selected ? llm!.documents(selected) : Promise.resolve([])), [llm, selected]);
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const kb = await llm!.createKb(name, '');
      setName('');
      kbs.reload();
      setSelected(kb.id);
    } catch (err) {
      setError(err);
    }
  }

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!selected || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await llm!.upload(selected, files));
      docs.reload();
      kbs.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="text-muted">「根據文件回答」會從這裡的文件找答案。加入文件後狀態會由「處理中」變成「可使用」；「未完成」的文件請重新加入。</p>
      <ApiErrorAlert error={kbs.error ?? error} />
      <div className="table-wrap section">
        <table aria-label="參考文件集">
          <thead><tr><th>名稱</th><th>文件數</th><th>片段</th><th>操作</th></tr></thead>
          <tbody>
            {(kbs.data ?? []).map((k) => (
              <tr key={k.id} aria-selected={k.id === selected}>
                <th scope="row">{k.name}</th><td>{k.documents}</td><td>{k.chunks}</td>
                <td className="row-actions">
                  <button type="button" className="btn btn--small btn--secondary" onClick={() => { setSelected(k.id); setResult(null); }}>管理文件</button>
                  <button type="button" className="btn btn--small btn--danger" onClick={() => void llm!.deleteKb(k.id).then(kbs.reload, setError)}>刪除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form aria-label="新增參考文件集" className="card section row-actions" onSubmit={create}>
        <div className="field">
          <label htmlFor="kb-name">文件集名稱</label>
          <input id="kb-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="submit" className="btn btn--secondary">新增文件集</button>
      </form>
      {selected && (
        <section className="card section" aria-labelledby="docs-title">
          <h2 id="docs-title">文件（{kbs.data?.find((k) => k.id === selected)?.name}）</h2>
          <form aria-label="加入文件" className="stack" onSubmit={upload}>
            <div className="field">
              <label htmlFor="kb-files">選擇檔案（PDF、DOCX、TXT、CSV、JSON、HTML，可多選）</label>
              <FileInput id="kb-files" multiple accept=".pdf,.docx,.txt,.csv,.json,.html,.htm" onFiles={setFiles} fileNames={files.map((f) => f.name)} />
            </div>
            <button type="submit" className="btn btn--primary" disabled={busy || files.length === 0}>{busy ? '處理中…' : '加入文件'}</button>
          </form>
          {result && (
            <>
              <Alert tone={result.counts.failed ? 'warning' : 'success'}>
                可使用 {result.counts.indexed} 份、重複 {result.counts.duplicate} 份、未完成 {result.counts.failed} 份
              </Alert>
              <ul aria-label="上傳結果">
                {result.results.map((r) => (
                  <li key={r.filename}>{r.filename}：{STATUS[r.status]}{r.reason ? `（${r.reason}）` : ''}</li>
                ))}
              </ul>
            </>
          )}
          <ul aria-label="文件與處理狀態">
            {(docs.data ?? []).map((d) => (
              <li key={d.id}>{d.filename}（{d.format.toUpperCase()}，{d.chunks} 個片段）：{docStatus(d.chunks)}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
