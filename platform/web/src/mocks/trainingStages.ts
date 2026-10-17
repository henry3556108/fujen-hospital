// MSW：流程程式碼（錄製巨集）/api/projects/:pid/training/settings/:sid/stages*、/package。
// 路徑、權限、狀態碼、回應形狀照 platform/api/app/training（stages.py、flow.py、router.py）。
// 檢查只模擬幾種常見錯誤（JSON 格式、函式名稱、平台沒有的套件）；真正的框架檢查在 API。
import { http, HttpResponse } from 'msw';
import type { StageEntry, StageId, StageLock, StageOverview, TrainingConfig, TrainingSetting } from '../pages/training/api';
import { API, detail, isoNow, json, jsonBody, moduleState, requireProject } from './support';
import { trainingMock } from './training';

const P = `${API}/projects/:pid/training/settings/:sid`;
const STAGES: StageId[] = ['labels', 'preprocess', 'train'];
const NAMES: Record<StageId, string> = { labels: '標註', preprocess: '資料清理與前處理', train: '訓練' };
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

/** 測試用：由匯入檔控制的環節。 */
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

function files(setting: TrainingSetting, stage: StageId): Record<string, string> {
  const lock = state().locks[setting.id]?.[stage];
  if (lock) return { ...lock.text };
  return { [`${stage}.json`]: JSON.stringify(stageConfig(setting.config, stage), null, 2) + '\n',
    [`${stage}.py`]: defaultCode(stage, isImage(setting.config)) };
}

const outLock = ({ before: _b, text: _t, ...lock }: Lock): StageLock => lock;

function overview(setting: TrainingSetting, canCode: boolean): StageOverview {
  const locks = state().locks[setting.id] ?? {};
  const stages: StageEntry[] = STAGES.map((stage) => ({
    stage, name: NAMES[stage], files: [`${stage}.json`, `${stage}.py`], entrypoints: entrypoints(stage, isImage(setting.config)),
    locked: locks[stage] ? outLock(locks[stage]) : null, problem: null,
  }));
  return { setting_id: setting.id, kind: setting.kind, stages, problem: null, locked: lockedStages(setting.id), can_code: canCode };
}

/** 檢查：JSON 格式、函式名稱、平台沒有的套件、語法（只看明顯的錯）。 */
function check(setting: TrainingSetting, stage: StageId, text: Record<string, string>): string[] {
  const errors: string[] = [];
  const cfgName = `${stage}.json`;
  const codeName = `${stage}.py`;
  for (const name of Object.keys(text)) {
    if (name !== cfgName && name !== codeName) errors.push(`不認得的檔案「${name}」：這個環節只有 ${cfgName}、${codeName}`);
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

function find(request: Request, params: Record<string, unknown>, permission: 'training' | 'coding') {
  const ctx = requireProject(request, params.pid, permission);
  if (ctx instanceof Response) return ctx;
  if (permission === 'coding') {
    const train = requireProject(request, params.pid, 'training');
    if (train instanceof Response) return train;
  }
  const setting = trainingMock().settings.find((x) => x.id === Number(params.sid) && x.project_id === ctx.project.id);
  if (!setting) return detail(404, `找不到訓練設定 ${String(params.sid)}`);
  const stage = params.stage as StageId | undefined;
  if (stage !== undefined && !STAGES.includes(stage)) return detail(404, `沒有「${stage}」這個環節`);
  const canCode = !(requireProject(request, params.pid, 'coding') instanceof Response);
  return { ctx, setting, stage: stage as StageId, canCode };
}

function applyText(found: { ctx: { user: { username: string } }; setting: TrainingSetting; stage: StageId; canCode: boolean }, text: Record<string, string>) {
  const { setting, stage } = found;
  const errors = check(setting, stage, text);
  if (errors.length) return invalid(errors);
  const values = JSON.parse(text[`${stage}.json`]) as Obj;
  const locks = (state().locks[setting.id] ??= {});
  const before = locks[stage]?.before ?? stageConfig(setting.config, stage);
  setting.config = merge(setting.config, stage, values);
  setting.updated_by = found.ctx.user.username;
  setting.updated_at = isoNow();
  const sha = Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(i * 7 + JSON.stringify(text).length) % 16]).join('');
  locks[stage] = { stage, name: NAMES[stage], sha256: sha, files: Object.fromEntries(Object.keys(text).map((n) => [n, sha])),
    code_changed: text[`${stage}.py`].trim() !== defaultCode(stage, isImage(setting.config)).trim(),
    imported_by: found.ctx.user.username, imported_at: isoNow(), before, text: { ...text } };
  return json({ ...overview(setting, found.canCode), setting });
}

function zip(name: string) {
  return new HttpResponse(new Blob(['PK\u0005\u0006' + '\0'.repeat(18)]), {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` },
  });
}

/** 表單存檔時：匯入檔控制的環節不能改（照 service.update_setting）。回傳 409 或 null。 */
export function lockedChange(setting: TrainingSetting, config: TrainingConfig): Response | null {
  const changed = lockedStages(setting.id).filter(
    (stage) => JSON.stringify(stageConfig(setting.config, stage)) !== JSON.stringify(stageConfig(config, stage)));
  if (!changed.length) return null;
  return detail(409, `「${changed.map((s) => NAMES[s]).join('、')}」由匯入的檔案控制，不能在表單修改；請改回用介面設定後再修改`);
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
    return json({ setting_id: found.setting.id, stage: found.stage, name: NAMES[found.stage], kind: found.setting.kind,
      files: files(found.setting, found.stage), default_code: defaultCode(found.stage, isImage(found.setting.config)),
      locked: lock ? outLock(lock) : null });
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
    // 測試用的環節檔：內容含 stage.json 的 "stage": "<環節>"（模擬不解壓縮）
    const content = upload && typeof upload === 'object' && 'text' in upload ? await (upload as Blob).text() : '';
    const declared = /"stage":\s*"(\w+)"/.exec(content)?.[1];
    const other = STAGES.find((x) => x !== found.stage && x === declared);
    if (other) return invalid([`這個檔案是「${NAMES[other]}」環節，請到「${NAMES[other]}」匯入`]);
    return applyText(found, files(found.setting, found.stage));
  }),
  http.delete(`${P}/stages/:stage`, ({ request, params }) => {
    const found = find(request, params, 'training');
    if (found instanceof Response) return found;
    const locks = state().locks[found.setting.id] ?? {};
    const lock = locks[found.stage];
    if (!lock) return detail(409, `「${NAMES[found.stage]}」目前不是由匯入的檔案控制`);
    found.setting.config = merge(found.setting.config, found.stage, lock.before);
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
];
