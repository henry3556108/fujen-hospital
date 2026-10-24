import { useState, type FormEvent } from 'react';
import { withQuery } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useSession } from '../../auth/SessionContext';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { formatTime } from '../../components/format';
import { Badge, SidePanel, SplitLayout } from '../../components/ui';
import { useProjectAccess } from '../data/access';
import {
  collapseFeatures,
  encode,
  encodedColumns,
  expandFeatures,
  facts,
  featureCountText,
  hints,
  isIdentifier,
  isTextual,
  missingText,
  typeLabel,
  unencode,
} from './columnOverview';
import { DataTable } from './DataTable';
import { useDataset } from './DatasetLayout';
import { MissingChoiceField } from './MissingChoiceField';
import { StepsEditor, stepSummary } from './StepsEditor';
import { KIND_LABELS, type CatalogueItem, type Describe, type MissingChoice, type PipelinePreview, type Preview, type Step, type TargetFeature } from './types';

const PREVIEW_ROWS = 10;

/** 欄位的「處理方式」：套用到這一欄的整理步驟；沒有步驟但有缺值時說明缺值怎麼處理。 */
export function handlingText(name: string, missingCount: number, used: boolean, steps: Step[], catalogue: CatalogueItem[], missing: MissingChoice): string {
  const mine = steps.filter((s) => s.columns.includes(name)).map((s) => catalogue.find((c) => c.id === s.id)?.name_zh ?? s.id);
  if (mine.length) return mine.join(' → ');
  if (used && missingCount > 0) return missing === 'impute' ? '自動補缺值' : '有缺值的列不使用';
  return '不需處理';
}

/** 一份預覽裡的缺值格數 */
const nullCells = (p: Preview) => p.rows.reduce((n, r) => n + r.filter((v) => v === null).length, 0);

/** 處理前後比較（A05 下方）：左右並排，處理前的缺值標橘、處理後補上的值標綠。 */
function Compare({ before, after, steps }: { before: Preview; after: PipelinePreview; steps: number }) {
  const was = (row: number, column: string) => {
    const j = before.columns.indexOf(column);
    return j < 0 ? undefined : before.rows[row]?.[j];
  };
  const beforeGaps = nullCells(before);
  const afterGaps = nullCells(after.preview);
  return (
    <section className="section" aria-label="處理前後預覽">
      <p role="status">
        套用 {steps} 個步驟後：{after.row_count} 列、{after.columns.length} 欄，缺值合計 {after.columns.reduce((a, c) => a + c.missing, 0)} 筆
      </p>
      <div className="rd-compare">
        <div>
          <h4>
            處理前 {beforeGaps > 0 ? <Badge tone="warning">有缺值</Badge> : <Badge tone="neutral">沒有缺值</Badge>}
          </h4>
          <DataTable label="處理前的資料" preview={before} cellClass={(_, __, v) => (v === null ? 'rd-cell--missing' : undefined)} />
        </div>
        <span className="rd-compare__arrow" aria-hidden="true">
          →
        </span>
        <div>
          <h4>
            處理後 {afterGaps === 0 ? <Badge tone="success">{beforeGaps > 0 ? '已補齊' : '沒有缺值'}</Badge> : <Badge tone="warning">仍有缺值</Badge>}
          </h4>
          <DataTable
            label="處理後的資料"
            preview={after.preview}
            cellClass={(row, column, v) => (v === null ? 'rd-cell--missing' : was(row, column) === null ? 'rd-cell--filled' : undefined)}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * 整理資料（A05；TC-B04-03、04、06）：想預測哪個欄位、用哪些欄位預測、逐欄處理方式、右側整理步驟（可就地修改）與處理前後比較，
 * 在本頁「儲存整理步驟」一次存下；需要 Training 權限才能儲存，沒有時唯讀。
 */
export function PrepareTab() {
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
  const [compare, setCompare] = useState<{ before: Preview; after: PipelinePreview } | null>(null);
  const [compareError, setCompareError] = useState<unknown>(null);
  const [comparing, setComparing] = useState(false);
  const [request, setRequest] = useState<{ column: string; key: number } | null>(null);

  const categories = [...new Map(catalogue.map((c) => [c.category, c.category_zh])).entries()];
  const table = facts(dataset.columns, dataset.valid_rows, dataset.schema.columns, describe.data?.columns ?? []);
  const encoded = encodedColumns(steps);
  const unencodedText = table.filter((f) => features.includes(f.name) && isTextual(f) && !encoded.has(f.name));
  const gaps = table.filter((f) => features.includes(f.name) && f.missing > 0).map((f) => ({ name: f.name, missing: f.missing }));

  function changeSteps(next: Step[]) {
    setSteps(next);
    setCompare(null);
  }

  function toggleEncoding(name: string, on: boolean) {
    const f = table.find((x) => x.name === name)!;
    changeSteps(on ? encode(steps, name, f.kind === 'numeric') : unencode(steps, name));
  }

  function chooseTarget(name: string) {
    setTarget(name);
    setFeatures((fs) => fs.filter((x) => x !== name));
    if (encoded.has(name)) changeSteps(unencode(steps, name)); // 想預測的欄位不拆成 0／1 欄位
  }

  /** 「全部勾選」：除了想預測的欄位與識別碼（每列都不同）以外都拿來預測。 */
  function selectAll() {
    setFeatures(table.filter((f) => f.name !== target && !isIdentifier(f)).map((f) => f.name));
  }

  async function runCompare() {
    setComparing(true);
    setCompareError(null);
    try {
      const [before, after] = await Promise.all([
        api.get<Preview>(withQuery(`${base}/preview`, { offset: 0, limit: PREVIEW_ROWS })),
        api.post<PipelinePreview>(`${base}/preprocess/preview`, { steps, offset: 0, limit: PREVIEW_ROWS }),
      ]);
      setCompare({ before, after });
    } catch (e) {
      setCompareError(e);
      setCompare(null);
    } finally {
      setComparing(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const typed = extra.split(/[,，\s]+/).filter(Boolean);
    try {
      // One-Hot 等步驟會把原欄位換成新欄位：以整理後的欄位為準，用來預測的欄位跟著換
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
      setNotice(savedSummary(tf, names, catalogue));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const side = (
    <SidePanel title="整理步驟" sticky={false}>
      <StepsEditor catalogue={catalogue} columns={dataset.columns} steps={steps} onChange={changeSteps} readOnly={!writable} request={request} />
      <details>
        <summary data-testid="method-count">
          全部整理方法：共 {catalogue.length} 種（
          {categories.map(([id, label]) => `${label} ${catalogue.filter((c) => c.category === id).length} 種`).join('、')}）
        </summary>
        <div className="table-wrap">
          <table aria-label="整理方法清單">
            <thead>
              <tr>
                <th scope="col">方法</th>
                <th scope="col">代號</th>
                <th scope="col">分類</th>
                <th scope="col">適用欄位類型</th>
              </tr>
            </thead>
            <tbody>
              {catalogue.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.name_zh}</th>
                  <td className="mono">{c.id}</td>
                  <td>{c.category_zh}</td>
                  <td>{c.column_types.map((t) => (t === 'any' ? '全部' : (KIND_LABELS[t] ?? t))).join('、')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </SidePanel>
  );

  return (
    <>
      {notice && <Alert tone="success">{notice}</Alert>}
      {!writable && (
        <Alert tone="warning" title="只能查看">
          {missing('training', '儲存整理步驟')}
        </Alert>
      )}
      <SplitLayout side={side} sideWidth="21rem">
        {writable ? (
          <form id="prepare-form" aria-label="整理資料" className="card" onSubmit={submit} noValidate>
            <ApiErrorAlert error={error} />
            <ApiErrorAlert error={describe.error} />
            <div className="form-grid">
              <div className="field">
                <label htmlFor="prep-target">想預測哪個欄位？</label>
                <select id="prep-target" className="select" value={target} onChange={(e) => chooseTarget(e.target.value)}>
                  <option value="">請選擇</option>
                  {names.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <p className="field__hint">模型要學會猜的結果，例如是否確診（專業名稱：Target）。只能選一個。</p>
              </div>
              <div className="field">
                <strong id="prep-features-label">用哪些欄位預測？</strong>
                <p data-testid="chosen-features">
                  {features.length ? `${features.length} 個：${features.join('、')}` : '尚未選擇，請在下表「用來預測」勾選'}
                </p>
                <p className="field__hint">模型拿來猜的資料，例如年齡、血壓（專業名稱：Feature）。</p>
                <div className="row-actions">
                  <button type="button" className="btn btn--ghost btn--small" onClick={selectAll}>
                    全部勾選（不含識別碼）
                  </button>
                  <button type="button" className="btn btn--ghost btn--small" onClick={() => setFeatures([])}>
                    全部取消
                  </button>
                </div>
              </div>
            </div>
            {unencodedText.length > 0 && (
              <Alert tone="warning" title="有欄位還不能用來建立模型">
                <p>{unencodedText.map((f) => f.name).join('、')} 是文字或類別，需要先拆成 0／1 欄位（One-Hot 編碼）。</p>
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  onClick={() => changeSteps(unencodedText.reduce((s, f) => encode(s, f.name, false), steps))}
                >
                  全部拆成 0／1 欄位
                </button>
              </Alert>
            )}
            <div className="table-wrap">
              <table aria-label="欄位整理" className="rd-prep-table">
                <thead>
                  <tr>
                    <th scope="col">欄位名稱</th>
                    <th scope="col">型態</th>
                    <th scope="col" className="num">
                      缺值數
                    </th>
                    <th scope="col" className="num">
                      不同值
                    </th>
                    <th scope="col">想預測</th>
                    <th scope="col">用來預測</th>
                    <th scope="col">當作類別</th>
                    <th scope="col">處理方式</th>
                    <th scope="col">提示</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((f) => {
                    const role = f.name === target ? 'target' : features.includes(f.name) ? 'feature' : 'none';
                    const isOn = encoded.has(f.name);
                    const handling = handlingText(f.name, f.missing, role === 'feature', steps, catalogue, missingChoice);
                    return (
                      <tr key={f.name}>
                        <th scope="row">{f.name}</th>
                        <td>{typeLabel(f)}</td>
                        <td className={`num${f.missing > 0 ? ' rd-num--warning' : ''}`}>{f.missing}</td>
                        <td className="num">{f.unique}</td>
                        <td>
                          <input type="radio" name="prep-target" aria-label={`想預測 ${f.name}`} checked={f.name === target} onChange={() => chooseTarget(f.name)} />
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
                        <td data-testid={`handling-${f.name}`}>
                          <Badge tone={handling === '不需處理' ? 'neutral' : 'warning'}>{handling}</Badge>
                        </td>
                        <td>
                          {hints(f, role, isOn).map((h) => (
                            <div key={h.text} className={`column-hint${h.warn ? ' column-hint--warn' : ''}`}>
                              {h.warn ? '⚠ ' : ''}
                              {h.text}
                            </div>
                          ))}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn--ghost btn--small"
                            aria-label={`替 ${f.name} 加整理步驟`}
                            onClick={() => setRequest((r) => ({ column: f.name, key: (r?.key ?? 0) + 1 }))}
                          >
                            加步驟
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <MissingChoiceField id="prep" columns={gaps} value={missingChoice} onChange={setMissing} />
            <details>
              <summary>進階：其他用來預測的欄位</summary>
              <div className="field">
                <label htmlFor="prep-extra">其他欄位（整理步驟產生的新欄位，以逗號分隔）</label>
                <input id="prep-extra" className="input" value={extra} onChange={(e) => setExtra(e.target.value)} />
              </div>
            </details>
          </form>
        ) : null}

        <section className="card" aria-labelledby="prep-compare">
          <h3 id="prep-compare">資料預覽：處理前後比較</h3>
          <p className="text-muted">按下方「預覽處理結果」看前 {PREVIEW_ROWS} 列套用整理步驟後的樣子，不會改動原始資料。</p>
          <ApiErrorAlert error={compareError} />
          {compare && <Compare before={compare.before} after={compare.after} steps={steps.length} />}
          <div className="rd-bottom-bar">
            {writable && <span className="text-muted">想預測的欄位、用來預測的欄位、缺值處理與整理步驟會一起儲存。</span>}
            <button type="button" className="btn btn--secondary" onClick={() => void runCompare()} disabled={comparing}>
              {comparing ? '處理中…' : '預覽處理結果'}
            </button>
            {writable && (
              <button type="submit" form="prepare-form" className="btn btn--primary" disabled={busy}>
                {busy ? '儲存中…' : '儲存整理步驟'}
              </button>
            )}
          </div>
        </section>

        <section className="card" aria-labelledby="prep-saved">
          <h3 id="prep-saved">已儲存的整理設定</h3>
          {saved ? (
            <dl className="kv">
              <dt>想預測的欄位</dt>
              <dd data-testid="saved-target">{saved.config.target}</dd>
              <dt>用來預測的欄位</dt>
              <dd>
                <span data-testid="saved-features">{saved.config.features.join('、')}</span>
                <span className="field__hint" data-testid="saved-feature-count">
                  {' '}（{featureCountText(saved.config.features, names, saved.config.steps)}）
                </span>
              </dd>
              {saved.config.missing ? (
                <>
                  <dt>有缺值的病人</dt>
                  <dd data-testid="saved-missing">{saved.config.missing === 'impute' ? '補上缺值後使用' : '不使用'}</dd>
                </>
              ) : null}
              <dt>整理步驟</dt>
              <dd data-testid="saved-steps">
                {saved.config.steps.length ? saved.config.steps.map((s) => stepSummary(s, catalogue)).join(' → ') : '無'}
              </dd>
              <dt>最後儲存</dt>
              <dd>
                {saved.updated_by}，{formatTime(saved.updated_at)}
              </dd>
            </dl>
          ) : (
            <p>這個資料集還沒有儲存整理設定。</p>
          )}
        </section>
      </SplitLayout>
    </>
  );
}

/** 儲存後的一句話：數目以使用者勾的欄位計，並列出缺值處理與整理步驟（讓人確定都存了）。 */
export function savedSummary(tf: TargetFeature, original: string[], catalogue: CatalogueItem[]): string {
  const c = tf.config;
  const parts = [`要預測的結果 ${c.target}`, `用來預測的資料 ${featureCountText(c.features, original, c.steps)}`];
  if (missingText(c.missing)) parts.push(missingText(c.missing));
  parts.push(c.steps.length ? `前處理 ${c.steps.length} 個步驟（${c.steps.map((s) => stepSummary(s, catalogue)).join(' → ')}）` : '沒有前處理步驟');
  return `已儲存：${parts.join('；')}`;
}
