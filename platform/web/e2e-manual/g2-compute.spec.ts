import { expect, test } from '@playwright/test';
import { sideNav } from '../e2e-acceptance/helpers';
import { psql } from '../e2e-acceptance/ops';
import { startScenario } from './kit';
import { FHIR_PROJECT, ensureFhirProject } from './ops-common';

// G2 管算力與排隊（admin01）：GPU 使用對照 → 建立 GPU 群組並指派給示範專案 → 排隊順序與共享設定（只看不改）→ 節點。
// 不動其他人的工作：排隊順序、共享設定只說明不套用（共享設定儲存會重新設定 GPU 時間片）。
const GROUP = '手冊-示範群組';

test('G2 管算力與排隊', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const pid = ensureFhirProject();
  // 上一輪殘留：解除示範專案的群組綁定、刪除示範群組（只動示範資料）
  psql(`update projects set gpu_group=null where id=${pid}; delete from gpu_groups where name='${GROUP}'`);

  const s = await startScenario(browser, { id: 'G2', title: '管算力與排隊', role: 'admin01', manual: '01-系統管理者' });
  const p = s.page;
  s.section('目的', '掌握 GPU 正被哪個專案、哪件工作使用；把 GPU 分群後指派給專案；必要時調整等待中工作的先後，並設定共享 GPU 的使用規則。');
  s.section(
    '開始前準備',
    [
      '- 使用系統管理者帳號登入。',
      `- 決定要把哪一組 GPU 給哪個專案。本節建立群組「${GROUP}」並指派給專案「${FHIR_PROJECT}」。`,
      '- 調整排隊順序前，先和相關研究人員確認；執行中的工作不會被中斷。',
    ].join('\n'),
  );

  await p.goto('/admin');
  await p.waitForLoadState('networkidle').catch(() => undefined);
  await s.step('按左側選單的「運算資源」', sideNav(p).getByRole('link', { name: '運算資源', exact: true }), 'click');
  await expect(p.getByRole('list', { name: 'GPU 使用狀況' })).toBeVisible();
  await s.step('每張 GPU 顯示使用中或閒置', p.getByRole('list', { name: 'GPU 使用狀況' }), undefined, { zoom: false });
  await s.step('下方列出執行中工作的專案與使用者', p.getByRole('table', { name: '執行中的 GPU 工作' }), undefined, {
    zoom: false,
    detail: '表格列出每件執行中工作所在的節點、GPU、專案、工作編號、訓練編號與使用者。',
  });

  // GPU 群組
  const tabs = p.getByRole('navigation', { name: '運算資源分頁' });
  await s.step('按「GPU 群組」分頁', tabs.getByRole('link', { name: 'GPU 群組' }), 'click');
  await expect(p.getByRole('table', { name: 'GPU 群組列表' })).toBeVisible();
  const form = p.getByRole('form', { name: '新增 GPU 群組' });
  await s.step(`在「群組名稱」輸入 ${GROUP}`, form.getByLabel('群組名稱（必填）'), { fill: GROUP });
  await s.step('「GPU 池」選擇共享池', form.getByLabel('GPU 池'), { select: 'gpu-shared' }, {
    detail: '獨占池一件工作使用一整張卡；共享池以時間片讓多件工作輪流使用同一張卡。',
  });
  await s.step('「GPU 數量」輸入 1', form.getByLabel('GPU 數量'), { fill: '1' });
  await s.step('按「新增群組」', form.getByRole('button', { name: '新增群組' }), 'click');
  await expect(p.getByText(`已新增 GPU 群組「${GROUP}」`)).toBeVisible();
  await s.step('「GPU 群組」清單出現新群組', p.getByRole('table', { name: 'GPU 群組列表' }).getByRole('row', { name: new RegExp(GROUP) }), undefined, { zoom: false });

  // 指派給專案
  await s.step('按左側選單的「專案」', sideNav(p).getByRole('link', { name: '專案', exact: true }), 'click');
  await s.step(`按專案「${FHIR_PROJECT}」`, p.getByRole('table', { name: '專案列表' }).getByRole('link', { name: FHIR_PROJECT, exact: true }), 'click');
  const basic = p.getByRole('form', { name: '基本資料與 GPU 群組' });
  await s.step(`「GPU 群組」選擇 ${GROUP}`, basic.getByLabel('GPU 群組'), { select: GROUP });
  await s.step('按「儲存」', basic.getByRole('button', { name: '儲存' }), 'click');
  await expect(p.getByText(`已更新專案「${FHIR_PROJECT}」`)).toBeVisible();
  await s.note('專案的訓練工作會排進這個群組的佇列');

  // 排隊順序與共享設定（只說明）
  await s.step('回到「運算資源」', sideNav(p).getByRole('link', { name: '運算資源', exact: true }), 'click');
  await s.step('按「排隊順序」分頁', tabs.getByRole('link', { name: '排隊順序' }), 'click');
  await expect(p.getByRole('heading', { level: 1, name: '排隊與共享設定' })).toBeVisible();
  await s.step('每個佇列顯示執行中與等待中的工作', p.locator('.sch-board'), undefined, {
    zoom: false,
    detail: '等待中的工作右側有 ↑、↓ 可調整先後，調好後按該佇列的「套用順序」；按「暫存」可先移出佇列，之後「恢復排隊」會排到最後。執行中的工作顯示「不可移動」。',
  });
  await s.step('右側「共享排程設定」設定共享規則', p.getByRole('form', { name: '修改共享排程設定' }), undefined, {
    detail: '「時間片份數」是一張共享 GPU 同時可排入的工作數；「工作時限」是單一工作最多可執行的分鐘數。改完按「儲存共享設定」。只影響共享池。',
  });

  // 節點
  await s.step('按「節點」分頁', tabs.getByRole('link', { name: '節點' }), 'click');
  await expect(p.getByRole('table', { name: '叢集節點列表' })).toBeVisible();
  await s.note('列出叢集節點、用途與就緒狀態');

  s.section(
    '完成後的樣子',
    `「GPU 群組」清單有「${GROUP}」，專案「${FHIR_PROJECT}」的基本資料顯示這個群組；之後這個專案送出的訓練會進入共享池的佇列。「GPU 使用對照」隨時可看哪張卡正被哪個專案、哪個人使用。`,
  );
  s.section(
    '常見問題',
    [
      '- 刪除群組時出現「GPU 群組「…」仍綁定專案：…」：先到該專案把「GPU 群組」改成「不綁定」再刪除。',
      '- 佇列顯示「這個佇列沒有進行中的工作。」：目前沒有工作在排隊，不需要調整。',
      '- 調整順序後出現「順序已調整，尚未套用。」：要按「套用順序」才會生效；按「還原」放棄調整。',
      '- 「套用順序」只會調整等待中的工作，不會影響正在執行的工作。',
      '- 新增伺服器：節點清單直接讀取叢集，新伺服器加入叢集後會自動出現在「節點」分頁，不需另外設定。',
    ].join('\n'),
  );
  await s.finish();
});
