import { describe, expect, it } from 'vitest';
import { projectCover, projectCoverKind } from '../../src/pages/global/projectCover';

describe('projectCover', () => {
  it('依名稱與描述關鍵字挑示意圖', () => {
    expect(projectCoverKind({ name: '胸部 X 光肺炎研究' })).toBe('chest-xray');
    expect(projectCoverKind({ name: 'CR 影像分類' })).toBe('chest-xray');
    expect(projectCoverKind({ name: '胸部 DX' })).toBe('chest-xray');
    expect(projectCoverKind({ name: '胸腔 CT 研究' })).toBe('chest-ct');
    expect(projectCoverKind({ name: '肺結節偵測' })).toBe('chest-ct');
    expect(projectCoverKind({ name: '腦部腫瘤' })).toBe('brain-mri');
    expect(projectCoverKind({ name: 'MRI 分割' })).toBe('brain-mri');
    expect(projectCoverKind({ name: '再入院', description: '住院病人風險預測' })).toBe('ward');
    expect(projectCoverKind({ name: '臨床表格資料' })).toBe('ward');
    expect(projectCoverKind({ name: 'P2-tabular', description: '結構式' })).toBe('ward');
    expect(projectCoverKind({ name: 'demo' })).toBe('default');
    expect(projectCoverKind({ name: 'scratch', description: null })).toBe('default');
  });

  it('不會把英文單字裡的 ct、mr 誤判', () => {
    expect(projectCoverKind({ name: 'Project Alpha' })).toBe('default');
    expect(projectCoverKind({ name: 'mrna study' })).toBe('default');
  });

  it('回傳 public 底下的圖片路徑', () => {
    expect(projectCover({ name: '腦 MRI' }).src).toMatch(/illustrations\/projects\/brain-mri\.jpg$/);
    expect(projectCover({ name: '' }).src).toMatch(/illustrations\/projects\/default\.jpg$/);
  });
});
