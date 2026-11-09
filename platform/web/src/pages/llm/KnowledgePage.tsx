import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { ApiErrorAlert, Card, ConfirmDialog, EmptyState } from '../../components/ui';
import type { KnowledgeBase } from './api';
import { LlmHeader } from './LlmLayout';
import { DocumentList, DocumentUpload } from './parts';
import { useLlm } from './useLlm';

export { docStatus } from './parts';

/** RAG 知識庫（原知識庫）：左邊 RAG 知識庫，右邊這個 RAG 知識庫的文件與加入文件（照 A08 的文件清單樣式）。 */
export function KnowledgePage() {
  const { llm } = useLlm();
  const kbs = useResource(() => llm!.knowledgeBases(), [llm]);
  const [selected, setSelected] = useState<number | null>(null);
  const docs = useResource(() => (selected ? llm!.documents(selected) : Promise.resolve([])), [llm, selected]);
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<KnowledgeBase | null>(null);
  const [uploadKey, setUploadKey] = useState(0);

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

  async function remove() {
    if (!removing) return;
    setError(null);
    try {
      await llm!.deleteKb(removing.id);
      if (selected === removing.id) setSelected(null);
      kbs.reload();
    } catch (err) {
      setError(err);
    } finally {
      setRemoving(null);
    }
  }

  const current = kbs.data?.find((k) => k.id === selected);

  return (
    <>
      <LlmHeader title="LLM No-code 開發" subtitle="「Chat with Knowledge Base」會從這裡的文件找答案。加入文件後狀態變成「可使用」；「未完成」的文件請重新加入。" />
      <ApiErrorAlert error={kbs.error ?? error} />
      <div className="llm-two-col">
        <Card title="RAG 知識庫" flush className="llm-kb-card">
          <div className="table-wrap">
            <table aria-label="RAG 知識庫">
              <thead>
                <tr>
                  <th>名稱</th>
                  <th>文件數</th>
                  <th>片段</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {(kbs.data ?? []).map((k) => (
                  <tr key={k.id} aria-selected={k.id === selected} className={k.id === selected ? 'llm-row--selected' : undefined}>
                    <th scope="row">{k.name}</th>
                    <td>{k.documents}</td>
                    <td>{k.chunks}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn btn--small btn--secondary"
                          onClick={() => {
                            setSelected(k.id);
                            setUploadKey((n) => n + 1);
                          }}
                        >
                          管理文件
                        </button>
                        <button type="button" className="btn btn--small btn--danger" onClick={() => setRemoving(k)}>
                          刪除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {kbs.data && kbs.data.length === 0 && (
                  <tr>
                    <td colSpan={4} className="llm-empty-row">
                      尚無 RAG 知識庫，在下面輸入名稱後按「新增 RAG 知識庫」。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <form aria-label="新增 RAG 知識庫" className="llm-inline-form" onSubmit={create}>
            <div className="field">
              <label htmlFor="kb-name">RAG 知識庫名稱</label>
              <input id="kb-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <button type="submit" className="btn btn--secondary">
              新增 RAG 知識庫
            </button>
          </form>
        </Card>

        {selected && current ? (
          <Card title={`文件（${current.name}）`}>
            <DocumentUpload
              key={uploadKey}
              llm={llm!}
              kbId={selected}
              onUploaded={() => {
                docs.reload();
                kbs.reload();
              }}
            />
            <ApiErrorAlert error={docs.error} />
            {docs.data && (
              <DocumentList
                llm={llm!}
                kbId={selected}
                docs={docs.data}
                onChanged={() => {
                  docs.reload();
                  kbs.reload();
                }}
              />
            )}
          </Card>
        ) : (
          <Card className="llm-center-card">
            <EmptyState icon="doc" title="選一個 RAG 知識庫" description="在左邊按「管理文件」，就能加入文件並查看每份文件的處理狀態。" />
          </Card>
        )}
      </div>
      {removing && (
        <ConfirmDialog title="刪除 RAG 知識庫" confirmLabel="刪除 RAG 知識庫" onConfirm={() => void remove()} onCancel={() => setRemoving(null)}>
          「{removing.name}」裡的 {removing.documents} 份文件會一起刪除，無法復原。
        </ConfirmDialog>
      )}
    </>
  );
}
