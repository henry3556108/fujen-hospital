// 自動影像分類標註（B-03）：把影像送給自動標註服務，結果回存後可到標註工作台開啟修正。
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../../api/useResource';
import { Alert, ApiErrorAlert } from '../../components/Alert';
import { useLabelingApi, type LabelingApi } from './api';
import type { InstanceInfo } from './dicomweb';
import { formatDate } from './parts';
import { KIND_LABELS, type Annotation, type AutolabelRun } from './types';
import { LabelingNav } from './LabelingNav';
import './labeling.css';

export function AutoLabelPage() {
  const labeling = useLabelingApi();
  if (!labeling) {
    return (
      <>
        <h1>影像標註</h1>
        <Alert tone="info">你尚未加入任何專案，請聯絡管理者將你加入專案。</Alert>
      </>
    );
  }
  return <AutoLabel key={labeling.projectId} labeling={labeling} />;
}

function AutoLabel({ labeling }: { labeling: LabelingApi }) {
  const models = useResource(() => labeling.models(), [labeling]);
  const summary = useResource(() => labeling.summary(), [labeling]);
  const runs = useResource(() => labeling.runs(), [labeling]);
  const [model, setModel] = useState('');
  const [studyUid, setStudyUid] = useState('');
  const [images, setImages] = useState<InstanceInfo[]>([]);
  const [sop, setSop] = useState('');
  const [imageError, setImageError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [last, setLast] = useState<{ run: AutolabelRun; annotation: Annotation } | null>(null);

  const study = studyUid || summary.data?.studies[0]?.study_instance_uid || '';
  const chosenModel = model || models.data?.[0]?.name || '';

  useEffect(() => {
    if (!study) return;
    let cancelled = false;
    setImages([]);
    setSop('');
    setImageError(null);
    (async () => {
      const series = await labeling.dicomweb.series(study);
      const list = series[0] ? await labeling.dicomweb.instances(study, series[0].seriesInstanceUid) : [];
      if (!cancelled) {
        setImages(list);
        setSop(list[0]?.sopInstanceUid ?? '');
      }
    })().catch((e: unknown) => !cancelled && setImageError(e));
    return () => {
      cancelled = true;
    };
  }, [labeling, study]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!chosenModel || !study || !sop) return;
    setBusy(true);
    setError(null);
    setLast(null);
    try {
      setLast(await labeling.autolabel(chosenModel, study, sop));
      runs.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>影像標註</h1>
      <LabelingNav />
      <h2>自動標註</h2>
      <p className="text-muted">把影像送給自動標註服務，結果以「待確認」的草稿存回平台，並列入待處理清單。草稿要有人在標註工作台確認或修正後，才會用在訓練。</p>
      <ApiErrorAlert error={models.error ?? summary.error} />
      {imageError ? (
        <Alert tone="error" title="無法載入影像">
          {imageError instanceof Error ? imageError.message : '影像服務沒有回應'}
        </Alert>
      ) : null}

      <form className="card section" aria-label="送出自動標註" onSubmit={submit}>
        <h2>送出自動標註</h2>
        <ApiErrorAlert error={error} />
        <div className="form-grid">
          <div className="field">
            <label htmlFor="auto-model">模型</label>
            <select id="auto-model" className="select" value={chosenModel} onChange={(e) => setModel(e.target.value)} disabled={!models.data?.length}>
              {(models.data ?? []).map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}（{KIND_LABELS[m.type]}：{m.labels.join('、')}）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="auto-study">研究</label>
            <select id="auto-study" className="select" value={study} onChange={(e) => setStudyUid(e.target.value)}>
              {(summary.data?.studies ?? []).map((s) => (
                <option key={s.study_instance_uid} value={s.study_instance_uid}>
                  {s.accession_number || s.study_instance_uid}　{formatDate(s.study_date)}　{s.study_description}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="auto-image">影像</label>
            <select id="auto-image" className="select" value={sop} onChange={(e) => setSop(e.target.value)} disabled={images.length === 0}>
              {images.map((i, n) => (
                <option key={i.sopInstanceUid} value={i.sopInstanceUid}>
                  第 {n + 1} 張
                </option>
              ))}
            </select>
          </div>
        </div>
        <button type="submit" className="btn btn--primary" disabled={busy || !chosenModel || !sop}>
          {busy ? '標註中…' : '送出自動標註'}
        </button>
      </form>

      {last ? (
        <div data-testid="autolabel-result">
          <Alert tone="success">
            自動標註完成：已存為{KIND_LABELS[last.annotation.kind]}標註 #{last.annotation.id}（耗時 {last.run.duration_ms} 毫秒）。
            <Link to={`/labeling/studies/${last.annotation.study_instance_uid}?annotation=${last.annotation.id}`}>在標註工作台開啟編輯</Link>
          </Alert>
        </div>
      ) : null}

      <section className="section" aria-labelledby="runs-title">
        <h2 id="runs-title">執行紀錄</h2>
        <ApiErrorAlert error={runs.error} />
        {runs.data && runs.data.length === 0 ? (
          <p className="text-muted">還沒有自動標註紀錄。</p>
        ) : runs.data ? (
          <div className="table-wrap">
            <table aria-label="自動標註執行紀錄">
              <thead>
                <tr>
                  <th scope="col">編號</th>
                  <th scope="col">模型</th>
                  <th scope="col">種類</th>
                  <th scope="col">送出者</th>
                  <th scope="col">時間</th>
                  <th scope="col">耗時</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id} data-run={r.id}>
                    <th scope="row">#{r.id}</th>
                    <td>{r.model}</td>
                    <td>{KIND_LABELS[r.model_type]}</td>
                    <td>{r.created_by}</td>
                    <td>{r.created_at.replace('T', ' ').replace(/(\.\d+)?Z$/, ' UTC')}</td>
                    <td>{r.duration_ms} 毫秒</td>
                    <td>
                      <Link to={`/labeling/studies/${r.study_instance_uid}?annotation=${r.annotation_id}`} aria-label={`開啟自動標註 #${r.id} 的結果`}>
                        開啟編輯
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}
