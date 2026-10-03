import { useState, type FormEvent } from 'react';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { formatTime } from '../../components/format';
import { useProjectAccess } from '../data/access';
import { collapseFeatures, encode, encodedColumns, expandFeatures, facts, hints, isTextual, typeLabel, unencode } from './columnOverview';
import { useDataset } from './DatasetLayout';
import { StepsEditor, stepSummary } from './StepsEditor';
import { MissingChoiceField } from './MissingChoiceField';
import type { Describe, MissingChoice, PipelinePreview, TargetFeature } from './types';

/** TC-B04-03 Target 與 Feature：欄位總覽表上選 Target（單選）與 Feature（勾選）；需要 Training 權限才能儲存。 */
export function TargetFeatureTab() {
  const { api } = useSession();
  const { can, missing } = useProjectAccess();
  const { dataset, base, catalogue, steps, setSteps, saved, setSaved } = useDataset();
  const writable = can('training');
  const describe = useResource(() => api.get<Describe>(`${base}/describe`), [base]);
  const names = dataset.columns.map((c) => c.name);
  // 已儲存的 Feature 對回原始欄位（sex_F、sex_M → sex），只在第一次顯示時還原
  const [initial] = useState(() => collapseFeatures(saved?.config.features ?? [], names, encodedColumns(saved?.config.steps ?? [])));
  const [target, setTarget] = useState(saved?.config.target ?? '');
  const [features, setFeatures] = useState<string[]>(initial.columns);
  const [extra, setExtra] = useState(initial.other.join(', '));
  const [missingChoice, setMissing] = useState<MissingChoice>(saved?.config.missing ?? 'impute');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const table = facts(dataset.columns, dataset.valid_rows, dataset.schema.columns, describe.data?.columns ?? []);
  const encoded = encodedColumns(steps);
  const unencodedText = table.filter((f) => features.includes(f.name) && isTextual(f) && !encoded.has(f.name));
  const gaps = table.filter((f) => features.includes(f.name) && f.missing > 0).map((f) => ({ name: f.name, missing: f.missing }));

  function toggleEncoding(name: string, on: boolean) {
    const f = table.find((x) => x.name === name)!;
    setSteps(on ? encode(steps, name, f.kind === 'numeric') : unencode(steps, name));
  }

  function chooseTarget(name: string) {
    setTarget(name);
    setFeatures((fs) => fs.filter((x) => x !== name));
    if (encoded.has(name)) setSteps(unencode(steps, name)); // Target 不做 One-Hot
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const typed = extra.split(/[,，\s]+/).filter(Boolean);
    try {
      // One-Hot 等步驟會把原欄位換成新欄位：以前處理後的欄位為準，Feature 跟著換
      let chosen = [...new Set([...features, ...typed])].filter((f) => f !== target);
      if (steps.length) {
        const after = await api.post<PipelinePreview>(`${base}/preprocess/preview`, { steps, offset: 0, limit: 1 });
        const expanded = expandFeatures(chosen, names, after.columns.map((c) => c.name));
        chosen = [...expanded.features, ...expanded.unresolved]; // 對不到的交給伺服器回清楚的錯誤
      }
      const tf = await api.put<TargetFeature>(`${base}/target-feature`, { target, features: chosen, steps, missing: missingChoice });
      setSaved(tf);
      setTarget(tf.config.target);
      setSteps(tf.config.steps);
      setMissing(tf.config.missing ?? 'impute');
      const back = collapseFeatures(tf.config.features, names, encodedColumns(tf.config.steps));
      setFeatures(back.columns);
      setExtra(back.other.join(', '));
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
            <dt>要預測的結果（Target）</dt>
            <dd data-testid="saved-target">{saved.config.target}</dd>
            <dt>用來預測的資料（Feature）</dt>
            <dd data-testid="saved-features">{saved.config.features.join('、')}</dd>
            {saved.config.missing ? (
              <>
                <dt>有缺值的病人</dt>
                <dd data-testid="saved-missing">{saved.config.missing === 'impute' ? '補上缺值後使用' : '不使用'}</dd>
              </>
            ) : null}
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
      {writable ? (
        <form aria-label="設定 Target 與 Feature" className="card section" onSubmit={submit} noValidate>
          <h3>欄位總覽與設定</h3>
          <ul className="text-muted">
            <li>
              <strong>要預測的結果（Target）</strong>：模型要學會猜的欄位（例如是否確診），只能選一個。
            </li>
            <li>
              <strong>用來預測的資料（Feature）</strong>：模型拿來猜的欄位（例如年齡、血壓），可選多個。
            </li>
            <li>
              <strong>當作類別</strong>：把類別拆成多個 0／1 欄位（One-Hot 編碼），模型才能使用文字或代碼欄位；例如性別 sex 變成 sex_F、sex_M。
            </li>
          </ul>
          <ApiErrorAlert error={error} />
          <ApiErrorAlert error={describe.error} />
          {unencodedText.length > 0 && (
            <Alert tone="warning" title="有 Feature 還不能用來訓練">
              <p>{unencodedText.map((f) => f.name).join('、')} 是文字或類別，需要先轉成 One-Hot（0／1 欄位）。</p>
              <button
                type="button"
                className="btn btn--secondary btn--small"
                onClick={() => setSteps(unencodedText.reduce((s, f) => encode(s, f.name, false), steps))}
              >
                全部轉成 One-Hot
              </button>
            </Alert>
          )}
          <div className="table-wrap">
            <table aria-label="欄位總覽">
              <thead>
                <tr>
                  <th scope="col">欄名</th>
                  <th scope="col">型態</th>
                  <th scope="col" className="num">
                    缺值
                  </th>
                  <th scope="col" className="num">
                    不同值
                  </th>
                  <th scope="col">要預測的結果（Target）</th>
                  <th scope="col">用來預測的資料（Feature）</th>
                  <th scope="col">當作類別</th>
                  <th scope="col">提示</th>
                </tr>
              </thead>
              <tbody>
                {table.map((f) => {
                  const role = f.name === target ? 'target' : features.includes(f.name) ? 'feature' : 'none';
                  const isOn = encoded.has(f.name);
                  return (
                    <tr key={f.name}>
                      <th scope="row">{f.name}</th>
                      <td>{typeLabel(f)}</td>
                      <td className="num">{f.missing}</td>
                      <td className="num">{f.unique}</td>
                      <td>
                        <input type="radio" name="tf-target" aria-label={`以 ${f.name} 為 Target`} checked={f.name === target} onChange={() => chooseTarget(f.name)} />
                      </td>
                      <td>
                        {f.name !== target && (
                          <input
                            type="checkbox"
                            aria-label={f.name}
                            checked={features.includes(f.name)}
                            onChange={(e) => setFeatures(e.target.checked ? [...features, f.name] : features.filter((x) => x !== f.name))}
                          />
                        )}
                      </td>
                      <td>
                        {f.name !== target && f.kind !== 'datetime' && f.kind !== 'boolean' && (
                          <input type="checkbox" role="switch" aria-label={`${f.name} 當作類別`} checked={isOn} onChange={(e) => toggleEncoding(f.name, e.target.checked)} />
                        )}
                      </td>
                      <td>
                        {hints(f, role, isOn).map((h) => (
                          <div key={h.text} className={`column-hint${h.warn ? ' column-hint--warn' : ''}`}>
                            {h.warn ? '⚠ ' : ''}
                            {h.text}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <MissingChoiceField id="tf" columns={gaps} value={missingChoice} onChange={setMissing} />
          <details>
            <summary>進階：其他 Feature</summary>
            <div className="field">
              <label htmlFor="tf-extra">其他 Feature（前處理產生的新欄位，以逗號分隔）</label>
              <input id="tf-extra" className="input" value={extra} onChange={(e) => setExtra(e.target.value)} />
            </div>
          </details>
          <p className="text-muted">
            會一起儲存的前處理步驟：{steps.length ? steps.map((s) => stepSummary(s, catalogue)).join(' → ') : '無'}。儲存時 Feature 會自動換成 One-Hot 產生的欄位。
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
      {writable && <StepsEditor catalogue={catalogue} columns={dataset.columns} steps={steps} onChange={setSteps} />}
    </>
  );
}
