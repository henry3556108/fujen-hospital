// 流程程式碼（錄製巨集）：一份訓練設定的標註、資料清理與前處理、訓練三個環節。
// 每個環節可以檢視程式碼、在網頁上修改後套用、下載環節檔、上傳環節檔、改回用介面設定；另可下載整個流程（專案包）。
import { useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime } from '../../components/format';
import { Icon } from '../../components/Icon';
import { isImageKind, saveFile, type StageEntry, type StageId, type StageOverview, type TrainingApi, type TrainingSetting } from './api';
import { STAGE_NAMES } from './stages';

interface Props {
  api: TrainingApi;
  setting: TrainingSetting;
  /** 套用、上傳、改回後：訓練設定已變更 */
  onChanged: (setting: TrainingSetting) => void;
  onClose: () => void;
}

interface Editing {
  stage: StageId;
  files: Record<string, string>;
  defaultCode: string;
}

/** 不符合框架時伺服器一次列出全部錯誤 */
export function StageErrors({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.fieldErrors.length > 0) {
    return (
      <Alert tone="error" title={error.message || '檔案不符合平台的框架'}>
        <ul className="alert__list" aria-label="錯誤清單">
          {error.fieldErrors.map((f, i) => (
            <li key={i}>{f.message}</li>
          ))}
        </ul>
      </Alert>
    );
  }
  return <ApiErrorAlert error={error} />;
}

export function StagesPanel({ api, setting, onChanged, onClose }: Props) {
  const loaded = useResource(() => api.stages(setting.id), [api, setting.id]);
  const [latest, setLatest] = useState<StageOverview | null>(null);
  const overview = latest ?? loaded.data;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [unlocking, setUnlocking] = useState<StageEntry | null>(null);
  const [includeData, setIncludeData] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploadStage, setUploadStage] = useState<StageId | null>(null);
  const canCode = overview?.can_code ?? false;
  const image = isImageKind(setting.kind);

  async function run(action: () => Promise<StageOverview | void>, done?: (out: StageOverview) => string) {
    setError(null);
    setNotice('');
    setBusy(true);
    try {
      const out = await action();
      if (out) {
        setLatest(out);
        if (out.setting) onChanged(out.setting);
        if (done) setNotice(done(out));
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function openView(stage: StageId) {
    setError(null);
    setNotice('');
    try {
      const view = await api.stageView(setting.id, stage);
      setEditing({ stage, files: { ...view.files }, defaultCode: view.default_code });
    } catch (err) {
      setError(err);
    }
  }

  const applied = (stage: StageId) => (out: StageOverview) =>
    `已套用「${STAGE_NAMES[stage]}」：這個環節改由匯入的內容控制，訓練設定表單上對應的欄位已停用。` +
    (out.problem ? '' : '送出訓練時會使用這些設定與程式。');

  function upload(file: File | undefined) {
    if (!file || !uploadStage) return;
    const stage = uploadStage;
    void run(() => api.uploadStage(setting.id, stage, file), applied(stage));
    if (uploadRef.current) uploadRef.current.value = '';
  }

  if (loaded.error) return <ApiErrorAlert error={loaded.error} />;
  if (!overview) return <p role="status">載入中…</p>;

  const codeName = editing ? `${editing.stage}.py` : '';
  return (
    <section className="card section stack" aria-labelledby="stages-title">
      <div className="training-head">
        <h2 id="stages-title">流程程式碼「{setting.name}」</h2>
        <button type="button" className="btn btn--secondary" onClick={onClose}>
          關閉流程程式碼
        </button>
      </div>
      <p className="field__hint">
        每個環節可以下載設定檔與程式檔，修改後上傳或直接在網頁上修改後套用。套用後這個環節由匯入的內容控制，訓練設定表單上對應的欄位會停用；
        要回到用表單設定，按「改回用介面設定」。
      </p>
      {!canCode ? <Alert tone="info">你沒有程式開發（Coding）權限，可以查看狀態與改回用介面設定，不能檢視或匯入程式碼。</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {overview.problem ? (
        <Alert tone="warning" title="需要處理">
          {overview.problem}（處理完才能送出訓練）
        </Alert>
      ) : null}
      <StageErrors error={error} />

      <div className="table-wrap">
        <table className="table" aria-label="流程環節">
          <thead>
            <tr>
              <th scope="col">環節</th>
              <th scope="col">目前由誰控制</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {overview.stages.map((s) => (
              <tr key={s.stage}>
                <th scope="row">{s.name}</th>
                <td>
                  {s.locked ? (
                    <span className="stack">
                      <span className="badge status-badge status-badge--info"><Icon name="lock" className="stage-lock" /> 匯入檔控制</span>
                      <span className="field__hint">
                        {Object.keys(s.locked.files).join('、')}（{s.locked.imported_by}，{formatTime(s.locked.imported_at)} 匯入，sha256 {s.locked.sha256.slice(0, 4)}…）
                        {s.locked.code_changed ? '程式已修改。' : '程式與平台相同，只改設定值。'}
                      </span>
                      {s.problem ? <span className="badge status-badge status-badge--warning">需要處理</span> : null}
                    </span>
                  ) : (
                    '介面設定'
                  )}
                </td>
                <td className="row-actions">
                  {canCode ? (
                    <>
                      <button type="button" className="btn btn--small btn--secondary" onClick={() => void openView(s.stage)}>
                        檢視程式碼「{s.name}」
                      </button>
                      <button type="button" className="btn btn--small btn--secondary"
                        onClick={() => void run(async () => saveFile(await api.exportStage(setting.id, s.stage)))}>
                        下載環節檔「{s.name}」
                      </button>
                      <button type="button" className="btn btn--small btn--secondary" disabled={busy}
                        onClick={() => { setUploadStage(s.stage); uploadRef.current?.click(); }}>
                        上傳環節檔「{s.name}」
                      </button>
                    </>
                  ) : null}
                  {s.locked ? (
                    <button type="button" className="btn btn--small btn--danger" onClick={() => setUnlocking(s)}>
                      改回用介面設定「{s.name}」
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <input ref={uploadRef} type="file" accept=".zip,application/zip" hidden aria-label="選擇環節檔（zip）"
        onChange={(e) => upload(e.target.files?.[0])} />

      {editing ? (
        <div className="stack" role="group" aria-label={`程式碼「${STAGE_NAMES[editing.stage]}」`}>
          <h3>程式碼「{STAGE_NAMES[editing.stage]}」</h3>
          <p className="field__hint">
            {editing.stage}.json 是這個環節的設定值，{codeName} 是程式（必須保留平台呼叫的函式名稱與參數）。按「套用」後平台會先檢查，不符合時列出全部問題，設定不會改變。
          </p>
          {Object.entries(editing.files).map(([name, text]) => (
            <div className="field" key={name}>
              <label htmlFor={`stage-file-${name}`}>{name}</label>
              <textarea id={`stage-file-${name}`} className="input stage-code" rows={name.endsWith('.py') ? 18 : 8} spellCheck={false}
                value={text} onChange={(e) => setEditing({ ...editing, files: { ...editing.files, [name]: e.target.value } })} />
            </div>
          ))}
          <div className="row-actions">
            <button type="button" className="btn btn--primary" disabled={busy}
              onClick={() => void run(async () => {
                const out = await api.applyStage(setting.id, editing.stage, editing.files);
                setEditing(null);
                return out;
              }, applied(editing.stage))}>
              {busy ? '檢查中…' : `套用「${STAGE_NAMES[editing.stage]}」`}
            </button>
            <button type="button" className="btn btn--secondary"
              onClick={() => setEditing({ ...editing, files: { ...editing.files, [codeName]: editing.defaultCode } })}>
              {codeName} 還原成平台預設程式
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setEditing(null)}>
              不套用，關閉
            </button>
          </div>
        </div>
      ) : null}

      <div className="stack">
        <h3>整個流程（專案包）</h3>
        <p className="field__hint">
          下載資料匯入、標註、前處理、訓練、部署五個環節的設定與程式，以及在自己電腦重做的說明（README.md、run_all.py）。影像與研究編號已去識別。
        </p>
        {!image && canCode ? (
          <label className="checkbox">
            <input type="checkbox" checked={includeData} onChange={(e) => setIncludeData(e.target.checked)} />
            附上原始資料（只含用到的欄位；限計畫主持人，會記錄在稽核紀錄的資料交換）
          </label>
        ) : null}
        {canCode ? (
          <div className="row-actions">
            <button type="button" className="btn btn--secondary" disabled={busy}
              onClick={() => void run(async () => saveFile(await api.exportPackage(setting.id, includeData)))}>
              下載整個流程（專案包）
            </button>
          </div>
        ) : null}
      </div>

      {unlocking?.locked ? (
        <ConfirmDialog
          title={`改回用介面設定「${unlocking.name}」？`}
          confirmLabel="刪除匯入檔並改回介面設定"
          busy={busy}
          onCancel={() => setUnlocking(null)}
          onConfirm={() => {
            const stage = unlocking;
            setUnlocking(null);
            void run(() => api.unlockStage(setting.id, stage.stage), (out) =>
              `已改回用介面設定「${stage.name}」，匯入的檔案已刪除。` + (out.problem ? '其他環節需要處理，請看上方說明。' : ''));
          }}
          extraActions={canCode ? (
            <button type="button" className="btn btn--secondary"
              onClick={() => void run(async () => saveFile(await api.exportStage(setting.id, unlocking.stage)))}>
              下載匯入檔
            </button>
          ) : null}
        >
          <p>
            這個環節目前由匯入的檔案控制（{Object.keys(unlocking.locked.files).join('、')}，{unlocking.locked.imported_by} 於 {formatTime(unlocking.locked.imported_at)} 匯入）。
          </p>
          <p>改回介面設定後：</p>
          <ul>
            <li>匯入的檔案會從平台刪除，不能復原。需要保留請先下載。</li>
            <li>這個環節的設定回到匯入前最後一次用介面儲存的內容。</li>
            <li>其他環節會重新檢查。檢查不通過的環節會標示「需要處理」，處理完才能送出訓練。</li>
            <li>已完成的訓練紀錄與模型不受影響。</li>
          </ul>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
