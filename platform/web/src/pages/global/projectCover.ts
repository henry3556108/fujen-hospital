// 專案示意封面（AI 產生的裝飾圖，不是真實影像）：依專案名稱與描述的關鍵字挑圖。
// 用在選擇專案卡片、首頁專案標頭、模型卡片等「示意」位置；顯示真實影像一律用 DicomThumb。

export type ProjectCoverKind = 'chest-xray' | 'chest-ct' | 'brain-mri' | 'ward' | 'default';

export interface ProjectCover {
  kind: ProjectCoverKind;
  /** 圖片網址（public/illustrations/projects） */
  src: string;
}

// 依序比對，先符合的先用（X 光優先於「胸」字的 CT）
const RULES: { kind: ProjectCoverKind; pattern: RegExp }[] = [
  { kind: 'chest-xray', pattern: /x\s*光|x-?ray|\bcr\b|\bdx\b|胸部\s*x/i },
  { kind: 'brain-mri', pattern: /腦|mri|\bmr\b/i },
  { kind: 'chest-ct', pattern: /\bct\b|電腦斷層|肺/i },
  { kind: 'ward', pattern: /住院|表格|臨床|風險|結構化|結構式|tabular/i },
];

export function projectCoverKind(project: { name?: string | null; description?: string | null }): ProjectCoverKind {
  const text = `${project.name ?? ''} ${project.description ?? ''}`;
  return RULES.find((r) => r.pattern.test(text))?.kind ?? 'default';
}

export function projectCover(project: { name?: string | null; description?: string | null }): ProjectCover {
  const kind = projectCoverKind(project);
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/?$/, '/');
  return { kind, src: `${base}illustrations/projects/${kind}.jpg` };
}
