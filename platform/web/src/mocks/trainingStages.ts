// MSW：各階段處理程式碼（錄製巨集）/api/projects/:pid/training/settings/:sid/stages*、/package、/training/package-import*。
// 路徑、權限、狀態碼、回應形狀照 platform/api/app/training（stages.py、flow_stages.py、flow_import.py、flow.py、router.py）。
// 檢查只模擬幾種常見錯誤（JSON 格式、函式名稱、平台沒有的套件、部署的模型）；真正的框架檢查在 API。
import { http, HttpResponse } from 'msw';
import type { Deployment, PackageMapping, StageEntry, StageId, StageLock, StageOverview, TrainingConfig, TrainingSetting } from '../pages/training/api';
import { API, detail, isoNow, json, jsonBody, moduleState, requireProject } from './support';
import { KIND_NAMES } from '../pages/inference/api';
import { mockDatasetList } from './tabular';
import { trainingMock } from './training';

const P = `${API}/projects/:pid/training/settings/:sid`;
const STAGES: StageId[] = ['import', 'labels', 'preprocess', 'train', 'deploy'];
/** 有程式檔的階段（需要 Coding）；資料匯入與部署只有設定檔 */
const CODE: StageId[] = ['labels', 'preprocess', 'train'];
const NAMES: Record<StageId, string> = { import: '資料匯入', labels: '標註', preprocess: '資料清理與前處理', train: '訓練', deploy: '部署' };
const DEPLOY_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const hasCode = (stage: StageId) => CODE.includes(stage);
const ALLOWED = new Set(['numpy', 'pandas', 'scipy', 'sklearn', 'statsmodels', 'lifelines', 'tabular', 'runtime', 'tabularkit',
  'imagekit', 'keras', 'math', 'json', 'random', 'typing', 'collections', 'itertools', 'functools', 're', 'pathlib', 'copy', 'dataclasses']);

type Obj = Record<string, unknown>;
interface Lock extends StageLock {
  before: Obj;
  text: Record<string, string>;
}
interface State {
  locks: Record<number, Partial<Record<StageId, Lock>>>;
}

const state = () => moduleState<State>('trainingStages', () => ({ locks: {} }));
const isImage = (c: TrainingConfig) => c.kind.startsWith('image_');
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** 測試用：由匯入檔控制的階段。 */
export function lockedStages(settingId: number): StageId[] {
  const locks = state().locks[settingId] ?? {};
  return STAGES.filter((s) => locks[s]);
}

function entrypoints(stage: StageId, image: boolean): Record<string, string[]> {
  if (stage === 'labels') return { build_labels: [image ? 'manifest' : 'frame', 'config'] };
  if (stage === 'preprocess') return image ? { prepare_image: ['image', 'size', 'config'], augment_training_set: ['samples', 'config', 'seed'] }
    : { fit_transform: ['train', 'config'] };
  return { train: ['config', 'data_dir', 'out_dir'] };
}

function defaultCode(stage: StageId, image: boolean): string {
  const fns = entrypoints(stage, image);
  return Object.entries(fns).map(([name, args]) => `def ${name}(${args.join(', ')}):\n    ...\n`).join('\n') +
    (stage === 'train' ? '\n\nif __name__ == "__main__":\n    raise SystemExit(runtime.main(train))\n' : '');
}

export function stageConfig(config: TrainingConfig, stage: StageId): Obj {
  const image = isImage(config);
  if (stage === 'import') {
    const { label_source: _l, ...source } = config.source as unknown as Obj;
    return clone(source);
  }
  const hyper = { ...config.hyperparameters };
  if (stage === 'labels') {
    if (image) return clone({ labels: config.image?.labels ?? null, ...(config.source.type === 'dicom' ? { label_source: config.source.label_source } : {}) });
    return clone({ target: config.tabular?.target, features: config.tabular?.features });
  }
  if (stage === 'preprocess') {
    if (image) return clone({ resize: config.image?.resize, augmentation: config.augmentation, augmentation_copies: hyper.augmentation_copies ?? null });
    return clone({ steps: config.tabular?.steps ?? [], missing: config.tabular?.missing ?? null });
  }
  delete hyper.augmentation_copies;
  return clone({ split: config.split, seed: config.seed, hyperparameters: hyper,
    ...(image ? {} : { validation: config.validation ?? { method: 'holdout' }, algorithm: config.tabular?.algorithm }) });
}

function merge(config: TrainingConfig, stage: StageId, v: Obj): TrainingConfig {
  const out = clone(config);
  const image = isImage(out);
  if (stage === 'import') {
    const labelSource = (out.source as unknown as Obj).label_source;
    const { label_source: _l, ...source } = v;
    out.source = { ...source, ...(source.type === 'dicom' && labelSource !== undefined ? { label_source: labelSource } : {}) } as never;
    return out;
  }
  if (stage === 'deploy') return out;
  if (stage === 'labels') {
    if (image && out.image) {
      out.image.labels = (v.labels as string[] | null) ?? null;
      if (out.source.type === 'dicom' && v.label_source) out.source.label_source = v.label_source as never;
    } else if (out.tabular) {
      out.tabular.target = String(v.target ?? '');
      out.tabular.features = (v.features as string[]) ?? [];
    }
  } else if (stage === 'preprocess') {
    if (image && out.image) {
      out.image.resize = (v.resize as number[]) ?? [32, 32];
      out.augmentation = (v.augmentation as never) ?? out.augmentation;
      if (v.augmentation_copies == null) delete out.hyperparameters.augmentation_copies;
      else out.hyperparameters.augmentation_copies = v.augmentation_copies as number;
    } else if (out.tabular) {
      out.tabular.steps = (v.steps as never) ?? [];
      if (v.missing == null) delete out.tabular.missing;
      else out.tabular.missing = v.missing as never;
    }
  } else {
    const copies = out.hyperparameters.augmentation_copies;
    out.hyperparameters = { ...((v.hyperparameters as Obj) ?? {}) } as never;
    if (copies !== undefined) out.hyperparameters.augmentation_copies = copies;
    out.split = v.split as never;
    out.seed = Number(v.seed ?? 42);
    if (!image) {
      out.validation = v.validation as never;
      if (out.tabular) out.tabular.algorithm = String(v.algorithm);
    }
  }
  return out;
}

function fileNames(setting: TrainingSetting, stage: StageId): string[] {
  if (stage === 'import') return setting.config.source.type === 'tabular' ? ['import.json', 'schema.json'] : ['import.json'];
  if (stage === 'deploy') return ['deploy.json'];
  return [`${stage}.json`, `${stage}.py`];
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/** 部署階段目前的 deploy.json：這份設定最近一次訓練出的模型與它的部署（沒有時留空讓使用者填）。 */
function deployValues(setting: TrainingSetting): Obj {
  const t = trainingMock();
  const modelIds = t.runs.filter((r) => r.setting_id === setting.id && r.model_id != null).map((r) => r.model_id);
  const model = [...t.models].reverse().find((m) => m.project_id === setting.project_id && modelIds.includes(m.id));
  const dep = model ? t.deployments.find((d) => d.model_id === model.id) : undefined;
  return { model: { sha256: model?.sha256 ?? '' },
    deployment: { name: dep?.name ?? '', title: dep?.title ?? setting.name, allowed_users: dep?.allowed_users ?? [] } };
}

function files(setting: TrainingSetting, stage: StageId): Record<string, string> {
  const lock = state().locks[setting.id]?.[stage];
  if (lock) return { ...lock.text };
  if (stage === 'import') {
    const out: Record<string, string> = { 'import.json': pretty(stageConfig(setting.config, 'import')) };
    if (setting.config.source.type === 'tabular') out['schema.json'] = pretty({ columns: [] });
    return out;
  }
  if (stage === 'deploy') return { 'deploy.json': pretty(deployValues(setting)) };
  return { [`${stage}.json`]: JSON.stringify(stageConfig(setting.config, stage), null, 2) + '\n',
    [`${stage}.py`]: defaultCode(stage, isImage(setting.config)) };
}

const outLock = ({ before: _b, text: _t, ...lock }: Lock): StageLock => lock;

function overview(setting: TrainingSetting, canCode: boolean): StageOverview {
  const locks = state().locks[setting.id] ?? {};
  const stages: StageEntry[] = STAGES.map((stage) => ({
    stage, name: NAMES[stage], code: hasCode(stage), files: fileNames(setting, stage),
    entrypoints: hasCode(stage) ? entrypoints(stage, isImage(setting.config)) : {},
    locked: locks[stage] ? outLock(locks[stage]) : null, problem: null,
  }));
  return { setting_id: setting.id, kind: setting.kind, stages, problem: null, locked: lockedStages(setting.id), can_code: canCode };
}

/** 只有設定檔的階段（資料匯入、部署）的檢查 */
function checkConfig(setting: TrainingSetting, stage: StageId, text: Record<string, string>): string[] {
  const errors: string[] = [];
  const names = fileNames(setting, stage);
  for (const name of Object.keys(text)) {
    if (!names.includes(name)) errors.push(`不認得的檔案「${name}」：這個階段只有 ${names.join('、')}`);
  }
  const main = `${stage}.json`;
  if (!(main in text)) return [...errors, `缺少 ${main}`];
  let v: unknown;
  try {
    v = JSON.parse(text[main]);
  } catch {
    return [...errors, `${main} 不是正確的 JSON`];
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [...errors, `${main}：內容必須是 JSON 物件`];
  const o = v as Obj;
  if (stage === 'import') {
    if (o.type !== setting.config.source.type) errors.push(`import.json：資料來源種類必須是「${setting.config.source.type}」`);
    return errors;
  }
  const sha = (o.model as Obj | undefined)?.sha256;
  if (typeof sha !== 'string' || !sha) errors.push('deploy.json：缺少 model.sha256（要部署哪一個模型）');
  else if (!trainingMock().models.some((m) => m.project_id === setting.project_id && m.sha256 === sha)) {
    errors.push(`deploy.json：本專案沒有 sha256 為 ${sha.slice(0, 12)} 的模型，請先匯入或重新訓練`);
  }
  const dep = o.deployment as Obj | undefined;
  if (!dep || typeof dep !== 'object') errors.push('deploy.json：缺少 deployment（服務名稱、顯示名稱、可呼叫的帳號）');
  else if (typeof dep.name !== 'string' || !DEPLOY_NAME.test(dep.name)) {
    errors.push('deploy.json：服務名稱（deployment.name）只能用小寫英數字與連字號，開頭結尾必須是英數字，最多 63 字');
  }
  return errors;
}

/** 檢查：JSON 格式、函式名稱、平台沒有的套件、語法（只看明顯的錯）。 */
function check(setting: TrainingSetting, stage: StageId, text: Record<string, string>): string[] {
  if (!hasCode(stage)) return checkConfig(setting, stage, text);
  const errors: string[] = [];
  const cfgName = `${stage}.json`;
  const codeName = `${stage}.py`;
  for (const name of Object.keys(text)) {
    if (name !== cfgName && name !== codeName) errors.push(`不認得的檔案「${name}」：這個階段只有 ${cfgName}、${codeName}`);
  }
  if (!(cfgName in text)) errors.push(`缺少 ${cfgName}`);
  else {
    try {
      const v = JSON.parse(text[cfgName]) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) errors.push(`${cfgName}：內容必須是 JSON 物件`);
      else if (stage === 'labels' && !isImage(setting.config) && !((v as Obj).features as unknown[] | undefined)?.length) {
        errors.push(`${cfgName}：請至少選擇一個 Feature`);
      }
    } catch {
      errors.push(`${cfgName} 不是正確的 JSON`);
    }
  }
  const code = text[codeName];
  if (code === undefined) errors.push(`缺少 ${codeName}`);
  else {
    code.split('\n').forEach((line, i) => {
      const m = /^\s*(?:import|from)\s+([A-Za-z_][\w]*)/.exec(line);
      if (m && !ALLOWED.has(m[1])) errors.push(`${codeName} 第 ${i + 1} 行 import 了平台沒有的套件「${m[1]}」`);
    });
    for (const [fn, args] of Object.entries(entrypoints(stage, isImage(setting.config)))) {
      if (!new RegExp(`^def ${fn}\\(`, 'm').test(code)) errors.push(`${codeName} 缺少函式 ${fn}(${args.join(', ')})`);
    }
  }
  return errors;
}

function invalid(errors: string[]) {
  return json({ detail: { code: 'stage_invalid', message: '檔案不符合平台的流程框架，未套用', errors: errors.slice(0, 20) } }, 422);
}

function find(request: Request, params: Record<string, unknown>, wanted: 'training' | 'coding') {
  // 只有設定檔的階段（資料匯入、部署）只需要 Training
  const permission = wanted === 'coding' && params.stage !== undefined && !hasCode(params.stage as StageId) ? 'training' : wanted;
  const ctx = requireProject(request, params.pid, permission);
  if (ctx instanceof Response) return ctx;
  if (permission === 'coding') {
    const train = requireProject(request, params.pid, 'training');
    if (train instanceof Response) return train;
  }
  const setting = trainingMock().settings.find((x) => x.id === Number(params.sid) && x.project_id === ctx.project.id);
  if (!setting) return detail(404, `找不到訓練設定 ${String(params.sid)}`);
  const stage = params.stage as StageId | undefined;
  if (stage !== undefined && !STAGES.includes(stage)) return detail(404, `沒有「${stage}」這個階段`);
  const canCode = !(requireProject(request, params.pid, 'coding') instanceof Response);
  return { ctx, setting, stage: stage as StageId, canCode };
}

function applyText(found: { ctx: { user: { username: string } }; setting: TrainingSetting; stage: StageId; canCode: boolean }, text: Record<string, string>) {
  const { setting, stage } = found;
  const errors = check(setting, stage, text);
  if (errors.length) return invalid(errors);
  const values = JSON.parse(text[`${stage}.json`]) as Obj;
  const locks = (state().locks[setting.id] ??= {});
  const sha = Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(i * 7 + JSON.stringify(text).length) % 16]).join('');
  const user = found.ctx.user.username;
  let before: Obj;
  if (stage === 'deploy') {
    const applied = applyDeploy(setting, values, user, sha);
    before = locks.deploy?.before ?? applied.before;
  } else {
    before = locks[stage]?.before ?? stageConfig(setting.config, stage);
    setting.config = merge(setting.config, stage, values);
    setting.updated_by = user;
    setting.updated_at = isoNow();
  }
  locks[stage] = { stage, name: NAMES[stage], sha256: sha, files: Object.fromEntries(Object.keys(text).map((n) => [n, sha])),
    code_changed: hasCode(stage) && text[`${stage}.py`].trim() !== defaultCode(stage, isImage(setting.config)).trim(),
    imported_by: user, imported_at: isoNow(), before, text: { ...text } };
  return json({ ...overview(setting, found.canCode), setting });
}

/** 部署階段：建立或更新部署，並標示由 deploy.json 控制（照 flow_stages.apply_deploy）。 */
function applyDeploy(setting: TrainingSetting, values: Obj, user: string, sha: string): { before: Obj } {
  const t = trainingMock();
  const model = t.models.find((m) => m.project_id === setting.project_id && m.sha256 === (values.model as Obj).sha256)!;
  const d = values.deployment as { name: string; title?: string; allowed_users?: string[] };
  let row = t.deployments.find((x) => x.project_id === setting.project_id && x.name === d.name);
  let before: Obj;
  if (row) {
    before = { deployment_id: row.id, created: false, title: row.title, allowed_users: [...row.allowed_users] };
    row.title = d.title ?? row.title;
    row.allowed_users = [...(d.allowed_users ?? [])];
  } else {
    row = { id: t.nextDeployment++, project_id: setting.project_id, model_id: model.id, name: d.name, title: d.title ?? model.name,
      allowed_users: [...(d.allowed_users ?? [])], endpoint: `/api/inference/${d.name}/predict`, created_by: user, created_at: isoNow() } as Deployment;
    t.deployments.push(row);
    before = { deployment_id: row.id, created: true };
  }
  row.stage_lock = { sha256: sha, files: { 'deploy.json': sha }, imported_by: user, imported_at: isoNow(),
    setting: { id: setting.id, name: setting.name } };
  return { before };
}

/** 部署階段改回介面設定：既有部署還原顯示名稱與授權帳號；由匯入建立的部署保留（照 flow_stages.unlock_deploy）。 */
function unlockDeploy(before: Obj) {
  const row = trainingMock().deployments.find((d) => d.id === before.deployment_id);
  if (!row) return;
  if (!before.created) {
    row.title = before.title as string | undefined;
    row.allowed_users = [...(before.allowed_users as string[])];
  }
  row.stage_lock = null;
}

function zip(name: string) {
  return new HttpResponse(new Blob(['PK\u0005\u0006' + '\0'.repeat(18)]), {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` },
  });
}

/** 表單存檔時：匯入檔控制的階段不能改（照 service.update_setting）。回傳 409 或 null。 */
export function lockedChange(setting: TrainingSetting, config: TrainingConfig): Response | null {
  const changed = lockedStages(setting.id).filter((stage) => stage !== 'deploy').filter(
    (stage) => JSON.stringify(stageConfig(setting.config, stage)) !== JSON.stringify(stageConfig(config, stage)));
  if (!changed.length) return null;
  return detail(409, `「${changed.map((s) => NAMES[s]).join('、')}」由匯入的檔案控制，不能在表單修改；請改回用介面設定後再修改`);
}

/** 停止部署（刪除部署）時一併刪除控制它的 deploy.json（照 flow_stages.drop_deployment_locks） */
export function dropDeploymentLocks(deploymentId: number) {
  for (const locks of Object.values(state().locks)) {
    if (locks.deploy && locks.deploy.before.deployment_id === deploymentId) delete locks.deploy;
  }
}

/** 刪除訓練設定時一併刪除匯入檔 */
export function dropStages(settingId: number) {
  delete state().locks[settingId];
}

export const trainingStageHandlers = [
  http.get(`${P}/stages`, ({ request, params }) => {
    const found = find(request, params, 'training');
    return found instanceof Response ? found : json(overview(found.setting, found.canCode));
  }),
  http.get(`${P}/stages/:stage`, ({ request, params }) => {
    const found = find(request, params, 'coding');
    if (found instanceof Response) return found;
    const lock = state().locks[found.setting.id]?.[found.stage];
    const code = hasCode(found.stage);
    return json({ setting_id: found.setting.id, stage: found.stage, name: NAMES[found.stage], kind: found.setting.kind,
      files: files(found.setting, found.stage), default_code: code ? defaultCode(found.stage, isImage(found.setting.config)) : '',
      code, locked: lock ? outLock(lock) : null });
  }),
  http.get(`${P}/stages/:stage/export`, ({ request, params }) => {
    const found = find(request, params, 'coding');
    return found instanceof Response ? found : zip(`${found.setting.name}-${found.stage}.zip`);
  }),
  http.put(`${P}/stages/:stage`, async ({ request, params }) => {
    const found = find(request, params, 'coding');
    if (found instanceof Response) return found;
    const b = await jsonBody(request);
    const text = (b.files && typeof b.files === 'object' ? b.files : {}) as Record<string, string>;
    return applyText(found, text);
  }),
  http.post(`${P}/stages/:stage/upload`, async ({ request, params }) => {
    const found = find(request, params, 'coding');
    if (found instanceof Response) return found;
    const form = await request.formData();
    const upload = form.get('file');
    // 測試用的階段檔：內容含 stage.json 的 "stage": "<階段>"（模擬不解壓縮）
    const content = upload && typeof upload === 'object' && 'text' in upload ? await (upload as Blob).text() : '';
    const declared = /"stage":\s*"(\w+)"/.exec(content)?.[1];
    const other = STAGES.find((x) => x !== found.stage && x === declared);
    if (other) return invalid([`這個檔案是「${NAMES[other]}」階段，請到「${NAMES[other]}」匯入`]);
    return applyText(found, files(found.setting, found.stage));
  }),
  http.delete(`${P}/stages/:stage`, ({ request, params }) => {
    const found = find(request, params, 'training');
    if (found instanceof Response) return found;
    const locks = state().locks[found.setting.id] ?? {};
    const lock = locks[found.stage];
    if (!lock) return detail(409, `「${NAMES[found.stage]}」目前不是由匯入的檔案控制`);
    if (found.stage === 'deploy') unlockDeploy(lock.before);
    else found.setting.config = merge(found.setting.config, found.stage, lock.before);
    delete locks[found.stage];
    return json({ ...overview(found.setting, found.canCode), setting: found.setting });
  }),
  http.get(`${P}/package`, ({ request, params }) => {
    const found = find(request, params, 'coding');
    if (found instanceof Response) return found;
    const includeData = new URL(request.url).searchParams.get('include_data') === 'true';
    if (includeData && isImage(found.setting.config)) return detail(409, '影像專案包不能附原始資料（平台沒有去識別功能，DICOM 標頭含病人資料）');
    return zip(`${found.setting.name}-flow.zip`);
  }),
  http.post(`${API}/projects/:pid/training/package-import/check`, async ({ request, params }) => {
    const out = await packagePlan(request, params);
    return out instanceof Response ? out : json(out.plan);
  }),
  http.post(`${API}/projects/:pid/training/package-import`, async ({ request, params }) => {
    const out = await packagePlan(request, params);
    if (out instanceof Response) return out;
    const { plan, ctx, pkg } = out;
    if (plan.errors.length) return invalid(plan.errors);
    if (!plan.ready) return detail(409, '請先選擇要對應的資料（結構式資料集，或全部研究／指定研究）');
    const t = trainingMock();
    const exists = (n: string) => t.settings.some((x) => x.project_id === ctx.project.id && x.name === n);
    let name = plan.name;
    for (let i = 1; exists(name); i++) name = `${plan.name}（匯入 ${i}）`;
    const mapping = plan.mapping as PackageMapping;
    if (mapping.mode === 'package') Object.assign(mapping, { dataset_id: 900 + t.nextSetting, dataset_name: `${plan.name}（專案包資料）` });
    const source = plan.kind.startsWith('image_')
      ? { type: 'dicom', studies: mapping.source?.studies ?? 'all', label_source: { provider: 'monai_label' } }
      : { type: 'tabular', dataset_id: mapping.dataset_id ?? 0 };
    const config = { version: 1, split: { train: 0.7, validation: 0.15, test: 0.15 }, seed: 42, hyperparameters: {}, ...(pkg.config ?? {}), kind: plan.kind, source } as unknown as TrainingConfig;
    const now = isoNow();
    const setting: TrainingSetting = { id: t.nextSetting++, project_id: ctx.project.id, name, kind: plan.kind, config,
      created_by: ctx.user.username, updated_by: ctx.user.username, created_at: now, updated_at: now };
    t.settings.push(setting);
    const locks = (state().locks[setting.id] = {} as Partial<Record<StageId, Lock>>);
    for (const stage of plan.locked) {
      const sha = 'e'.repeat(64);
      locks[stage] = { stage, name: NAMES[stage], sha256: sha, files: Object.fromEntries(fileNames(setting, stage).map((n) => [n, sha])),
        code_changed: hasCode(stage), imported_by: ctx.user.username, imported_at: now,
        before: stageConfig(config, stage), text: files(setting, stage) };
    }
    return json({ ...overview(setting, true), setting, mapping, warnings: plan.warnings }, 201);
  }),
];

/** 測試用的專案包：zip 內容以 JSON 描述（模擬不解壓縮），例如
 * {"package": {"name": "糖尿病", "kind": "tabular_classification", "locked": ["preprocess"], "data": true, "rows": 80}}。
 * errors：檢核錯誤；data：附原始資料；match：本專案已有內容相同的資料（結構式為資料集名稱，影像為 true）。 */
interface PackageSpec {
  name?: string;
  kind?: TrainingSetting['kind'];
  locked?: StageId[];
  errors?: string[];
  warnings?: string[];
  data?: boolean;
  rows?: number;
  match?: string | boolean;
  deploy?: boolean;
  config?: Obj;
}

async function packagePlan(request: Request, params: Record<string, unknown>) {
  const ctx = requireProject(request, params.pid, 'training');
  if (ctx instanceof Response) return ctx;
  const coding = requireProject(request, params.pid, 'coding');
  if (coding instanceof Response) return coding;
  const form = await request.formData();
  const upload = form.get('file');
  const content = upload && typeof upload === 'object' && 'text' in upload ? await (upload as Blob).text() : '';
  let pkg: PackageSpec;
  try {
    pkg = ((JSON.parse(content) as { package?: PackageSpec }).package ?? null) as PackageSpec;
    if (!pkg) throw new Error();
  } catch {
    return invalid(['檔案不是 zip，或缺少 flow.json（不是平台匯出的專案包）']);
  }
  const kind = pkg.kind ?? 'tabular_classification';
  const image = kind.startsWith('image_');
  const warnings = [...(pkg.warnings ?? [])];
  if (pkg.deploy) warnings.push('部署階段沒有匯入：模型不隨專案包匯入，請在平台訓練完成後再匯入 deploy.json');
  const errors = [...(pkg.errors ?? [])];
  const datasetRaw = form.get('dataset_id');
  const studiesRaw = form.get('studies');
  let mapping: PackageMapping;
  if (!image) {
    const candidates = mockDatasetList(ctx.project.id);
    const matched = typeof pkg.match === 'string' ? candidates.find((d) => d.name === pkg.match) : undefined;
    const chosen = datasetRaw ? candidates.find((d) => d.id === Number(datasetRaw)) : undefined;
    if (pkg.data) mapping = { mode: 'package', rows: pkg.rows ?? null, candidates };
    else if (matched) mapping = { mode: 'matched', dataset_id: matched.id, dataset_name: matched.name, candidates };
    else if (chosen) mapping = { mode: 'chosen', dataset_id: chosen.id, dataset_name: chosen.name, candidates };
    else {
      if (datasetRaw) errors.push(`找不到資料集 ${String(datasetRaw)}`);
      mapping = { mode: 'choose', candidates };
    }
  } else if (pkg.match) {
    mapping = { mode: 'version', version_id: 7, source: { type: 'dicom', studies: 'all' } };
  } else if (studiesRaw) {
    const studies = String(studiesRaw) === 'all' ? 'all' : (JSON.parse(String(studiesRaw)) as string[]);
    if (studies !== 'all' && !studies.length) errors.push('請選擇「全部研究」或至少一個研究');
    mapping = { mode: 'studies', source: { type: 'dicom', studies } };
  } else {
    mapping = { mode: 'choose', studies_available: 3 };
  }
  const plan = { name: pkg.name ?? '匯入的流程', kind, kind_name: KIND_NAMES[kind] ?? kind, locked: pkg.locked ?? [], platform_version: '1.0.0', warnings,
    includes: { data: Boolean(pkg.data) }, ready: !errors.length && mapping.mode !== 'choose', errors, mapping };
  return { plan, ctx, pkg };
}
