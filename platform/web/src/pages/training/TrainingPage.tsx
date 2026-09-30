// 建模管理（B-05）：訓練設定（5 種）、送出訓練與狀態、指標、模型匯出。需要目前專案的 Training 權限（入口規則）。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { KIND_NAMES } from '../inference/api';
import { useTrainingApi, type Catalogue, type TrainingApi, type TrainingSetting } from './api';
import { SettingForm } from './SettingForm';
import { emptyForm, formFromSetting, type FormState } from './settingForm';
import { Runs } from './Runs';
import '../../styles/pages.css';
import './training.css';

export function TrainingPage() {
  const api = useTrainingApi();
  return (
    <>
      <h1>建模管理</h1>
      {api ? <Training key={api.projectId} api={api} /> : <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>}
      <section className="section" aria-labelledby="training-jobs">
        <h2 id="training-jobs">排程</h2>
        <Link to="/training/jobs" className="card link-card">
          <span className="link-card__title">專案工作</span>
          <span>查看訓練在 GPU 佇列的排隊與執行狀態、送出其他排程工作</span>
        </Link>
      </section>
    </>
  );
}

function Training({ api }: { api: TrainingApi }) {
  const catalogue = useResource(() => api.catalogue(), [api]);
  const settings = useResource(() => api.settings(), [api]);
  const [editor, setEditor] = useState<{ form: FormState; editing: TrainingSetting | null; key: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [deleting, setDeleting] = useState<TrainingSetting | null>(null);
  const [executor, setExecutor] = useState('template');
  const [runsNonce, setRunsNonce] = useState(0);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);

  if (catalogue.error) return <ApiErrorAlert error={catalogue.error} />;
  if (!catalogue.data) return <p role="status">載入中…</p>;
  const cat: Catalogue = catalogue.data;

  async function edit(s: TrainingSetting) {
    setError(null);
    setNotice('');
    try {
      const fresh = await api.setting(s.id); // 以伺服器存的版本為準
      setEditor({ form: formFromSetting(cat, fresh), editing: fresh, key: Date.now() });
    } catch (err) {
      setError(err);
    }
  }

  async function submit(s: TrainingSetting) {
    setError(null);
    setNotice('');
    try {
      const run = await api.submit(s.id, executor);
      setNotice(`已送出訓練 #${run.id}（${s.name}），目前排隊中。`);
      setSelectedRun(run.id);
      setRunsNonce((n) => n + 1);
    } catch (err) {
      setError(err);
    }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await api.deleteSetting(deleting.id);
      setNotice(`已刪除訓練設定「${deleting.name}」。`);
      if (editor?.editing?.id === deleting.id) setEditor(null);
      settings.reload();
    } catch (err) {
      setError(err);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="stack">
      <section className="card section" aria-labelledby="settings-title">
        <div className="training-head">
          <h2 id="settings-title">訓練設定</h2>
          <button type="button" className="btn btn--primary"
            onClick={() => { setNotice(''); setEditor({ form: emptyForm(cat), editing: null, key: Date.now() }); }}>
            新增訓練設定
          </button>
        </div>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <ApiErrorAlert error={error ?? settings.error} />
        {settings.data && settings.data.length === 0 ? <p className="text-muted">還沒有訓練設定。按「新增訓練設定」開始。</p> : null}
        {settings.data && settings.data.length > 0 ? (
          <>
            <div className="field field--inline">
              <label htmlFor="ts-executor">執行方式</label>
              <select id="ts-executor" className="select" value={executor} onChange={(e) => setExecutor(e.target.value)}>
                <option value="template">平台範本訓練</option>
                {cat.executors.includes('fake') ? <option value="fake">快速測試（fake-trainer，不做真正訓練）</option> : null}
              </select>
            </div>
            <div className="table-wrap">
              <table className="table" aria-label="訓練設定清單">
                <thead>
                  <tr>
                    <th scope="col">名稱</th>
                    <th scope="col">種類</th>
                    <th scope="col">亂數種子</th>
                    <th scope="col">最後修改</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.data.map((s) => (
                    <tr key={s.id}>
                      <th scope="row">{s.name}</th>
                      <td>{KIND_NAMES[s.kind]}</td>
                      <td>{s.config.seed}</td>
                      <td>
                        {s.updated_by}，{formatTime(s.updated_at)}
                      </td>
                      <td className="row-actions">
                        <button type="button" className="btn btn--small btn--primary" onClick={() => void submit(s)}>
                          送出訓練「{s.name}」
                        </button>
                        <button type="button" className="btn btn--small btn--secondary" onClick={() => void edit(s)}>
                          編輯「{s.name}」
                        </button>
                        <button type="button" className="btn btn--small btn--danger" onClick={() => setDeleting(s)}>
                          刪除「{s.name}」
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </section>

      {editor ? (
        <SettingForm
          key={editor.key}
          api={api}
          catalogue={cat}
          initial={editor.form}
          editing={editor.editing}
          onCancel={() => setEditor(null)}
          onSaved={(s) => {
            setNotice(editor.editing ? `已儲存訓練設定「${s.name}」的修改。` : `已新增訓練設定「${s.name}」。`);
            setEditor(null);
            settings.reload();
          }}
        />
      ) : null}

      <Runs key={runsNonce} api={api} selected={selectedRun} onSelect={setSelectedRun} />

      {deleting ? (
        <ConfirmDialog title="刪除訓練設定" confirmLabel="刪除" onConfirm={() => void remove()} onCancel={() => setDeleting(null)}>
          確定要刪除訓練設定「{deleting.name}」嗎？已送出的訓練與模型不受影響。
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
