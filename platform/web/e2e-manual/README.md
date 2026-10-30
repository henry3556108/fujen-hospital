# e2e-manual：結案操作手冊與教學影片

一個情境寫一支 spec。每一步同時產出手冊截圖（紅框）＋Markdown 步驟，以及影片時間軸（字幕就是同一句話）。

## 寫法

```ts
import { test } from '@playwright/test';
import { startScenario } from './kit';

test('B6 送訓練', async ({ browser }) => {
  const s = await startScenario(browser, { id: 'B6', title: '送出訓練', role: 'pi01', manual: '02-計畫主持人', project: 'P1-lung-ct' });
  const p = s.page;
  s.section('目的', '用標註好的影像訓練模型。');
  s.section('開始前準備', '專案裡已有完成標註的影像。');
  await s.step('按左側選單的「建立模型」', p.getByRole('link', { name: '建立模型' }), 'click');
  await s.step('在「名稱」欄輸入 手冊-肺結節', p.getByLabel('名稱'), { fill: '手冊-肺結節' });
  await s.wait('等待訓練完成', () => expect(p.getByText('已完成')).toBeVisible({ timeout: 600_000 }));
  await s.note('畫面顯示訓練結果');
  s.section('完成後的樣子', '…');
  s.section('常見問題', '…');
  await s.finish();
});
```

| API | 說明 |
|---|---|
| `startScenario(browser, { id, title, role, manual, project?, login?, video? })` | 開新的瀏覽器環境（錄影 1440×900）、注入假游標與點擊漣漪。預設在鏡頭外登入 `role`（`project` 有給就切過去）；這段不會進影片。`login: false` 時自己呼叫 `s.login()`，登入過程會錄成步驟。 |
| `s.step(caption, locator, action?, { detail?, zoom?, settle? })` | 游標滑到元素 → 紅框 → 截圖 → 執行動作 → 移除紅框。`action`：`'click'`、`{ fill }`、`{ select }`、`{ upload }`（可傳按鈕，會接檔案選擇視窗）、`{ hover: true }`、`{ press }`，省略就只指出元素。`detail` 只寫進手冊。`zoom: false` 影片不放大（目標很大時）。 |
| `s.note(caption)` | 整頁截圖、不加框、影片不放大，例如「畫面顯示專案首頁」。 |
| `s.wait(caption, fn)` | 等待類（上傳、訓練、載入）。影片中過長會自動加速並標「加速 ×N」。完成後截一張圖當一步（`{ manual: false }` 不進手冊）。 |
| `s.section(heading, text)` | 手冊文字：目的、開始前準備、完成後的樣子、常見問題。依呼叫順序排在步驟前後。 |
| `s.login()` | 鏡頭前登入（4 步）。 |
| `s.finish()` | 寫出片段、時間軸，存影片。 |
| `s.page`、`s.ctx` | 一般 Playwright 操作與檢查（`expect`）照用，不會進手冊；段與段之間的空檔在影片裡會剪掉。 |

字幕規則：一句短句（30 字內），寫使用者看到什麼、點哪裡，按鈕文字加「」。超過 30 字會在終端機警告。
要等很久的檢查（例如 `expect(...).toBeVisible({ timeout: 600_000 })`）請包在 `s.wait` 裡，否則影片會跳一段。

## 產出（根目錄 `結案-操作手冊與影片\`，WSL `/mnt/c/Users/skyland/Desktop/workspace/結案-操作手冊與影片`，可用 `MANUAL_ROOT` 改）

| 檔案 | 內容 |
|---|---|
| `手冊/img/<manual>/<id>-<nn>.jpg` | 每步截圖（JPEG q80，1440×900） |
| `手冊/md/片段/<manual>/<id>.md` | `## 標題`、`### 段落`、編號步驟各附 `![](../../img/...)` |
| `審片/時間軸/<id>.json` | `{id,title,role,roleLabel,manual,video,size,segments:[{kind,t0,t1,bbox,zoom,caption,shot}]}`，秒數從錄影開始算 |
| `影片/原始/<id>.webm` | 原始錄影（含鏡頭外登入，後製會剪掉） |

## 執行與後製

腳本在 `scratchpad\manual\K\`：`run.sh <spec> [--root dir]` 跑一支（開視窗，各用自己的 `--output`），`post.sh <id> [--root dir]` 做片段與縮圖總覽。
其餘在 `結案-操作手冊與影片\腳本\post\`：`assemble.py <影片名> <id...>` 剪成一部、`md2docx.py <manual>` 轉 Word。各檔開頭有用法。
