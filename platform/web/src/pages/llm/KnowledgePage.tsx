import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import type { UploadResult } from './api';
import { useLlm } from './useLlm';

const STATUS: Record<string, string> = { indexed: '已寫入', duplicate: '重複', failed: '失敗' };

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
      <ApiErrorAlert error={kbs.error ?? error} />
      <div className="table-wrap section">
        <table aria-label="知識庫列表">
          <thead><tr><th>名稱</th><th>文件</th><th>片段</th><th>操作</th></tr></thead>
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
      <form aria-label="新增知識庫" className="card section row-actions" onSubmit={create}>
        <div className="field">
          <label htmlFor="kb-name">知識庫名稱</label>
          <input id="kb-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="submit" className="btn btn--primary">新增知識庫</button>
      </form>
      {selected && (
        <section className="card section" aria-labelledby="docs-title">
          <h2 id="docs-title">文件（{kbs.data?.find((k) => k.id === selected)?.name}）</h2>
          <form aria-label="上傳文件" className="stack" onSubmit={upload}>
            <div className="field">
              <label htmlFor="kb-files">選擇檔案（PDF、DOCX、TXT、CSV、JSON、HTML，可多選）</label>
              <input id="kb-files" type="file" multiple accept=".pdf,.docx,.txt,.csv,.json,.html,.htm" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
            </div>
            <button type="submit" className="btn btn--primary" disabled={busy || files.length === 0}>上傳並建立向量</button>
          </form>
          {result && (
            <>
              <Alert tone={result.counts.failed ? 'warning' : 'success'}>
                寫入 {result.counts.indexed} 份、重複 {result.counts.duplicate} 份、失敗 {result.counts.failed} 份
              </Alert>
              <ul aria-label="上傳結果">
                {result.results.map((r) => (
                  <li key={r.filename}>{r.filename}：{STATUS[r.status]}{r.reason ? `（${r.reason}）` : ''}</li>
                ))}
              </ul>
            </>
          )}
          <ul aria-label="已寫入的文件">
            {(docs.data ?? []).map((d) => (
              <li key={d.id}>{d.filename}（{d.format.toUpperCase()}，{d.chunks} 個片段）</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
