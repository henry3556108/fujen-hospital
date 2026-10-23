// 導覽與 8 個契約功能入口的唯一設定來源（03 規格第二節、第五節）。
//
// 側欄（研究區、管理區）、功能目錄、直接輸入網址的阻擋都只呼叫本模組的
// checkAccess / visibleEntries / visibleNav，不在其他地方另寫判斷。
//
//   研究區側欄（白話名稱）          需要的權限
//   專案首頁                        專案成員
//   研究資料                        project
//   影像標註                        labeling
//   建立模型                        training
//   使用模型                        prediction
//   語言模型                        coding
//   系統管理（管理區）              account_type = admin
//
// 8 個契約入口（功能目錄列出原名稱）各自掛在一個區底下，權限跟著區走。
// 規則以「目前選取專案」的權限判斷；admin 全部可見。
import type { IconName } from '../components/Icon';
import { PERMISSION_LABELS, type Me, type MeProject, type Permission } from '../api/types';

export type EntryRule = { kind: 'admin' } | { kind: 'member' } | { kind: 'permission'; permission: Permission };

const perm = (permission: Permission): EntryRule => ({ kind: 'permission', permission });

/** 研究區側欄的一個區 */
export interface NavArea {
  key: 'home' | 'data' | 'labeling' | 'training' | 'models' | 'llm' | 'admin';
  label: string;
  path: string;
  icon: IconName;
  rule: EntryRule;
  /** 其他也算「在這一區」的路徑（契約舊入口） */
  match?: string[];
  /** 在這一項上方畫分隔線 */
  divider?: boolean;
}

export const AREAS: Record<NavArea['key'], NavArea> = {
  home: { key: 'home', label: '專案首頁', path: '/', icon: 'home', rule: { kind: 'member' } },
  data: { key: 'data', label: '研究資料', path: '/data', icon: 'folder', rule: perm('project') },
  labeling: { key: 'labeling', label: '影像標註', path: '/labeling', icon: 'pen', rule: perm('labeling'), match: ['/auto-labeling'] },
  training: { key: 'training', label: '建立模型', path: '/training', icon: 'cube', rule: perm('training') },
  models: { key: 'models', label: '使用模型', path: '/models', icon: 'play', rule: perm('prediction'), match: ['/deployment', '/inference'] },
  llm: { key: 'llm', label: '語言模型', path: '/llm', icon: 'chat', rule: perm('coding'), divider: true },
  admin: { key: 'admin', label: '系統管理', path: '/admin', icon: 'gear', rule: { kind: 'admin' } },
};

/** 研究區側欄的順序（系統管理放在側欄底部，另外處理） */
export const RESEARCH_NAV: readonly NavArea[] = [AREAS.home, AREAS.data, AREAS.labeling, AREAS.training, AREAS.models, AREAS.llm];

export interface Entry {
  key: string;
  /** 契約原名稱（功能目錄顯示） */
  label: string;
  /** 功能目錄另列的別名 */
  aliases?: string[];
  path: string;
  /** 契約模組代碼 */
  moduleCode: string;
  description: string;
  /** 改版後所在的區 */
  area: NavArea['key'];
  /** 改版後的位置（功能目錄「新位置」欄） */
  location: string;
  rule: EntryRule;
  /** true = M2 才交付，M1 只有骨架頁 */
  placeholder: boolean;
}

function entry(e: Omit<Entry, 'rule' | 'placeholder' | 'location'> & { sub?: string }): Entry {
  const area = AREAS[e.area];
  const { sub, ...rest } = e;
  return { ...rest, rule: area.rule, location: sub ? `${area.label}／${sub}` : area.label, placeholder: false };
}

export const ENTRIES: readonly Entry[] = [
  entry({ key: 'admin', label: '帳號管理', path: '/admin', moduleCode: 'A-03', description: '專案、帳號與成員權限', area: 'admin', sub: '帳號、專案' }),
  entry({ key: 'data', label: '數據管理', path: '/data', moduleCode: 'B-01', description: '醫療影像與結構式資料匯入', area: 'data' }),
  entry({ key: 'labeling', label: '影像標註', path: '/labeling', moduleCode: 'B-02', description: '影像標註平台', area: 'labeling', sub: '待處理' }),
  entry({ key: 'auto-labeling', label: '自動影像分類標註', path: '/auto-labeling', moduleCode: 'B-03', description: '自動標註整合', area: 'labeling', sub: '自動標註' }),
  entry({ key: 'training', label: '建模管理', path: '/training', moduleCode: 'B-05', description: '自動訓練與模型匯出', area: 'training', sub: '訓練紀錄' }),
  entry({ key: 'deployment', label: 'AI 模型部署', path: '/deployment', moduleCode: 'B-06', description: '模型部署', area: 'models', sub: '分享與服務' }),
  entry({ key: 'inference', label: '推論服務管理', path: '/inference', moduleCode: 'B-06', description: '推論服務', area: 'models', sub: '預測新資料與紀錄' }),
  entry({
    key: 'llm',
    label: '大型語言模型 No-code 開發',
    aliases: ['LLM No-code 開發'],
    path: '/llm',
    moduleCode: 'B-07／B-08',
    description: 'LLM、RAG 與工作流',
    area: 'llm',
  }),
];

export type AccessResult = { allowed: true } | { allowed: false; reason: string };

/** 入口或側欄區都可以檢查：只看名稱與規則 */
export function checkAccess(target: { label: string; rule: EntryRule }, me: Me, project: MeProject | null): AccessResult {
  if (me.account_type === 'admin') return { allowed: true };
  if (target.rule.kind === 'admin') {
    return { allowed: false, reason: `「${target.label}」需要 Admin 帳號類型，你的帳號類型是 User。` };
  }
  if (!project) {
    return { allowed: false, reason: '你尚未加入任何專案，請聯絡管理者將你加入專案。' };
  }
  if (target.rule.kind === 'member') return { allowed: true };
  const needed = target.rule.permission;
  if (!project.permissions.includes(needed)) {
    return {
      allowed: false,
      reason: `你在專案「${project.name}」沒有 ${PERMISSION_LABELS[needed]} 權限，無法使用「${target.label}」。`,
    };
  }
  return { allowed: true };
}

export function visibleEntries(me: Me, project: MeProject | null): Entry[] {
  return ENTRIES.filter((e) => checkAccess(e, me, project).allowed);
}

/** 研究區側欄：依權限顯示；沒有專案時一項都不顯示 */
export function visibleNav(me: Me, project: MeProject | null): NavArea[] {
  if (!project) return [];
  return RESEARCH_NAV.filter((a) => checkAccess(a, me, project).allowed);
}

export function entryByKey(key: string): Entry | undefined {
  return ENTRIES.find((e) => e.key === key);
}

/** 管理區側欄（只有 Admin） */
export interface AdminNavItem {
  key: string;
  label: string;
  path: string;
  icon: IconName;
  match?: string[];
}

export const ADMIN_NAV: readonly AdminNavItem[] = [
  { key: 'overview', label: '總覽', path: '/admin', icon: 'chart' },
  { key: 'users', label: '帳號', path: '/admin/users', icon: 'users' },
  { key: 'projects', label: '專案', path: '/admin/projects', icon: 'folder' },
  { key: 'compute', label: '運算資源', path: '/admin/compute', icon: 'server' },
  { key: 'monitoring', label: '系統監控', path: '/admin/monitoring', icon: 'pulse' },
  { key: 'fhir', label: '資料交換', path: '/admin/fhir', icon: 'swap' },
  { key: 'audit', label: '稽核與審核', path: '/admin/audit', icon: 'doc', match: ['/admin/approvals'] },
];

/** 目前路徑是否在某一區（側欄標示目前位置） */
export function isActive(item: { path: string; match?: string[] }, pathname: string): boolean {
  const prefixes = [item.path, ...(item.match ?? [])];
  return prefixes.some((p) =>
    p === '/' || p === '/admin' ? pathname === p || pathname === `${p}/` : pathname === p || pathname.startsWith(`${p}/`),
  );
}
