import { useState, type FormEvent } from 'react';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { formatTime } from '../../components/format';
import { useProjectAccess } from '../data/access';
import { useDataset } from './DatasetLayout';
import { StepsEditor, stepSummary } from './StepsEditor';
import type { TargetFeature } from './types';

/** TC-B04-03 Target 與 Feature：儲存後以伺服器回傳的設定為準；需要 Training 權限才能儲存。 */
export function TargetFeatureTab() {
  const { api } = useSession();
  const { can, missing } = useProjectAccess();
  const { dataset, base, catalogue, steps, setSteps, saved, setSaved } = useDataset();
  const writable = can('training');
  const [target, setTarget] = useState(saved?.config.target ?? '');
  const [features, setFeatures] = useState<string[]>(saved?.config.features ?? []);
  const [extra, setExtra] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const names = dataset.columns.map((c) => c.name);
  // 已儲存的設定可能含前處理產生的欄位（例如 One-Hot 後的 sex_M），不在原始欄位清單內
  const derived = [...new Set([saved?.config.target, ...(saved?.config.features ?? [])].filter((c): c is string => !!c && !names.includes(c)))];
  const options = [...names, ...derived];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const typed = extra.split(/[,，\s]+/).filter(Boolean);
    try {
      const tf = await api.put<TargetFeature>(`${base}/target-feature`, {
        target,
        features: [...new Set([...features, ...typed])].filter((f) => f !== target),
        steps,
      });
      setSaved(tf);
      setTarget(tf.config.target);
      setFeatures(tf.config.features);
      setSteps(tf.config.steps);
      setExtra('');
      setNotice(`已儲存：Target ${tf.config.target}，${tf.config.features.length} 個 Feature，${tf.config.steps.length} 個前處理步驟`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card" aria-labelledby="tf-current">
        <h3 id="tf-current">已儲存的設定</h3>
        {saved ? (
          <dl className="kv">
            <dt>Target</dt>
            <dd data-testid="saved-target">{saved.config.target}</dd>
            <dt>Feature</dt>
            <dd data-testid="saved-features">{saved.config.features.join('、')}</dd>
            <dt>前處理步驟</dt>
            <dd data-testid="saved-steps">
              {saved.config.steps.length ? saved.config.steps.map((s) => stepSummary(s, catalogue)).join(' → ') : '無'}
            </dd>
            <dt>最後儲存</dt>
            <dd>
              {saved.updated_by}，{formatTime(saved.updated_at)}
            </dd>
          </dl>
        ) : (
          <p>這個資料集尚未設定 Target 與 Feature。</p>
        )}
      </section>

      {notice && <Alert tone="success">{notice}</Alert>}
      {writable && <StepsEditor catalogue={catalogue} columns={dataset.columns} steps={steps} onChange={setSteps} />}
      {writable ? (
        <form aria-label="設定 Target 與 Feature" className="card section" onSubmit={submit} noValidate>
          <h3>設定</h3>
          <ApiErrorAlert error={error} />
          <div className="field">
            <label htmlFor="tf-target">Target（目標欄位）</label>
            <select
              id="tf-target"
              className="select"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setFeatures((f) => f.filter((x) => x !== e.target.value));
              }}
            >
              <option value="">請選擇</option>
              {options.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <fieldset>
            <legend>Feature（特徵欄位）</legend>
            <div className="col-picker">
              {options
                .filter((c) => c !== target)
                .map((c) => (
                  <label key={c} className="checkbox">
                    <input
                      type="checkbox"
                      checked={features.includes(c)}
                      onChange={(e) => setFeatures(e.target.checked ? [...features, c] : features.filter((f) => f !== c))}
                    />
                    {c}
                  </label>
                ))}
            </div>
            <div className="field">
              <label htmlFor="tf-extra">其他 Feature（前處理產生的新欄位，以逗號分隔）</label>
              <input id="tf-extra" className="input" value={extra} onChange={(e) => setExtra(e.target.value)} />
            </div>
          </fieldset>
          <p className="text-muted">
            會一起儲存的前處理步驟：{steps.length ? steps.map((s) => stepSummary(s, catalogue)).join(' → ') : '無'}
          </p>
          <div className="row-actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              儲存設定
            </button>
          </div>
        </form>
      ) : (
        <Alert tone="warning" title="沒有權限">
          {missing('training', '儲存 Target 與 Feature 設定')}
        </Alert>
      )}
    </>
  );
}
