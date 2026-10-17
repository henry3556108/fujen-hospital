// 流程程式碼（錄製巨集）：環節名稱、鎖定提示文字、儲存表單時保留匯入檔控制的設定值。
// 環節與設定欄位的對應照 platform/api/app/training/stages.py 的 merge_config。
import { formatTime } from '../../components/format';
import { isImageKind, type StageId, type StageLock, type TrainingConfig } from './api';

export const STAGE_NAMES: Record<StageId, string> = { labels: '標註', preprocess: '資料清理與前處理', train: '訓練' };
export const STAGE_ORDER: StageId[] = ['labels', 'preprocess', 'train'];

export function stageNames(stages: string[]): string {
  return stages.map((s) => STAGE_NAMES[s as StageId] ?? s).join('、');
}

/** 「這個環節由匯入的檔案控制：preprocess.json、preprocess.py（wang，2026-10-20 14:05 匯入，sha256 41ab…）」 */
export function lockText(lock: StageLock): string {
  return `「${lock.name}」由匯入的檔案控制：${Object.keys(lock.files).join('、')}（${lock.imported_by}，${formatTime(lock.imported_at)} 匯入，sha256 ${lock.sha256.slice(0, 4)}…）`;
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function copyKey<T extends object>(target: T, source: T, key: keyof T) {
  if (source[key] === undefined) delete target[key];
  else target[key] = clone(source[key]);
}

/** 表單存檔前：匯入檔控制的環節一律用伺服器上的值（表單上這些欄位已停用，這裡避免表單自動整理改到它們）。 */
export function keepLocked(config: TrainingConfig, original: TrainingConfig, locked: StageId[]): TrainingConfig {
  if (!locked.length) return config;
  const out = clone(config);
  const image = isImageKind(original.kind);
  out.kind = original.kind;
  if (locked.includes('labels')) {
    if (image && out.image && original.image) {
      out.image.labels = clone(original.image.labels);
      if (out.source.type === 'dicom' && original.source.type === 'dicom') out.source.label_source = clone(original.source.label_source);
    } else if (out.tabular && original.tabular) {
      out.tabular.target = original.tabular.target;
      out.tabular.features = [...original.tabular.features];
    }
  }
  if (locked.includes('preprocess')) {
    if (image && out.image && original.image) {
      out.image.resize = clone(original.image.resize);
      copyKey(out, original, 'augmentation');
      copyKey(out.hyperparameters, original.hyperparameters, 'augmentation_copies');
    } else if (out.tabular && original.tabular) {
      out.tabular.steps = clone(original.tabular.steps);
      copyKey(out.tabular, original.tabular, 'missing');
    }
  }
  if (locked.includes('train')) {
    const copies = out.hyperparameters.augmentation_copies;
    out.hyperparameters = clone(original.hyperparameters);
    if (!locked.includes('preprocess')) {
      if (copies === undefined) delete out.hyperparameters.augmentation_copies;
      else out.hyperparameters.augmentation_copies = copies;
    }
    out.split = clone(original.split);
    out.seed = original.seed;
    if (!image) {
      copyKey(out, original, 'validation');
      if (out.tabular && original.tabular) out.tabular.algorithm = original.tabular.algorithm;
    }
  }
  return out;
}
