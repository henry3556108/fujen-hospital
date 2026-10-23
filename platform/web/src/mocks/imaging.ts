// 模擬 platform/api 的影像 API（app/imaging）。上傳的 DICOM 會真的解析標頭（Explicit VR Little Endian）。
import { http } from 'msw';
import type { ImagingFile, ImportFileResult, ImportJob, ImportKind, PacsAnswer, PairedStudy, Scope, ScopeFilters, Study } from '../pages/imaging/types';
import { API, detail, isoNow, json, jsonBody, moduleState, requireProject, validation } from './support';

interface DicomInfo {
  sop: string;
  study: string;
  series: string;
  accession: string;
  patientId: string;
  sex: string;
  date: string;
  studyDescription: string;
  seriesDescription: string;
  modality: string;
}

interface StoredInstance extends DicomInfo {
  projectId: number;
  sourcePath: string;
}

interface StoredFile extends Omit<ImagingFile, 'paired_image' | 'paired_studies'> {
  projectId: number;
  digest: string;
  pairedFileId: number | null;
}

interface State {
  instances: StoredInstance[];
  files: StoredFile[];
  jobs: (ImportJob & { projectId: number; files: ImportFileResult[] })[];
  allowlists: Record<number, string[]>;
  pacs: DicomInfo[];
  /** 資料範圍（存篩選條件）；舊的持久化狀態可能沒有這欄 */
  scopes?: (Omit<Scope, 'study_count'> & { projectId: number })[];
  nextScopeId?: number;
  nextJobId: number;
  nextFileId: number;
}

const ROOT = '1.2.826.0.1.3680043.10.9999';

function synth(prefix: string, no: number, slices: number, meta: Omit<DicomInfo, 'sop' | 'study' | 'series' | 'accession' | 'patientId'>): DicomInfo[] {
  return Array.from({ length: slices }, (_, i) => ({
    sop: `${ROOT}.${prefix}.3.${no}.${i + 1}`,
    study: `${ROOT}.${prefix}.1.${no}`,
    series: `${ROOT}.${prefix}.2.${no}.1`,
    accession: `ACC${String(no).padStart(4, '0')}`,
    patientId: `PAT${String(no).padStart(4, '0')}`,
    ...meta,
  }));
}

const m = (modality: string, sex: string, date: string, studyDescription: string, seriesDescription: string) => ({
  modality,
  sex,
  date,
  studyDescription,
  seriesDescription,
});

function seed(): State {
  // P1-lung-ct 已有 6 個研究；模擬 PACS 另有 4 個（對應 platform/api 測試的合成研究）
  const indexed = [
    synth('88', 11, 4, m('CT', 'F', '20240105', 'CT CHEST WO CONTRAST', 'AXIAL 5MM SOFT TISSUE')),
    synth('88', 12, 3, m('CT', 'M', '20240212', 'CT CHEST W CONTRAST', 'AXIAL 1MM LUNG')),
    synth('88', 13, 5, m('MR', 'F', '20240303', 'MR BRAIN WWO CONTRAST', 'AX T1')),
    synth('88', 14, 2, m('MR', 'M', '20240418', 'MR KNEE WO CONTRAST', 'SAG PD FS')),
    synth('88', 15, 3, m('CT', 'M', '20240520', 'CT ABDOMEN PELVIS W CONTRAST', 'AXIAL 5MM SOFT TISSUE')),
    synth('88', 16, 4, m('CT', 'F', '20240611', 'CT CHEST LOW DOSE', 'AXIAL 1MM LUNG')),
  ].flat();
  const pacs = [
    synth('77', 1, 3, m('CT', 'F', '20240115', 'CT CHEST WO CONTRAST', 'AXIAL 5MM SOFT TISSUE')),
    synth('77', 2, 3, m('MR', 'M', '20240220', 'MR BRAIN WWO CONTRAST', 'AX T1')),
    synth('77', 3, 3, m('CT', 'M', '20240310', 'CT ABDOMEN PELVIS W CONTRAST', 'AXIAL 1MM LUNG')),
    synth('77', 4, 3, m('MR', 'F', '20240405', 'MR KNEE WO CONTRAST', 'AX T2 FLAIR')),
  ].flat();
  return {
    instances: indexed.map((d, i) => ({
      ...d,
      projectId: 1,
      sourcePath: `study_${d.accession.slice(3)}/series_001/IM${String(i + 1).padStart(4, '0')}.dcm`,
    })),
    files: [],
    jobs: [],
    allowlists: {},
    pacs,
    nextJobId: 1,
    nextFileId: 1,
  };
}

const state = () => moduleState('imaging', seed);

// ---------- 檔案解析 ----------

const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT']);
const TAGS: Record<string, keyof DicomInfo> = {
  '0008,0018': 'sop',
  '0008,0020': 'date',
  '0008,0050': 'accession',
  '0008,0060': 'modality',
  '0008,1030': 'studyDescription',
  '0008,103e': 'seriesDescription',
  '0010,0020': 'patientId',
  '0010,0040': 'sex',
  '0020,000d': 'study',
  '0020,000e': 'series',
};

class InvalidFile extends Error {}

/** 解析 DICOM Part 10 檔（Explicit VR Little Endian），只取索引需要的標籤。 */
export function parseDicom(bytes: Uint8Array): DicomInfo {
  if (bytes.length < 132 || String.fromCharCode(...bytes.slice(128, 132)) !== 'DICM') {
    throw new InvalidFile('不是 DICOM 檔案（缺少 DICM 檔頭或格式錯誤）');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Partial<DicomInfo> = {};
  let p = 132;
  while (p + 8 <= bytes.length) {
    const group = view.getUint16(p, true);
    const element = view.getUint16(p + 2, true);
    const vr = String.fromCharCode(bytes[p + 4], bytes[p + 5]);
    let length: number;
    let start: number;
    if (LONG_VR.has(vr)) {
      if (p + 12 > bytes.length) break;
      length = view.getUint32(p + 8, true);
      start = p + 12;
    } else {
      length = view.getUint16(p + 6, true);
      start = p + 8;
    }
    if (length === 0xffffffff) break; // 未定長度序列：索引標籤都在前面，不再往下
    if (start + length > bytes.length) {
      if (group === 0x7fe0) throw new InvalidFile('DICOM 檔案不完整（影像資料被截斷）');
      throw new InvalidFile('DICOM 檔案不完整（標頭被截斷）');
    }
    const key = `${group.toString(16).padStart(4, '0')},${element.toString(16).padStart(4, '0')}`;
    const field = TAGS[key];
    if (field) {
      out[field] = new TextDecoder().decode(bytes.slice(start, start + length)).replace(/[\0 ]+$/, '');
    }
    p = start + length;
  }
  for (const [field, label] of [
    ['sop', 'SOP Instance UID'],
    ['study', 'Study Instance UID'],
    ['series', 'Series Instance UID'],
  ] as const) {
    if (!out[field]) throw new InvalidFile(`DICOM 缺少 ${label}（檔案可能被截斷）`);
  }
  return {
    sop: out.sop!,
    study: out.study!,
    series: out.series!,
    accession: out.accession ?? '',
    patientId: out.patientId ?? '',
    sex: out.sex ?? '',
    date: out.date ?? '',
    studyDescription: out.studyDescription ?? '',
    seriesDescription: out.seriesDescription ?? '',
    modality: out.modality ?? '',
  };
}

const EXTENSIONS: [string, StoredFile['format']][] = [
  ['.nii.gz', 'nifti'],
  ['.nii', 'nifti'],
  ['.mha', 'itk'],
  ['.json', 'makesense'],
];

function parseOther(name: string, bytes: Uint8Array): Pick<StoredFile, 'format' | 'role' | 'case' | 'meta'> {
  const lower = name.toLowerCase();
  const hit = EXTENSIONS.find(([ext]) => lower.endsWith(ext));
  if (!hit) throw new InvalidFile('不支援的副檔名（可用 .nii、.nii.gz、.mha、makesense .json）');
  const [ext, format] = hit;
  const base = name.split('/').pop()!;
  const stem = base.slice(0, base.length - ext.length);
  if (format === 'makesense') {
    let doc: { images?: { file_name?: string }[]; annotations?: unknown[] };
    try {
      doc = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new InvalidFile('makesense 檔案不是有效的 JSON');
    }
    if (!Array.isArray(doc.images) || !Array.isArray(doc.annotations)) throw new InvalidFile('makesense 檔案缺少 images 或 annotations');
    if (doc.images.length === 0) throw new InvalidFile('makesense 檔案沒有任何 images');
    return {
      format,
      role: 'label',
      case: null,
      meta: { file_names: doc.images.map((i) => String(i.file_name ?? '')), annotations: doc.annotations.length },
    };
  }
  if (format === 'nifti') {
    const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (!gz && bytes.length < 348) throw new InvalidFile('NIfTI 標頭不完整');
    if (gz && bytes.length < 20) throw new InvalidFile('NIfTI 解壓縮失敗（檔案可能被截斷）');
  } else if (!new TextDecoder().decode(bytes.slice(0, 64)).includes('ObjectType')) {
    throw new InvalidFile('MetaImage 標頭錯誤（缺少 ObjectType）');
  }
  const suffix = /^(?<case>.+)[_-](?<role>image|img|label|seg|mask)$/i.exec(stem);
  const role = suffix ? (/^(image|img)$/i.test(suffix.groups!.role) ? 'image' : 'label') : 'image';
  return { format, role, case: suffix ? suffix.groups!.case : stem, meta: { dims: [4, 4, 2] } };
}

async function digest(bytes: Uint8Array): Promise<string> {
  let h = 2166136261;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
  return `${bytes.length}-${h.toString(16)}`;
}

// ---------- 索引與配對 ----------

function allowed(s: State, pid: number): Set<string> {
  return new Set(s.allowlists[pid] ?? []);
}

function studiesOf(s: State, pid: number): Study[] {
  const byStudy = new Map<string, StoredInstance[]>();
  for (const i of s.instances.filter((x) => x.projectId === pid)) {
    byStudy.set(i.study, [...(byStudy.get(i.study) ?? []), i]);
  }
  const studies = [...byStudy.values()].map((rows) => {
    const first = rows[0];
    const seriesIds = [...new Set(rows.map((r) => r.series))];
    const series = seriesIds.map((uid) => {
      const inSeries = rows.filter((r) => r.series === uid);
      return {
        series_instance_uid: uid,
        modality: inSeries[0].modality || null,
        series_description: inSeries[0].seriesDescription || null,
        instances: inSeries.length,
      };
    });
    return {
      study_instance_uid: first.study,
      accession_number: first.accession || null,
      patient_id: first.patientId || null,
      patient_sex: first.sex || null,
      study_date: first.date || null,
      study_description: first.studyDescription || null,
      modalities: [...new Set(series.map((x) => x.modality).filter((x): x is string => !!x))].sort(),
      series,
      instances: rows.length,
    };
  });
  const list = allowed(s, pid);
  return studies
    .filter((st) => list.size === 0 || (st.accession_number !== null && list.has(st.accession_number)))
    .sort((a, b) => (a.study_date ?? '').localeCompare(b.study_date ?? '') || a.study_instance_uid.localeCompare(b.study_instance_uid));
}

function resolvePairings(s: State, pid: number): void {
  const files = s.files.filter((f) => f.projectId === pid);
  for (const label of files.filter((f) => f.role === 'label' && f.pairing !== 'paired')) {
    if (label.format === 'makesense') {
      const names = (label.meta.file_names as string[]) ?? [];
      const matched: string[] = [];
      const missing: string[] = [];
      for (const name of names) {
        const hits = s.instances.filter((i) => i.projectId === pid && (i.sourcePath === name || i.sourcePath.endsWith(`/${name}`)));
        if (hits.length === 1) matched.push(hits[0].sop);
        else missing.push(name);
      }
      if (missing.length === 0 && matched.length > 0) {
        Object.assign(label, { paired_sop_instance_uids: matched, pairing: 'paired', pairing_note: '' });
      } else {
        label.pairing_note = missing.length ? `找不到 ${missing.length} 張影像` : '';
      }
    } else {
      const images = files.filter((f) => f.role === 'image' && f.format === label.format && f.case === label.case);
      if (images.length === 1) Object.assign(label, { pairedFileId: images[0].id, pairing: 'paired', pairing_note: '' });
      else label.pairing_note = images.length === 0 ? '尚未匯入對應影像' : '對應影像不唯一';
    }
  }
}

function finishJob(s: State, pid: number, kind: ImportKind, user: string, results: ImportFileResult[]): ImportJob {
  const counts = { imported: 0, duplicate: 0, failed: 0 };
  for (const r of results) counts[r.status]++;
  const status = counts.failed === 0 ? 'succeeded' : counts.imported + counts.duplicate === 0 ? 'failed' : 'partial';
  const job = { id: s.nextJobId++, kind, status, created_by: user, created_at: isoNow(), counts, files: results, projectId: pid } as State['jobs'][number];
  s.jobs.push(job);
  resolvePairings(s, pid);
  return jobOut(job, true);
}

function jobOut(job: State['jobs'][number], withFiles: boolean): ImportJob {
  const { projectId: _pid, files, ...rest } = job;
  return withFiles ? { ...rest, files } : rest;
}

function indexDicom(s: State, pid: number, info: DicomInfo, sourcePath: string): ImportFileResult {
  if (s.instances.some((i) => i.projectId === pid && i.sop === info.sop)) {
    return { filename: sourcePath, status: 'duplicate', reason: `SOP Instance UID ${info.sop} 已匯入` };
  }
  s.instances.push({ ...info, projectId: pid, sourcePath });
  return { filename: sourcePath, status: 'imported', reason: '' };
}

async function uploaded(request: Request): Promise<{ name: string; bytes: Uint8Array }[] | Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ detail: [{ type: 'missing', loc: ['body', 'files'], msg: 'Field required', input: null }] }, 422);
  }
  const files = form.getAll('files').filter((f): f is File => typeof f !== 'string');
  if (files.length === 0) {
    return json({ detail: [{ type: 'missing', loc: ['body', 'files'], msg: 'Field required', input: null }] }, 422);
  }
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

const QUERY_KEYS = ['AccessionNumber', 'Modality', 'PatientID', 'PatientSex', 'StudyDate', 'StudyDescription', 'StudyInstanceUID'];

function wildcard(pattern: string): RegExp {
  const escaped = pattern.toUpperCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matches(value: string, pattern: string, key: string): boolean {
  if (!pattern) return true;
  if (key === 'StudyDate' && pattern.includes('-')) {
    const [lo, hi] = pattern.split('-', 2);
    return (!lo || value >= lo) && (!hi || value <= hi);
  }
  if (key === 'Modality') return value.toUpperCase().split('\\').includes(pattern.toUpperCase());
  return wildcard(pattern).test(value.toUpperCase());
}

function pacsFind(s: State, query: Record<string, string>): PacsAnswer[] {
  const byStudy = new Map<string, DicomInfo[]>();
  for (const d of s.pacs) byStudy.set(d.study, [...(byStudy.get(d.study) ?? []), d]);
  const answers = [...byStudy.values()].map((rows) => {
    const mods = [...new Set(rows.map((r) => r.modality))].sort().join('\\');
    return {
      StudyInstanceUID: rows[0].study,
      AccessionNumber: rows[0].accession,
      PatientID: rows[0].patientId,
      PatientSex: rows[0].sex,
      StudyDate: rows[0].date,
      StudyDescription: rows[0].studyDescription,
      ModalitiesInStudy: mods,
      Modality: mods,
      NumberOfStudyRelatedSeries: String(new Set(rows.map((r) => r.series)).size),
      NumberOfStudyRelatedInstances: String(rows.length),
    };
  });
  return answers
    .filter((a) => Object.entries(query).every(([k, v]) => matches(String(a[k as keyof PacsAnswer] ?? ''), v, k)))
    .sort((a, b) => a.StudyInstanceUID.localeCompare(b.StudyInstanceUID));
}

const BASE = `${API}/projects/:pid/imaging`;
const DATE = /^(\d{8})$|^(\d{8})?-(\d{8})?$/;
const like = (value: string | null, needle: string) => (value ?? '').toUpperCase().includes(needle.trim().toUpperCase());

const FILTER_KEYS = ['modality', 'patient_sex', 'study_description', 'study_date', 'series_description'] as const;

/** 研究列表的五個篩選條件（資料範圍存的也是同樣的 key） */
function filterStudies(input: Study[], f: ScopeFilters): Study[] | Response {
  let list = input;
  const modality = f.modality;
  const sex = f.patient_sex;
  const studyDescription = f.study_description;
  const seriesDescription = f.series_description;
  const date = f.study_date;
  if (modality) list = list.filter((st) => st.series.some((x) => (x.modality ?? '').toUpperCase() === modality.trim().toUpperCase()));
  if (sex) list = list.filter((st) => (st.patient_sex ?? '').toUpperCase() === sex.trim().toUpperCase());
  if (studyDescription) list = list.filter((st) => like(st.study_description, studyDescription));
  if (seriesDescription) list = list.filter((st) => st.series.some((x) => like(x.series_description, seriesDescription)));
  if (date) {
    const hit = DATE.exec(date.trim());
    if (!hit) return detail(422, 'study_date 格式需為 YYYYMMDD 或 YYYYMMDD-YYYYMMDD');
    if (hit[1]) list = list.filter((st) => st.study_date === hit[1]);
    else {
      if (hit[2]) list = list.filter((st) => (st.study_date ?? '') >= hit[2]);
      if (hit[3]) list = list.filter((st) => (st.study_date ?? '') <= hit[3]);
    }
  }
  return list;
}

function scopesOf(s: State, pid: number) {
  s.scopes ??= [];
  return s.scopes.filter((x) => x.projectId === pid);
}

function scopeOut(s: State, scope: NonNullable<State['scopes']>[number]): Scope {
  const hit = filterStudies(studiesOf(s, scope.projectId), scope.filters);
  const { projectId: _p, ...rest } = scope;
  return { ...rest, study_count: hit instanceof Response ? 0 : hit.length };
}

/** body.filters 只留研究列表認得的 key、字串值 */
function cleanFilters(raw: unknown): ScopeFilters {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(FILTER_KEYS.filter((k) => typeof src[k] === 'string' && (src[k] as string).trim()).map((k) => [k, (src[k] as string).trim()]));
}

export const imagingHandlers = [
  http.post(`${BASE}/dicom`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const items = await uploaded(request);
    if (items instanceof Response) return items;
    const s = state();
    const results = items.map(({ name, bytes }): ImportFileResult => {
      const ext = /\.[^./]+$/.exec(name.toLowerCase())?.[0] ?? '';
      if (!['', '.dcm', '.dicom', '.ima'].includes(ext)) {
        return { filename: name, status: 'failed', reason: `副檔名 ${ext} 不是 DICOM（可用 .dcm 或無副檔名）` };
      }
      try {
        return indexDicom(s, ctx.project.id, parseDicom(bytes), name);
      } catch (e) {
        return { filename: name, status: 'failed', reason: e instanceof Error ? e.message : String(e) };
      }
    });
    return json(finishJob(s, ctx.project.id, 'dicom', ctx.user.username, results), 201);
  }),

  http.post(`${BASE}/files`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const items = await uploaded(request);
    if (items instanceof Response) return items;
    const s = state();
    const results: ImportFileResult[] = [];
    for (const { name, bytes } of items) {
      try {
        const parsed = parseOther(name, bytes);
        const d = await digest(bytes);
        const base = name.split('/').pop()!;
        if (s.files.some((f) => f.projectId === ctx.project.id && f.filename === base && f.digest === d)) {
          results.push({ filename: name, status: 'duplicate', reason: '相同內容的檔案已匯入' });
          continue;
        }
        s.files.push({
          id: s.nextFileId++,
          filename: base,
          ...parsed,
          pairing: parsed.role === 'image' ? 'n/a' : 'unpaired',
          pairing_note: '',
          paired_sop_instance_uids: [],
          projectId: ctx.project.id,
          digest: d,
          pairedFileId: null,
        });
        results.push({ filename: name, status: 'imported', reason: '' });
      } catch (e) {
        results.push({ filename: name, status: 'failed', reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return json(finishJob(s, ctx.project.id, 'files', ctx.user.username, results), 201);
  }),

  http.get(`${BASE}/files`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const s = state();
    const files = s.files.filter((f) => f.projectId === ctx.project.id);
    const pairedStudies = (sops: string[]): PairedStudy[] => {
      const byStudy = new Map<string, PairedStudy>();
      for (const sop of sops) {
        const i = s.instances.find((x) => x.projectId === ctx.project.id && x.sop === sop);
        if (!i) continue;
        const st = byStudy.get(i.study) ?? {
          study_instance_uid: i.study,
          accession_number: i.accession,
          study_description: i.studyDescription,
          instances: 0,
        };
        st.instances += 1;
        byStudy.set(i.study, st);
      }
      return [...byStudy.values()].sort((a, b) => a.accession_number.localeCompare(b.accession_number));
    };
    return json(
      files.map(({ projectId: _p, digest: _d, pairedFileId, ...f }) => ({
        ...f,
        paired_image: pairedFileId ? (files.find((x) => x.id === pairedFileId)?.filename ?? null) : null,
        paired_studies: pairedStudies(f.paired_sop_instance_uids),
      })),
    );
  }),

  http.get(`${BASE}/jobs`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const jobs = state().jobs.filter((j) => j.projectId === ctx.project.id);
    return json(jobs.map((j) => jobOut(j, false)).sort((a, b) => b.id - a.id));
  }),

  http.get(`${BASE}/jobs/:jid`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const job = state().jobs.find((j) => j.id === Number(params.jid) && j.projectId === ctx.project.id);
    return job ? json(jobOut(job, true)) : detail(404, `找不到匯入工作 ${params.jid}`);
  }),

  http.get(`${BASE}/studies`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const q = new URL(request.url).searchParams;
    let list = studiesOf(state(), ctx.project.id);
    const scopeId = q.get('scope_id');
    if (scopeId) {
      const scope = scopesOf(state(), ctx.project.id).find((x) => x.id === Number(scopeId));
      if (!scope) return detail(404, `找不到資料範圍 ${scopeId}`);
      const scoped = filterStudies(list, scope.filters);
      if (scoped instanceof Response) return scoped;
      list = scoped;
    }
    const filtered = filterStudies(list, Object.fromEntries(FILTER_KEYS.map((k) => [k, q.get(k) ?? ''])));
    if (filtered instanceof Response) return filtered;
    list = filtered;
    if (!q.has('limit')) return json(list); // 不帶 limit：完整陣列（既有行為）
    const limit = Number(q.get('limit'));
    const offset = Number(q.get('offset') ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return validation('limit', 'Input should be between 1 and 500', 'less_than_equal', q.get('limit'));
    if (!Number.isInteger(offset) || offset < 0) return validation('offset', 'Input should be >= 0', 'greater_than_equal', q.get('offset'));
    return json({ items: list.slice(offset, offset + limit), total: list.length, offset, limit });
  }),

  http.get(`${BASE}/scopes`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const s = state();
    return json(scopesOf(s, ctx.project.id).map((x) => scopeOut(s, x)));
  }),

  http.post(`${BASE}/scopes`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const b = await jsonBody(request);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return validation('name', 'String should have at least 1 character', 'string_too_short', b.name ?? null);
    const s = state();
    if (scopesOf(s, ctx.project.id).some((x) => x.name === name)) return detail(409, `已有名為「${name}」的資料範圍`);
    s.nextScopeId ??= 1;
    const scope = { id: s.nextScopeId++, projectId: ctx.project.id, name, filters: cleanFilters(b.filters), created_by: ctx.user.username, created_at: isoNow() };
    s.scopes!.push(scope);
    return json(scopeOut(s, scope), 201);
  }),

  http.put(`${BASE}/scopes/:sid`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const s = state();
    const scope = scopesOf(s, ctx.project.id).find((x) => x.id === Number(params.sid));
    if (!scope) return detail(404, `找不到資料範圍 ${params.sid}`);
    const b = await jsonBody(request);
    if (typeof b.name === 'string' && b.name.trim()) scope.name = b.name.trim();
    if (b.filters !== undefined) scope.filters = cleanFilters(b.filters);
    return json(scopeOut(s, scope));
  }),

  http.delete(`${BASE}/scopes/:sid`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const s = state();
    const scope = scopesOf(s, ctx.project.id).find((x) => x.id === Number(params.sid));
    if (!scope) return detail(404, `找不到資料範圍 ${params.sid}`);
    s.scopes = s.scopes!.filter((x) => x !== scope);
    return new Response(null, { status: 204 });
  }),

  http.get(`${BASE}/studies/:uid`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    const study = studiesOf(state(), ctx.project.id).find((st) => st.study_instance_uid === params.uid);
    return study ? json(study) : detail(404, '找不到研究，或不在本專案的 Accession 清單內');
  }),

  http.get(`${BASE}/accession-allowlist`, ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    return json({ accession_numbers: [...allowed(state(), ctx.project.id)].sort() });
  }),

  http.put(`${BASE}/accession-allowlist`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'project');
    if (ctx instanceof Response) return ctx;
    if (ctx.user.account_type !== 'admin') return detail(403, '需要 Admin 權限才能設定 Accession 清單');
    const b = await jsonBody(request);
    if (!Array.isArray(b.accession_numbers) || b.accession_numbers.some((x) => typeof x !== 'string')) {
      return json({ detail: [{ type: 'list_type', loc: ['body', 'accession_numbers'], msg: 'Input should be a valid list', input: null }] }, 422);
    }
    const wanted = [...new Set(b.accession_numbers as string[])].sort();
    const bad = wanted.filter((a) => !/^[A-Za-z0-9._-]{1,16}$/.test(a));
    if (bad.length) return detail(422, `Accession 格式錯誤：${bad.slice(0, 5).join(', ')}`);
    state().allowlists[ctx.project.id] = wanted;
    return json({ accession_numbers: wanted });
  }),

  http.post(`${BASE}/pacs/query`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const query = (await jsonBody(request)) as Record<string, string>;
    const unknown = Object.keys(query).filter((k) => !QUERY_KEYS.includes(k)).sort();
    if (unknown.length) return detail(422, `不支援的查詢欄位：${unknown.join(', ')}（可用 ${QUERY_KEYS.join(', ')}）`);
    const s = state();
    const list = allowed(s, ctx.project.id);
    return json(pacsFind(s, query).filter((a) => list.size === 0 || list.has(a.AccessionNumber ?? '')));
  }),

  http.post(`${BASE}/pacs/retrieve`, async ({ request, params }) => {
    const ctx = requireProject(request, params.pid, 'labeling');
    if (ctx instanceof Response) return ctx;
    const b = await jsonBody(request);
    const uid = typeof b.study_instance_uid === 'string' ? b.study_instance_uid : '';
    if (!/^[0-9]+(\.[0-9]+)*$/.test(uid) || uid.length > 64) return detail(422, 'Study Instance UID 格式錯誤');
    const s = state();
    const found = pacsFind(s, { StudyInstanceUID: uid });
    if (found.length === 0) return detail(404, `PACS 找不到研究 ${uid}`);
    const list = allowed(s, ctx.project.id);
    if (list.size > 0 && !list.has(found[0].AccessionNumber ?? '')) return detail(403, '此研究的 Accession 不在本專案清單內');
    const results = s.pacs
      .filter((d) => d.study === uid)
      .map((d, i) => indexDicom(s, ctx.project.id, d, `pacs/${uid}/${i + 1}`));
    return json(finishJob(s, ctx.project.id, 'pacs', ctx.user.username, results), 201);
  }),
];

/** Dashboard 模擬用：每個專案的影像研究數（以 Study Instance UID 去重）。 */
export function mockStudyCounts(): Map<number, number> {
  const seen = new Map<number, Set<string>>();
  for (const i of state().instances) {
    if (!seen.has(i.projectId)) seen.set(i.projectId, new Set());
    seen.get(i.projectId)!.add(i.study);
  }
  return new Map([...seen].map(([pid, set]) => [pid, set.size]));
}
