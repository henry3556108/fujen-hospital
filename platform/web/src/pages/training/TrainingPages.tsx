// 建立模型的各頁：訓練紀錄（首頁）、單次訓練（/training/runs/:runId）、程式與專案包（/training/code，需要 Coding）。
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { useTrainingApi, type TrainingRun, type TrainingSetting } from './api';
import { useHasPermission } from './ModelExport';
import { PackageImport, mappingText } from './PackageImport';
import { POLL_MS, RunDetail, Runs, queuePositions, unfinished } from './Runs';
import { StagesPanel } from './StagesPanel';
import { stageNames } from './stages';
import { LegacyDatasetRedirect, submittedNotice } from './TrainingPage';

/** 訓練紀錄（建立模型首頁）。測試工作表單已搬到系統管理 › 運算資源。 */
export function TrainingHome() {
  const api = useTrainingApi();
  if (!api) return null;
  return (
    <LegacyDatasetRedirect>
      <Runs key={api.projectId} api={api} />
    </LegacyDatasetRedirect>
  );
}

/** 單次訓練：狀態、排隊位置、取消、日誌；完成後結果與「前往使用模型」；依原版本重跑；另存設定。 */
export function RunPage() {
  const api = useTrainingApi();
  const { runId } = useParams();
  const id = Number(runId);
  const navigate = useNavigate();
  const location = useLocation();
  const submitted = (location.state as { submitted?: string } | null)?.submitted;
  // 讀整個訓練清單：同一次查詢就能算出排隊位置
  const runs = useResource(() => (api ? api.runs() : Promise.resolve([] as TrainingRun[])), [api, id]);
  const run = { data: runs.data?.find((r) => r.id === id) ?? null, error: runs.error };
  const settings = useResource(() => (api ? api.settings().catch(() => [] as TrainingSetting[]) : Promise.resolve([])), [api]);
  const { reload } = runs;
  const status = run.data?.status;
  useEffect(() => {
    if (!status || !unfinished(status) || status === 'held') return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [status, reload]);
  if (!api) return null;
  if (!Number.isInteger(id) || id <= 0) return <Alert tone="error">訓練編號不正確。</Alert>;
  return (
    <div className="stack">
      <p>
        <Link to="/training">← 回訓練紀錄</Link>{' '}
        <button type="button" className="btn btn--secondary btn--small" onClick={reload}>
          重新整理
        </button>
      </p>
      {submitted && run.data ? (
        <Alert tone={submittedNotice(run.data.id, submitted, run.data.status).tone}>{submittedNotice(run.data.id, submitted, run.data.status).text}</Alert>
      ) : null}
      <ApiErrorAlert error={run.error} />
      {run.data ? (
        <section className="card section">
          <RunDetail api={api} run={run.data} settings={settings.data ?? []} onChanged={reload}
            onSelect={(next) => navigate(`/training/runs/${next}`)} onSettingSaved={() => settings.reload()}
            position={queuePositions(runs.data ?? []).get(id)} />
        </section>
      ) : runs.data ? (
        <Alert tone="info">找不到訓練 #{runId}。<Link to="/training">回訓練紀錄</Link></Alert>
      ) : !runs.error ? (
        <p role="status">載入中…</p>
      ) : null}
    </div>
  );
}

/** 程式與專案包：選一份已存設定看流程程式碼（匯出、修改、匯入），以及匯入專案包。 */
export function CodePage() {
  const api = useTrainingApi();
  const canCode = useHasPermission('coding');
  const [params, setParams] = useSearchParams();
  const chosen = Number(params.get('setting')) || null;
  const settings = useResource(() => (api ? api.settings() : Promise.resolve([] as TrainingSetting[])), [api]);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState('');
  if (!api) return null;

  const setting = (settings.data ?? []).find((s) => s.id === chosen) ?? null;
  const choose = (id: number | null) => setParams(id ? { setting: String(id) } : {}, { replace: true });
  return (
    <div className="stack">
      <section className="card section stack" aria-labelledby="code-title">
        <div className="training-head">
          <h2 id="code-title">流程程式碼</h2>
          {canCode ? <button type="button" className="btn btn--secondary" onClick={() => { setNotice(''); setImporting(true); }}>
            匯入專案包
          </button> : null}
        </div>
        <p className="text-muted">
          每份已存設定都有一組流程程式碼（資料匯入、標註、前處理、訓練、部署）。可以匯出修改後再匯入，或匯出整個專案包到別的環境重現研究。
        </p>
        {notice ? <Alert tone="success">{notice}</Alert> : null}
        <ApiErrorAlert error={settings.error} />
        {settings.data && settings.data.length === 0 ? (
          <p className="text-muted">
            還沒有已存設定。先<Link to="/training/new">建立訓練</Link>，或匯入專案包。
          </p>
        ) : null}
        {settings.data && settings.data.length > 0 ? (
          <div className="field">
            <label htmlFor="code-setting">已存設定</label>
            <select id="code-setting" className="select" value={chosen ?? ''} onChange={(e) => choose(Number(e.target.value) || null)}>
              <option value="">請選擇</option>
              {settings.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </section>
      {!canCode ? <Alert tone="info">修改程式與匯入專案包需要 Coding 權限；沒有時仍可查看各環節由誰控制，並改回用介面設定。</Alert> : null}
      {importing ? (
        <PackageImport api={api} onClose={() => setImporting(false)}
          onImported={(out) => {
            setImporting(false);
            setNotice(`已匯入專案包，建立訓練設定「${out.setting.name}」。${mappingText(out.mapping)}` +
              (out.locked.length ? `由匯入檔控制的環節：${stageNames(out.locked)}。` : '') +
              (out.problem ? `需要處理：${out.problem}` : '可以送出訓練。'));
            settings.reload();
            choose(out.setting.id);
          }} />
      ) : null}
      {setting ? (
        <StagesPanel key={setting.id} api={api} setting={setting} onClose={() => choose(null)} onChanged={() => settings.reload()} />
      ) : null}
    </div>
  );
}
