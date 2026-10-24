import fs from 'node:fs';
import path from 'node:path';
import { test, type Page } from '@playwright/test';
import { EVIDENCE_DIR, P1, useProject } from './helpers';
import { psql, userPage } from './ops';

// 介面改版巡檢：每個角色逐頁打開，不看畫面內容，只用程式檢查明顯錯誤，結果寫成 TSV（只需看失敗列）。
//   檢查：頁面例外、console error、5xx、圖片載入失敗、橫向捲軸、主區空白、重複編號「1. 1.」。
//   截圖存 EVIDENCE_DIR/巡檢/<角色>/（JPEG，給人工抽查或與設計稿並排用，不需逐張看）。
//   SWEEP_ROLES=admin01,pi01 只跑部分角色。
const OUT = path.join(EVIDENCE_DIR, '巡檢');
const one = (sql: string) => psql(sql).split('\n')[0]?.trim() ?? '';

const pid = one(`select id from projects where name='${P1}'`);
const study = one(`select study_instance_uid from imaging_studies where project_id=${pid || 0} order by id limit 1`);
const labelDs = one(`select id from label_datasets where project_id=${pid || 0} order by id limit 1`);
const tabDs = one(`select id from tabular_datasets where project_id=${pid || 0} order by id limit 1`);
const run = one(`select id from training_runs where project_id=${pid || 0} and status='succeeded' order by id desc limit 1`);
const importJob = one(`select id from imaging_import_jobs where project_id=${pid || 0} order by id desc limit 1`);

const RESEARCH = [
  '/', '/projects', '/account', '/catalog',
  '/data/imaging', '/data/imaging/import', '/data/imaging/jobs', '/data/imaging/allowlist',
  importJob && `/data/imaging/jobs/${importJob}`,
  study && `/data/imaging/studies/${study}`,
  '/data/tabular',
  tabDs && `/data/tabular/${tabDs}/view`, tabDs && `/data/tabular/${tabDs}/prepare`, tabDs && `/data/tabular/${tabDs}/stats`,
  '/labeling', '/labeling/datasets', labelDs && `/labeling/datasets/${labelDs}`, '/labeling/auto',
  study && `/labeling/studies/${study}`,
  '/training', '/training/new', '/training/settings', '/training/code', run && `/training/runs/${run}`,
  '/models', run && `/models/${run}/result`, run && `/models/${run}/predict`, run && `/models/${run}/history`,
  run && `/models/${run}/share`, run && `/models/${run}/download`, run && `/models/${run}/call`,
  '/llm/chat', '/llm/docs', '/llm/prompts', '/llm/services', '/llm/models', '/llm/workflows', '/llm/wiki',
].filter(Boolean) as string[];

const ADMIN = [
  '/admin', '/admin/users', '/admin/projects', pid && `/admin/projects/${pid}`,
  '/admin/compute/gpu', '/admin/compute/queues', '/admin/compute/shared', '/admin/compute/groups', '/admin/compute/nodes',
  '/admin/compute/jobs', '/admin/monitoring',
  '/admin/fhir/resources', '/admin/fhir/sources', '/admin/fhir/schedules', '/admin/fhir/graph', '/admin/fhir/alerts', '/admin/fhir/gateway',
  '/admin/audit', '/admin/approvals',
].filter(Boolean) as string[];

const ROLES: Record<string, string[]> = {
  admin01: [...RESEARCH, ...ADMIN],
  pi01: RESEARCH, md01: RESEARCH, ra01: RESEARCH, ca01: RESEARCH, vw01: RESEARCH,
};
const pick = (process.env.SWEEP_ROLES || '').split(',').filter(Boolean);
// 瀏覽器對每個 4xx 都會印 console「Failed to load resource」；HTTP 狀態另由 response 檢查，這裡不重複算
const NOISE = /favicon|ResizeObserver loop|Download the React DevTools|net::ERR_ABORTED|Failed to load resource/;
// 本來就會 404 的查詢：資料集還沒設定想預測的欄位
const EXPECTED_404 = /\/tabular\/datasets\/\d+\/target-feature$/;

type Row = { role: string; route: string; status: 'ok' | 'fail' | 'denied'; issues: string[]; shot: string };

async function check(page: Page, role: string, route: string, idx: number): Promise<Row> {
  const issues: string[] = [];
  const onConsole = (m: { type(): string; text(): string }) => {
    if (m.type() === 'error' && !NOISE.test(m.text())) issues.push(`console: ${m.text().slice(0, 140)}`);
  };
  const onError = (e: Error) => issues.push(`pageerror: ${e.message.slice(0, 140)}`);
  const onResp = (r: { status(): number; url(): string }) => {
    const st = r.status();
    const p = new URL(r.url()).pathname;
    if (st === 404 && EXPECTED_404.test(p)) return;
    if (st >= 500 || (st >= 400 && st !== 401 && st !== 403)) issues.push(`HTTP ${st} ${p}`);
  };
  page.on('console', onConsole); page.on('pageerror', onError); page.on('response', onResp);
  try {
    await page.goto(route);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => issues.push('networkidle 超過 10 秒'));
    await page.waitForTimeout(500);
    const probe = await page.evaluate(() => {
      const main = document.querySelector('main') ?? document.body;
      const text = (main as HTMLElement).innerText || '';
      const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.src && !i.src.startsWith('data:')).map((i) => i.src);
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        textLen: text.trim().length,
        hasHeading: !!main.querySelector('h1, h2'),
        dupNum: /(^|\n)\s*(\d+)\.\s*\2\.\s/.test(text),
        broken: broken.slice(0, 3),
        denied: text.includes('無法存取此功能'),
      };
    });
    if (probe.overflow > 1) issues.push(`橫向捲軸 ${probe.overflow}px`);
    if (probe.textLen < 20) issues.push('主區幾乎空白');
    if (!probe.hasHeading && !probe.denied) issues.push('沒有標題');
    if (probe.dupNum) issues.push('重複編號');
    for (const b of probe.broken) issues.push(`圖片失敗 ${b.replace(/^https?:\/\/[^/]+/, '').slice(0, 100)}`);
    const shot = path.join(OUT, role, `${String(idx).padStart(2, '0')}${route.replace(/[/?=&]+/g, '_')}.jpg`);
    await page.screenshot({ path: shot, type: 'jpeg', quality: 55 });
    return { role, route, status: probe.denied ? 'denied' : issues.length ? 'fail' : 'ok', issues, shot };
  } finally {
    page.off('console', onConsole); page.off('pageerror', onError); page.off('response', onResp);
  }
}

for (const [role, routes] of Object.entries(ROLES)) {
  if (pick.length && !pick.includes(role)) continue;
  test(`巡檢 ${role}（${routes.length} 頁）`, async ({ browser }) => {
    test.setTimeout(routes.length * 40_000 + 60_000);
    fs.mkdirSync(path.join(OUT, role), { recursive: true });
    const { ctx, page } = await userPage(browser, role);
    await useProject(page, P1);
    const rows: Row[] = [];
    for (const [i, r] of routes.entries()) {
      try {
        rows.push(await check(page, role, r, i));
      } catch (e) {
        rows.push({ role, route: r, status: 'fail', issues: [`例外: ${String(e).slice(0, 160)}`], shot: '' });
      }
    }
    const tsv = rows.map((r) => [r.role, r.route, r.status, r.issues.join(' ; ')].join('\t')).join('\n');
    fs.writeFileSync(path.join(OUT, `${role}.tsv`), `角色\t路徑\t結果\t問題\n${tsv}\n`);
    const bad = rows.filter((r) => r.status === 'fail');
    console.log(`[巡檢] ${role}: ok ${rows.filter((r) => r.status === 'ok').length} / denied ${rows.filter((r) => r.status === 'denied').length} / fail ${bad.length}`);
    await ctx.close();
  });
}
