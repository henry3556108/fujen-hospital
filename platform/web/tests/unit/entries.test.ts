import { describe, expect, it } from 'vitest';
import { ENTRIES, checkAccess, visibleEntries, visibleNav } from '../../src/access/entries';
import { fixtureMe } from '../../src/mocks/data';

const labels = (me: ReturnType<typeof fixtureMe>) =>
  visibleEntries(me, me.projects[0] ?? null).map((e) => e.label);

describe('entry visibility rule (需與甲方確認)', () => {
  it('defines exactly the 8 function entries in order', () => {
    expect(ENTRIES.map((e) => e.label)).toEqual([
      '帳號管理',
      '數據管理',
      '影像標註',
      '自動影像分類標註',
      '建模管理',
      'AI 模型部署',
      '推論服務管理',
      '大型語言模型 No-code 開發',
    ]);
    expect(ENTRIES.find((e) => e.key === 'llm')!.aliases).toEqual(['LLM No-code 開發']);
  });

  it('every contract entry names its new location in the research or admin area', () => {
    expect(Object.fromEntries(ENTRIES.map((e) => [e.label, e.location]))).toEqual({
      帳號管理: '系統管理／帳號、專案',
      數據管理: '研究資料',
      影像標註: '影像標註／待處理',
      自動影像分類標註: '影像標註／自動標註',
      建模管理: '建立模型／訓練紀錄',
      'AI 模型部署': '使用模型／分享與服務',
      推論服務管理: '使用模型／預測新資料與紀錄',
      '大型語言模型 No-code 開發': '語言模型',
    });
  });

  it('sidebar areas follow the same permissions', () => {
    const names = (u: string) => visibleNav(fixtureMe(u), fixtureMe(u).projects[0] ?? null).map((a) => a.label);
    expect(names('vw01')).toEqual(['專案首頁', '研究資料', '使用模型']);
    expect(names('md01')).toEqual(['專案首頁', '研究資料', '影像標註', '使用模型']);
    expect(names('ra01')).toEqual(['專案首頁', '研究資料', '影像標註', '建立模型', '使用模型']);
    expect(names('ca01')).toEqual(['專案首頁', '研究資料', '建立模型', '使用模型', '語言模型']);
    expect(names('pi01')).toEqual(['專案首頁', '研究資料', '影像標註', '建立模型', '使用模型', '語言模型']);
    expect(names('user01')).toEqual([]);
  });

  it('TC-A02-02 vw01 (viewer: project, prediction) sees 數據管理 + deployment + inference', () => {
    expect(labels(fixtureMe('vw01'))).toEqual(['數據管理', 'AI 模型部署', '推論服務管理']);
  });

  it('TC-A02-02 md01 (medical_doctor: project, labeling, prediction)', () => {
    expect(labels(fixtureMe('md01'))).toEqual([
      '數據管理',
      '影像標註',
      '自動影像分類標註',
      'AI 模型部署',
      '推論服務管理',
    ]);
  });

  it('TC-A02-02 ca01 (coder_assistant: project, training, coding, prediction)', () => {
    expect(labels(fixtureMe('ca01'))).toEqual([
      '數據管理',
      '建模管理',
      'AI 模型部署',
      '推論服務管理',
      '大型語言模型 No-code 開發',
    ]);
  });

  it('TC-A02-02 admin01 sees all 8 entries', () => {
    expect(labels(fixtureMe('admin01'))).toHaveLength(8);
  });

  it('non-admin never sees 帳號管理 even with every permission', () => {
    const me = fixtureMe('pi01');
    expect(labels(me)).not.toContain('帳號管理');
    expect(labels(me)).toHaveLength(7);
  });

  it('user with no project sees nothing', () => {
    expect(labels(fixtureMe('user01'))).toEqual([]);
  });

  it('checkAccess gives a text reason naming the missing permission', () => {
    const me = fixtureMe('vw01');
    const training = ENTRIES.find((e) => e.key === 'training')!;
    const result = checkAccess(training, me, me.projects[0]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('Training');
    const admin = ENTRIES.find((e) => e.key === 'admin')!;
    const r2 = checkAccess(admin, me, me.projects[0]);
    expect(r2.allowed).toBe(false);
    if (!r2.allowed) expect(r2.reason).toContain('Admin');
  });

  it('evaluates against the selected project, not the union of projects', () => {
    const me = {
      username: 'x',
      account_type: 'user' as const,
      projects: [
        { id: 1, name: 'P1', role: 'viewer' as const, permissions: ['prediction' as const, 'project' as const] },
        { id: 2, name: 'P2', role: 'coder_assistant' as const, permissions: ['coding' as const] },
      ],
    };
    expect(visibleEntries(me, me.projects[0]).map((e) => e.key)).not.toContain('llm');
    expect(visibleEntries(me, me.projects[1]).map((e) => e.key)).toEqual(['llm']);
  });
});
