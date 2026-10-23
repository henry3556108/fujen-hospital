import { describe, expect, it } from 'vitest';
import { primaryScore, primaryText } from '../../src/pages/training/metrics';

// 首頁、模型清單、訓練紀錄、單次訓練共用的主要指標（03 規格 3.5）
describe('primary metric (shared by home, model list, run list, run page)', () => {
  const pick = (kind: string, test: Record<string, number>) => {
    const s = primaryScore({ kind, metrics: { test } });
    return s ? primaryText(s.name, s.value) : null;
  };

  it('binary classification uses AUC first, accuracy when there is no AUC', () => {
    expect(pick('image_classification', { accuracy: 0.5, sensitivity: 1, auc: 0.33 })).toBe('AUC 0.33');
    expect(pick('tabular_classification', { accuracy: 0.8, auc: 0.84 })).toBe('AUC 0.84');
    expect(pick('image_classification', { accuracy: 0.65 })).toBe('準確率 65%');
  });

  it('detection mAP@0.5, segmentation Dice, regression MAE', () => {
    expect(pick('image_detection', { mean_iou: 0.6, map50: 0.72 })).toBe('mAP@0.5 0.72');
    expect(pick('image_segmentation', { pixel_accuracy: 0.9, dice: 0.81 })).toBe('Dice 係數 0.81');
    expect(pick('tabular_regression', { r2: 0.55, mae: 3.2, rmse: 4 })).toBe('MAE 3.20');
  });

  it('K-fold mean comes before the test set; nothing gives null', () => {
    const s = primaryScore({ kind: 'tabular_classification', metrics: { cv: { folds: 5, auc: { mean: 0.8, std: 0.1, values: [] } }, test: { auc: 0.7 } } });
    expect(s).toMatchObject({ name: 'auc', value: 0.8, source: '5 折平均' });
    expect(primaryScore({ kind: 'image_classification', metrics: {} })).toBeNull();
  });
});
