import { expect, test } from '@playwright/test';
import { sideNav } from '../e2e-acceptance/helpers';
import { startScenario } from './kit';

// G3 看系統狀態、處理告警（admin01）：系統監控頁 → Grafana 平台叢集總覽 → Prometheus 告警規則 → Alertmanager 告警 → Mailpit 告警信。
// 只看不觸發告警（平台介面沒有「測試告警」功能）。監控工具在新分頁開啟，錄影時改在同一分頁開，畫面相同。
const GRAFANA = process.env.GRAFANA_URL || 'http://127.0.0.1:33000';
const GRAFANA_PW = process.env.GRAFANA_PASSWORD || 'Grafana-dev-01!';
const PROM = 'http://127.0.0.1:39090';
const AM = 'http://127.0.0.1:39093';
const MAILPIT = 'http://127.0.0.1:38025';

test('G3 看系統狀態、處理告警', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const s = await startScenario(browser, { id: 'G3', title: '看系統狀態、處理告警', role: 'admin01', manual: '01-系統管理者' });
  const p = s.page;
  s.section('目的', '每天確認平台是否正常：看節點、GPU、CPU、記憶體狀態；收到告警時知道是什麼問題、從哪裡處理。');
  s.section(
    '開始前準備',
    [
      '- 使用系統管理者帳號登入。',
      '- 監控工具各有自己的帳號：Grafana 需另外登入（帳號向資訊室取得），Prometheus、Alertmanager、Mailpit 在院內網路直接開啟。',
    ].join('\n'),
  );

  await p.goto('/admin');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.step('按左側選單的「系統監控」', sideNav(p).getByRole('link', { name: '系統監控', exact: true }), 'click');
  await expect(p.getByRole('heading', { level: 1, name: '系統監控' })).toBeVisible();
  const tiles = p.locator('[aria-label="叢集狀態"]');
  await expect(tiles).toBeVisible();
  await s.step('上方顯示節點與 GPU 的即時狀態', tiles, undefined, { zoom: false });
  const tools = p.getByRole('list', { name: '監控工具' });
  await s.step('「監控工具」列出四個工具', tools, undefined, { zoom: false, detail: '每個工具都在新分頁開啟。' });

  // Grafana
  await s.step('在「Grafana」按「開啟」', tools.getByRole('link', { name: /^Grafana/ }), undefined);
  await p.goto(GRAFANA);
  await p.waitForLoadState('load');
  if (/\/login/.test(p.url())) {
    await s.step('輸入 Grafana 帳號', p.locator('input[name="user"]'), { fill: 'admin' });
    await s.step('輸入 Grafana 密碼', p.locator('input[name="password"]'), { fill: GRAFANA_PW });
    await s.step('按「Log in」', p.getByRole('button', { name: /^Log in$/ }), 'click');
    await p.getByRole('button', { name: /^Skip$/ }).click({ timeout: 3000 }).catch(() => undefined);
    await expect(p).not.toHaveURL(/\/login/);
  }
  await p.goto(`${GRAFANA}/dashboards`);
  await p.waitForLoadState('load');
  await s.step('在 Dashboards 按資料夾「平台」', p.getByRole('link', { name: '平台', exact: true }).first(), 'click');
  await s.step('按「平台叢集總覽」', p.getByRole('link', { name: '平台叢集總覽' }).first(), 'click');
  await p.waitForTimeout(4000);
  await s.note('儀表板顯示各節點池 CPU、GPU 使用', {
    detail: '右上角可調整時間範圍與自動更新頻率；按「Edit」可新增圖表、選資料來源與圖表類型。',
    hold: 1500,
  });

  // Prometheus 告警規則
  await p.goto(`${PROM}/alerts`);
  await p.waitForTimeout(2500);
  await s.note('Prometheus「Alerts」列出告警規則', {
    detail: '每條規則顯示目前是否觸發（Firing）、等待中（Pending）或正常（Inactive）。',
    hold: 1500,
  });

  // Alertmanager
  await p.goto(`${AM}/#/alerts`);
  await p.waitForTimeout(2500);
  await s.note('Alertmanager 列出目前發生中的告警', {
    detail: '告警依類別分組；沒有告警時顯示「No alert groups found」。按告警旁的「Silence」可在處理期間暫停重複通知。',
    hold: 1500,
  });
  await p.goto(`${AM}/#/status`);
  await p.waitForTimeout(2500);
  await s.note('「Status」頁可查看分類、抑制與通知設定', {
    detail: '頁面下方的設定內容列出告警分類路由（route）、重複告警抑制（inhibit_rules、repeat_interval）與通知管道（receivers，例如 Email）。修改設定請由資訊室依維運文件進行。',
    hold: 1500,
  });

  // Mailpit
  await p.goto(MAILPIT);
  await p.waitForTimeout(2500);
  await s.note('告警信寄到通知信箱（此為測試收件匣）', {
    detail: '信件主旨含告警名稱，內容說明發生的節點或工作。正式環境寄到資訊室的 Email。',
    hold: 1500,
  });

  s.section(
    '完成後的樣子',
    '平台「系統監控」頁可以看到節點與 GPU 狀態；Grafana 儀表板顯示 CPU、記憶體、GPU 的即時曲線；有告警時 Alertmanager 列出告警並寄出通知信。',
  );
  s.section(
    '常見問題',
    [
      '- 按監控工具後要求登入：工具使用自己的帳號，與平台帳號分開（頁面註明「在新分頁開啟，需使用各工具自己的帳號登入」）。',
      '- 收到「工作失敗」類告警：到「運算資源」的「GPU 使用對照」或「總覽」的「失敗工作」查看是哪個專案、哪件工作。',
      '- 收到「節點失聯」類告警：到「運算資源」的「節點」分頁看哪個節點顯示「未就緒」，通知資訊室檢查伺服器。',
      '- 同一個問題一直收到信：在 Alertmanager 對該告警按「Silence」暫停通知，處理完再解除。',
      '- 平台介面沒有「測試告警」按鈕；要測試通知管道請由資訊室依維運文件操作。',
    ].join('\n'),
  );
  await s.finish();
});
