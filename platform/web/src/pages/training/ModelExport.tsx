// 模型匯出（B-05）：完成的訓練下載模型檔（影像 Keras H5、結構式 scikit-learn pkl），以及匯出原始碼（範本＋這次的設定，需要 Coding）。
import { useState } from 'react';
import type { Permission } from '../../api/types';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { saveFile, type Download, type TrainingApi, type TrainingRun } from './api';

export function useHasPermission(permission: Permission): boolean {
  const { project } = useSession();
  return project?.permissions.includes(permission) ?? false;
}

/** 下載並存檔；回傳給畫面顯示的訊息。 */
export async function downloadAndSave(load: () => Promise<Download>): Promise<string> {
  const file = await load();
  saveFile(file);
  return file.sha256 ? `已下載 ${file.filename}（SHA-256：${file.sha256}）` : `已下載 ${file.filename}`;
}

export function ModelExport({ api, run }: { api: TrainingApi; run: TrainingRun }) {
  const canCode = useHasPermission('coding');
  const [done, setDone] = useState('');
  const [error, setError] = useState<unknown>(null);
  const format = run.kind.startsWith('image_') ? 'H5' : 'PKL';

  async function act(load: () => Promise<Download>) {
    setError(null);
    setDone('');
    try {
      setDone(await downloadAndSave(load));
    } catch (err) {
      setError(err);
    }
  }

  return (
    <section className="stack" aria-labelledby={`export-${run.id}`}>
      <h3 id={`export-${run.id}`}>模型匯出</h3>
      <p className="text-muted">
        模型檔可在平台外以 {format === 'H5' ? 'TensorFlow／Keras' : 'scikit-learn'} 載入；原始碼包含訓練範本、這次的設定與說明，解壓後可修改再執行。
      </p>
      {done ? <Alert tone="success">{done}</Alert> : null}
      <ApiErrorAlert error={error} />
      <div className="row-actions">
        <button type="button" className="btn btn--primary" onClick={() => void act(() => api.downloadModel(run.model_id!))}>
          下載模型（{format}）
        </button>
        {canCode ? (
          <button type="button" className="btn btn--secondary" onClick={() => void act(() => api.exportSource(run.id))}>
            匯出原始碼
          </button>
        ) : null}
      </div>
      {!canCode ? <Alert tone="info">匯出原始碼需要 Coding 權限；如需使用，請聯絡專案負責人或系統管理者。</Alert> : null}
    </section>
  );
}
