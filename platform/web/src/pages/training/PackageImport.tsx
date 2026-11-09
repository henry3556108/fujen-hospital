// 各階段處理程式碼（錄製巨集）第二階段：匯入整個流程（專案包），建立新的訓練設定。
// 步驟：選檔 → 檢查（列出全部問題）→ 對應資料（結構式選資料集；影像選研究範圍）→ 匯入。
import { useState } from 'react';
import { Alert } from '../../components/Alert';
import { isImageKind, type PackageChoice, type PackageImported, type PackageMapping, type PackagePlan, type TrainingApi } from './api';
import { StageErrors } from './StagesPanel';
import { stageNames } from './stages';

interface Props {
  api: TrainingApi;
  onImported: (out: PackageImported) => void;
  onClose: () => void;
}

/** 資料對應的說明（已對應好時） */
export function mappingText(m: PackageMapping | undefined): string {
  if (!m) return '';
  switch (m.mode) {
    case 'package':
      if (m.dataset_name) return `已用專案包內附的資料建立資料集「${m.dataset_name}」。`;
      return `會用專案包內附的資料${m.rows != null ? `（${m.rows} 列）` : ''}建立一個新的資料集。`;
    case 'matched':
      return `本專案已有內容相同的資料集「${m.dataset_name ?? m.dataset_id}」，會使用它。`;
    case 'chosen':
      return `會使用你選的資料集「${m.dataset_name ?? m.dataset_id}」。`;
    case 'version':
      return `本專案已有內容相同的影像資料版本（#${m.version_id}），會使用它的影像範圍。`;
    case 'studies': {
      const src = m.source ?? {};
      if (src.type === 'files') return src.cases === 'all' ? '影像範圍：全部病例。' : `影像範圍：${(src.cases as string[]).length} 個病例。`;
      return src.studies === 'all' ? '影像範圍：本專案全部影像。' : `影像範圍：${(src.studies as string[] | undefined)?.length ?? 0} 個研究。`;
    }
    default:
      return '';
  }
}

export function PackageImport({ api, onImported, onClose }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<PackagePlan | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [datasetId, setDatasetId] = useState('');
  const [studiesMode, setStudiesMode] = useState<'all' | 'selected'>('all');
  const [studiesText, setStudiesText] = useState('');
  // 上次檢查時送出的對應選擇。匯入時平台會用同樣的選擇再檢查一次，所以要原樣送回
  const [checked, setChecked] = useState<PackageChoice>({});
  const image = plan ? isImageKind(plan.kind) : false;
  const choosing = plan?.mapping?.mode === 'choose' || plan?.mapping?.mode === 'chosen';

  function choice(): PackageChoice {
    if (!plan || !choosing) return {};
    if (!image) return { datasetId: datasetId ? Number(datasetId) : null };
    if (studiesMode === 'all') return { studies: 'all' };
    return { studies: studiesText.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) };
  }

  async function check(with_: PackageChoice) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      setPlan(await api.packageCheck(file, with_));
      setChecked(with_);
    } catch (err) {
      setPlan(null);
      setChecked({});
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      onImported(await api.packageImport(file, checked));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const candidates = plan?.mapping?.candidates ?? [];
  const ok = plan && plan.errors.length === 0;
  return (
    <section className="card section stack" aria-labelledby="package-import-title">
      <div className="training-head">
        <h2 id="package-import-title">匯入整個流程（專案包）</h2>
        <button type="button" className="btn btn--secondary" onClick={onClose}>
          關閉匯入專案包
        </button>
      </div>
      <p className="field__hint">
        選擇從平台下載（或在自己電腦修改後）的專案包 zip。平台會先檢查，不符合時一次列出全部問題，不會建立任何東西；通過後選擇要對應的資料，再按「匯入」。
        匯入後會建立一份新的訓練設定，專案包內由匯入檔控制的階段在新設定同樣由匯入檔控制。模型與部署不隨專案包匯入。
      </p>
      <div className="field">
        <label htmlFor="package-file">專案包（zip）</label>
        <input id="package-file" type="file" accept=".zip,application/zip"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPlan(null); setChecked({}); setError(null); }} />
      </div>
      <div className="row-actions">
        <button type="button" className="btn btn--secondary" disabled={!file || busy} onClick={() => void check({})}>
          {busy && !plan ? '檢查中…' : '檢查專案包'}
        </button>
      </div>
      <StageErrors error={error} />

      {plan ? (
        <div className="stack" role="group" aria-label="檢查結果">
          {plan.errors.length ? (
            <Alert tone="error" title="專案包不符合平台的流程框架，不能匯入">
              <ul className="alert__list" aria-label="錯誤清單">
                {plan.errors.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {plan.warnings.length ? (
            <Alert tone="warning" title="請注意">
              <ul className="alert__list" aria-label="注意事項">
                {plan.warnings.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <dl className="kv" aria-label="專案包內容">
            <dt>名稱</dt>
            <dd>{plan.name}</dd>
            <dt>訓練種類</dt>
            <dd>{plan.kind_name}</dd>
            <dt>由匯入檔控制的階段</dt>
            <dd>{plan.locked.length ? stageNames(plan.locked) : '無（全部用介面設定）'}</dd>
          </dl>

          {plan.mapping && plan.mapping.mode !== 'choose' ? <p data-testid="package-mapping">{mappingText(plan.mapping)}</p> : null}
          {choosing && !image ? (
            <div className="field">
              <label htmlFor="package-dataset">要使用的資料集</label>
              <select id="package-dataset" className="select" value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
                <option value="">請選擇</option>
                {candidates.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}{d.valid_rows != null ? `（${d.valid_rows} 列）` : ''}
                  </option>
                ))}
              </select>
              <span className="field__hint">專案包沒有附資料，本專案也沒有內容完全相同的資料集。請選一個欄位相同的資料集，平台會再檢查一次。</span>
            </div>
          ) : null}
          {choosing && image ? (
            <div className="stack">
              <div className="checkbox-row" role="radiogroup" aria-label="要使用的影像範圍">
                <label className="checkbox">
                  <input type="radio" name="package-range" checked={studiesMode === 'all'} onChange={() => setStudiesMode('all')} />
                  本專案全部影像{plan.mapping?.studies_available != null ? `（${plan.mapping.studies_available} 個）` : ''}
                </label>
                <label className="checkbox">
                  <input type="radio" name="package-range" checked={studiesMode === 'selected'} onChange={() => setStudiesMode('selected')} />
                  部分影像
                </label>
              </div>
              {studiesMode === 'selected' ? (
                <div className="field">
                  <label htmlFor="package-studies">研究 UID（每行一個）</label>
                  <textarea id="package-studies" className="input" rows={4} value={studiesText} onChange={(e) => setStudiesText(e.target.value)} />
                </div>
              ) : null}
              <span className="field__hint">專案包內的研究編號已去識別，平台找不到內容相同的影像資料版本。請選擇要用本專案的哪些研究。</span>
            </div>
          ) : null}
          {choosing ? (
            <div className="row-actions">
              <button type="button" className="btn btn--secondary" disabled={busy || (!image && !datasetId)} onClick={() => void check(choice())}>
                用這個資料重新檢查
              </button>
            </div>
          ) : null}

          <div className="row-actions">
            <button type="button" className="btn btn--primary" disabled={busy || !ok || !plan.ready} onClick={() => void doImport()}>
              {busy && plan ? '處理中…' : `匯入「${plan.name}」`}
            </button>
            {ok && !plan.ready ? <span className="field__hint">請先選擇要對應的資料並重新檢查。</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
