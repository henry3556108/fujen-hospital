import { expect, test } from '@playwright/test';
import { sideNav } from '../e2e-acceptance/helpers';
import { psql } from '../e2e-acceptance/ops';
import { startScenario } from './kit';
import { FHIR_PROJECT, ensureFhirProject, fhirBurst } from './ops-common';

// F2 查詢與檢查轉出的資料（admin01）：資源筆數、依病歷號查詢、關聯圖、流量告警、Gateway 門檻。
// 需先跑 F1（示範租戶已有 Patient、Encounter、Observation）。流量告警由鏡頭外模擬外部系統大量查詢觸發（只讀）。
const MRN = 'SYN-42-0001';

test('F2 查詢與檢查轉出的資料', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const pid = ensureFhirProject();
  expect(Number(psql(`select count(*) from fhir_runs where project_id=${pid} and status='succeeded'`))).toBeGreaterThan(0);
  psql(`delete from fhir_traffic_alerts where project_id=${pid}`);

  const s = await startScenario(browser, { id: 'F2', title: '查詢與檢查轉出的資料', role: 'admin01', manual: '01-系統管理者' });
  const p = s.page;
  s.section('目的', '確認轉出的 FHIR 資料是否正確：看各類資源筆數、依病歷號查一位病人的所有資料與關聯，並檢查外部系統的存取流量與告警。');
  s.section('開始前準備', `已完成上一節的轉換，「${FHIR_PROJECT}」租戶內已有 Patient、Encounter、Observation 資料。準備一個要查詢的病歷號，本節用 ${MRN}。`);

  await p.goto('/admin');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.step('按左側選單的「資料交換」', sideNav(p).getByRole('link', { name: '資料交換', exact: true }), 'click');
  const tenant = p.locator('#fhir-tenant');
  if ((await tenant.locator('option:checked').innerText()).trim() !== FHIR_PROJECT) {
    await s.step(`在「租戶專案」選擇 ${FHIR_PROJECT}`, tenant, { select: { label: FHIR_PROJECT } });
  }
  await expect(p.getByText(`目前租戶：${FHIR_PROJECT}`)).toBeVisible();
  const stats = p.getByRole('list', { name: '資源筆數' });
  await expect(stats).not.toContainText('…');
  await s.step('上方顯示各類資源的筆數', stats, undefined, { detail: 'Patient、Encounter、Observation 分別是病人、就醫紀錄、檢驗觀察值。' });
  await s.step('按「Encounter」看就醫紀錄清單', p.getByRole('tab', { name: 'Encounter' }), 'click');
  await expect(p.getByRole('table', { name: 'Encounter 列表' })).toBeVisible();
  await s.note('列表顯示資源編號、識別碼與摘要');

  // 依病歷號查詢
  await s.step(`在「病歷號」輸入 ${MRN}`, p.locator('#fhir-patient'), { fill: MRN });
  await s.step('按「查詢資源」', p.getByRole('button', { name: '查詢資源' }), 'click');
  const tree = p.getByRole('group', { name: `病人 ${MRN} 的資源關聯` });
  await expect(p.getByRole('table', { name: `病人 ${MRN} 的資源` })).toBeVisible();
  await s.step('列出這位病人的所有 FHIR 資源', p.getByRole('table', { name: `病人 ${MRN} 的資源` }), undefined, { zoom: false });
  await s.step('「病人關聯圖」顯示各類資源筆數', tree, undefined, { detail: 'Patient 在上，下方是這位病人的 Encounter 與 Observation 筆數。' });

  // 完整關聯圖
  await s.step('按「查看完整關聯圖」', p.getByRole('link', { name: /查看完整關聯圖/ }), 'click');
  await expect(p.getByRole('heading', { level: 1, name: 'FHIR 關聯圖' })).toBeVisible();
  await s.step(`在「病歷號」輸入 ${MRN}`, p.locator('#graph-patient'), { fill: MRN });
  await s.step('按「顯示關聯圖」', p.getByRole('button', { name: '顯示關聯圖' }), 'click');
  await expect(p.getByTestId('fhir-graph')).toBeVisible();
  await s.step('圖上以病人為中心連到就醫與檢驗', p.getByTestId('fhir-graph'), undefined, { detail: '不同顏色代表不同資源類型，圖例在圖的上方。' });
  await s.step('「關聯清單」列出每筆資源的參照', p.getByRole('table', { name: '關聯清單' }), undefined, { zoom: false });

  // 流量告警：鏡頭外模擬外部系統在 1 分鐘內查詢 140 次（門檻 120）
  const codes = fhirBurst(pid, 140);
  console.log(`[F2] 模擬查詢：${codes.replace(/\n/g, '、')}`);
  await expect.poll(() => Number(psql(`select count(*) from fhir_traffic_alerts where project_id=${pid}`)), { timeout: 30_000 }).toBeGreaterThan(0);

  const tabs = p.getByRole('navigation', { name: 'FHIR 分頁' });
  await s.step('按「流量告警」分頁', tabs.getByRole('link', { name: '流量告警' }), 'click');
  await expect(p.getByRole('heading', { level: 1, name: 'FHIR 流量告警' })).toBeVisible();
  const table = p.getByRole('table', { name: '流量告警' });
  await expect(table.getByRole('row')).not.toHaveCount(1);
  await s.step('「告警紀錄」列出超過門檻的使用者', table, undefined, {
    detail: '同一使用者在這個租戶 60 秒內的 FHIR 請求數超過門檻時，會建立一筆告警並寄信通知。',
  });
  await s.step('在「使用者」選擇 admin01', p.locator('#alert-actor'), { select: 'admin01' });
  await s.step('按「查詢」', p.getByRole('form', { name: '篩選流量告警' }).getByRole('button', { name: '查詢' }), 'click');
  await s.step('按告警右側的箭頭看詳情', table.getByRole('button', { name: /的告警詳情$/ }).first(), 'click');
  await expect(p.getByText('流量告警詳情')).toBeVisible();
  await s.note('右側顯示請求數、門檻與通知狀態');

  // 門檻設定（只看不改：全平台設定）
  await s.step('按「調整告警門檻」', p.getByRole('link', { name: '調整告警門檻' }), 'click');
  await expect(p.getByRole('heading', { level: 1, name: 'Gateway 路由與流量門檻' })).toBeVisible();
  await s.step('「路由清單」列出各 API 路由', p.getByRole('table', { name: 'Gateway 路由' }), undefined, { zoom: false });
  await s.step('門檻在「每人每分鐘門檻」修改', p.locator('#route-threshold'), undefined, {
    detail: '改完按「儲存路由設定」。這是全平台設定，會影響所有專案，修改前請先確認。',
  });

  s.section(
    '完成後的樣子',
    `「資源」分頁可以看到各類資源筆數與清單；輸入病歷號可查到該病人的所有資料與關聯圖。「流量告警」列出存取量超過門檻的紀錄，點開可看請求數、門檻與通知狀態。`,
  );
  s.section(
    '常見問題',
    [
      '- 查詢後顯示「找不到 Patient 資源。」：這個租戶沒有該病歷號的病人，請確認上方「租戶專案」是否選對、病歷號是否正確。',
      '- 列表顯示「這個租戶還沒有 Encounter」等字樣：該類資料尚未轉換，回到「來源與對應」執行轉換。',
      '- 資料很多時顯示「資源太多，只顯示每種型別的前 200 筆。」：改用病歷號查詢單一病人。',
      '- 告警清單顯示「沒有流量告警」：表示沒有使用者超過門檻。同一使用者同一分鐘只通知一次。',
      '- 「Gateway 路由」是全平台設定，不需選專案；由部署設定檔控制的路由顯示「這條路由由部署設定檔控制，要改設定檔後重新部署，這裡不能修改。」',
    ].join('\n'),
  );
  await s.finish();
});
