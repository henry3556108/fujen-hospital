// 8 個功能入口與可見規則。
//
// ⚠ 需與甲方確認：以下對應規則為 WP1b 暫定，確認前請勿在其他地方另寫判斷，
//   畫面顯示與直接網址阻擋都只呼叫本模組的 checkAccess / visibleEntries。
//
//   帳號管理                    → account_type = admin
//   數據管理                    → project
//   影像標註、自動影像分類標註  → labeling
//   建模管理                    → training
//   AI 模型部署、推論服務管理   → prediction
//   LLM No-code 開發            → coding
//   規則以「目前選取專案」的權限判斷；admin 全部可見。
import { PERMISSION_LABELS, type Me, type MeProject, type Permission } from '../api/types';

export type EntryRule = { kind: 'admin' } | { kind: 'permission'; permission: Permission };

export interface Entry {
  key: string;
  label: string;
  path: string;
  /** 契約模組代碼 */
  moduleCode: string;
  description: string;
  rule: EntryRule;
  /** true = M2 才交付，M1 只有骨架頁 */
  placeholder: boolean;
}

const perm = (permission: Permission): EntryRule => ({ kind: 'permission', permission });

export const ENTRIES: readonly Entry[] = [
  { key: 'admin', label: '帳號管理', path: '/admin', moduleCode: 'A-03', description: '專案、帳號與成員權限', rule: { kind: 'admin' }, placeholder: false },
  { key: 'data', label: '數據管理', path: '/data', moduleCode: 'B-01', description: '醫療影像與結構式資料匯入', rule: perm('project'), placeholder: true },
  { key: 'labeling', label: '影像標註', path: '/labeling', moduleCode: 'B-02', description: '影像標註平台', rule: perm('labeling'), placeholder: false },
  { key: 'auto-labeling', label: '自動影像分類標註', path: '/auto-labeling', moduleCode: 'B-03', description: '自動標註整合', rule: perm('labeling'), placeholder: false },
  { key: 'training', label: '建模管理', path: '/training', moduleCode: 'B-05', description: '自動訓練與模型匯出', rule: perm('training'), placeholder: true },
  { key: 'deployment', label: 'AI 模型部署', path: '/deployment', moduleCode: 'B-06', description: '模型部署', rule: perm('prediction'), placeholder: true },
  { key: 'inference', label: '推論服務管理', path: '/inference', moduleCode: 'B-06', description: '推論服務', rule: perm('prediction'), placeholder: true },
  { key: 'llm', label: 'LLM No-code 開發', path: '/llm', moduleCode: 'B-07／B-08', description: 'LLM、RAG 與工作流', rule: perm('coding'), placeholder: false },
];

export type AccessResult = { allowed: true } | { allowed: false; reason: string };

export function checkAccess(entry: Entry, me: Me, project: MeProject | null): AccessResult {
  if (me.account_type === 'admin') return { allowed: true };
  if (entry.rule.kind === 'admin') {
    return { allowed: false, reason: `「${entry.label}」需要 Admin 帳號類型，你的帳號類型是 User。` };
  }
  if (!project) {
    return { allowed: false, reason: '你尚未加入任何專案，請聯絡管理者將你加入專案。' };
  }
  const needed = entry.rule.permission;
  if (!project.permissions.includes(needed)) {
    return {
      allowed: false,
      reason: `你在專案「${project.name}」沒有 ${PERMISSION_LABELS[needed]} 權限，無法使用「${entry.label}」。`,
    };
  }
  return { allowed: true };
}

export function visibleEntries(me: Me, project: MeProject | null): Entry[] {
  return ENTRIES.filter((e) => checkAccess(e, me, project).allowed);
}

export function entryByKey(key: string): Entry | undefined {
  return ENTRIES.find((e) => e.key === key);
}
