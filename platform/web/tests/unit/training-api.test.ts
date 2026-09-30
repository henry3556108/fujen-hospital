// 建模管理與部署的 API 用戶端，對 MSW 模擬（照 platform/api/app/training 的行為）。
import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '../../src/api/client';
import { createTrainingApi, parseUsers, type TrainingConfig } from '../../src/pages/training/api';
import { normalise } from '../../src/mocks/training';

function client(username: string) {
  const token = async () => `test-token:${username}`;
  const api = createApiClient({ base: 'http://localhost', getToken: token, onUnauthorized: () => {} });
  return createTrainingApi(api, 1, token, 'http://localhost');
}

const IMAGE: TrainingConfig = {
  kind: 'image_classification',
  source: { type: 'dicom', studies: ['1.2.3', '1.2.2'], label_source: { provider: 'annotations' } },
  split: { train: 0.7, validation: 0.2, test: 0.1 },
  seed: 7,
  image: { resize: [64, 48], labels: ['nodule', 'normal'] },
  augmentation: { rotation_range: 15, width_shift_range: 0.1, height_shift_range: 0.2, shear_range: 5, zoom_range: 0.3,
    horizontal_flip: true, vertical_flip: false },
  hyperparameters: { epochs: 2 },
};

describe('training mock normalisation (config.py)', () => {
  it('fills defaults, sorts study lists and is idempotent', () => {
    const once = normalise(IMAGE);
    expect(once.source).toEqual({ type: 'dicom', studies: ['1.2.2', '1.2.3'], label_source: { provider: 'annotations' } });
    expect(once.hyperparameters).toEqual({ epochs: 2, batch_size: 8, learning_rate: 0.001, filters: 8, augmentation_copies: 1 });
    expect(normalise(once)).toEqual(once);
  });

  it('rejects out-of-range augmentation and a split that does not add up to 1', () => {
    expect(() => normalise({ ...IMAGE, augmentation: { rotation_range: 200 } })).toThrow('「旋轉角度範圍（度）」必須介於 0 與 180 之間');
    expect(() => normalise({ ...IMAGE, split: { train: 0.5, validation: 0.2, test: 0.2 } })).toThrow('比例總和必須等於 1');
  });
});

describe('training api client', () => {
  it('TC-B05-02 a saved setting reads back identical', async () => {
    const api = client('ra01');
    const created = await api.createSetting('胸部 CT 分類', IMAGE);
    const again = await api.setting(created.id);
    expect(again.config).toEqual(created.config);
    expect(again.config.augmentation).toEqual(IMAGE.augmentation);
    const updated = await api.updateSetting(created.id, '胸部 CT 分類', { ...created.config, seed: 99 });
    expect((await api.setting(created.id)).config).toEqual(updated.config);
    expect(updated.config.seed).toBe(99);
  });

  it('TC-B05-01 a run goes queued → running → succeeded and registers a model', async () => {
    const api = client('ra01');
    const setting = await api.createSetting('s', IMAGE);
    const run = await api.submit(setting.id, 'template');
    expect(run.status).toBe('queued');
    expect((await api.run(run.id)).status).toBe('queued');
    expect((await api.run(run.id)).status).toBe('running');
    const done = await api.run(run.id);
    expect(done.status).toBe('succeeded');
    expect(done.model_id).not.toBeNull();
    const model = (await api.models()).find((m) => m.id === done.model_id)!;
    expect(model).toMatchObject({ kind: 'image_classification', format: 'h5', filename: 's-run1.h5' });
  });

  it('TC-B05-05 / 06 model download carries sha256; source export needs Coding', async () => {
    const api = client('pi01');
    const setting = await api.createSetting('s', IMAGE);
    const run = await api.submit(setting.id, 'fake');
    await api.runs();
    await api.runs();
    const done = (await api.runs())[0];
    const file = await api.downloadModel(done.model_id!);
    expect(file.filename).toBe('s-run1.h5');
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await api.exportSource(run.id)).filename).toBe(`training-run-${run.id}-source.zip`);
    // ra01（Research Assistant）沒有 Coding
    await expect(client('ra01').exportSource(run.id)).rejects.toMatchObject({ status: 403, permission: 'coding' });
  });

  it('TC-B06-06 deployment with authorised users; unknown users are rejected', async () => {
    const api = client('pi01');
    const deployed = await api.deploy({ model_id: 101, name: 'diagnosis-api', allowed_users: ['md01', 'pi01'] });
    expect(deployed.endpoint).toBe('/api/inference/diagnosis-api/predict');
    await expect(api.setAccess(deployed.id, ['nobody'])).rejects.toThrow('帳號不存在：nobody');
    expect((await api.setAccess(deployed.id, ['md01'])).allowed_users).toEqual(['md01']);
    await expect(api.deploy({ model_id: 101, name: 'Bad Name', allowed_users: [] })).rejects.toBeInstanceOf(ApiError);
    await api.undeploy(deployed.id);
    expect(await api.deployments()).toEqual([]);
  });

  it('parses user lists separated by commas, 頓號 or spaces', () => {
    expect(parseUsers('md01, pi01、ra01  md01')).toEqual(['md01', 'pi01', 'ra01']);
  });
});
