# C-01 多台 GPU／CPU 伺服器管理：驗收操作劇本

> 網頁步驟已於 2026-10-03 在乙方開發環境（kind 叢集 `ai-platform`、假 GPU）逐步操作驗證，截圖在 `shots/<TC-ID>/`。
> 平台更新到 integration/wp5-8（1421f98 之後）後，同日 21:40–21:57 UTC 重新驗證 TC-C01-01、02、03、04、05、08（文字與截圖已更新）；TC-C01-06 與 TC-C01-07 沿用第一次演練（19:00 前）的結果，本次未重跑。數字以開發環境為例；甲方環境的節點名稱、GPU 數量不同，見每項的「開發環境與甲方環境的差異」。

## 共同前置條件

1. 平台已部署並可登入（開發環境：網頁 http://localhost:38982，Gateway http://localhost:38980）。
2. 操作電腦可執行 `kubectl`，context 指向平台叢集（開發環境：`kind-ai-platform`）。以下指令省略 `--context`。
3. 叢集內沒有其他人的工作在跑（佇列順序與 GPU Dashboard 會被別人的工作影響）：`kubectl -n platform-jobs get pods --field-selector=status.phase=Running` 應無輸出。
4. 「排程與叢集」各頁的進入方式：以 `admin01` 登入 → 左側「帳號管理」（上方分頁為「Dashboard 總覽｜Account 帳號｜專案｜專案成員｜標註群組｜稽核紀錄｜共享排程設定｜資料交換（FHIR）」）→ 上方分頁「共享排程設定」→ 頁內分頁「共享排程設定｜GPU 群組｜叢集節點｜GPU Dashboard｜監控儀表板」。
5. 「專案工作」頁的進入方式：右上「目前專案」選專案 → 左側「建模管理」→ 卡片「專案工作」（網址 `/training/jobs`）。
6. 網頁閒置一段時間（演練時約 10–15 分鐘）會回到登入頁，點「登入」重新登入即可，已送出的工作不受影響。

**本劇本建立的物件（驗收後清除，見文末）**：GPU 群組 `KIT-C-high`、`KIT-C-low`；專案 `KIT-C-p1`、`KIT-C-p2`、`KIT-C-p3`。正式驗收時可改用甲方同意的名稱。

---

## TC-C01-01 節點納管

**合約指標**：「多節點納管：GPU 伺服器與 CPU 伺服器一起管理」，**節點差異 0**。

**前置條件**：共同前置條件 1、2、4。

**使用資料或帳號**：`admin01`（開發環境密碼 `Admin01-dev!`）。

**操作步驟**

1. 以 `admin01` 登入，點左側「帳號管理」。
2. 點上方分頁「共享排程設定」，再點頁內分頁「叢集節點」。
3. 截圖整頁。
4. 在操作電腦執行：
   ```bash
   kubectl get nodes -L platform/pool -o custom-columns='節點:.metadata.name,池:.metadata.labels.platform/pool,就緒:.status.conditions[?(@.type=="Ready")].status,GPU份數:.status.capacity.nvidia\.com/gpu,實體GPU:.metadata.labels.platform/gpu-physical' | tee C01-01-kubectl.txt
   ```
5. 逐列比對網頁表格與 kubectl 輸出：節點名稱、節點池、狀態、實體 GPU、GPU 份數。

**預期結果**（`shots/TC-C01-01/01-叢集節點.png`）

- 上方 4 格（同一高度對齊）：節點數 `5`、就緒節點 `5`、實體 GPU `3`、可排程 GPU 份數 `6`。
- 表格 5 列：

  | 節點 | 節點池 | 用途 | 狀態 | 實體 GPU | GPU 份數 | 可分配 |
  |---|---|---|---|---|---|---|
  | ai-platform-control-plane | — | 控制平面 | 就緒 | 0 | 0 | 0 |
  | ai-platform-worker | cpu-web | 網頁服務 | 就緒 | 0 | 0 | 0 |
  | ai-platform-worker2 | cpu-data | 資料清洗 | 就緒 | 0 | 0 | 0 |
  | ai-platform-worker3 | gpu-exclusive | GPU 獨占 | 就緒 | 2 | 2 | 2 |
  | ai-platform-worker4 | gpu-shared | GPU 共享 | 就緒 | 1 | 4 | 4 |

- kubectl 輸出同樣 5 個節點，池、GPU 份數、實體 GPU 一致。差異 0。

**留存證據**：網頁截圖；`C01-01-kubectl.txt`；比對表（一列一節點，「一致」欄）。

**若結果不符**：網頁少節點或顯示錯誤訊息時，查平台 API 讀 Node 的權限：`kubectl auth can-i list nodes --as=system:serviceaccount:ai-platform:platform-api`；節點池顯示「—」表示節點沒有 `platform/pool` 標籤。

**開發環境與甲方環境的差異**：開發環境 5 個 kind 節點、假 GPU（worker3 2 張獨占、worker4 1 張切 4 份）；甲方依實際主機與 GPU 數。

---

## TC-C01-02 GPU 群組

**合約指標**：「GPU 群組：建立 2 個群組，依等級分群」，**重新載入一致 100%**。

> **已知缺口**：「依等級分群」尚未實作。目前群組只有「群組名稱、GPU 池（獨占／共享）、模式、GPU 數量」，沒有 GPU 等級（例如 H100／A100、或高／低階）欄位，也無法依 GPU 型號分群。現場暫以「GPU 池」區分（獨占池＝高階、整張卡；共享池＝低階、時間片），並以群組名稱標示等級，須事先向甲方說明；功能補上後更新本步驟。

**前置條件**：共同前置條件 1、4。

**使用資料或帳號**：`admin01`。

**操作步驟**

1. 進入「GPU 群組」分頁（共同前置條件 4）。
2. 在「新增 GPU 群組」區塊：「群組名稱（必填）」輸入 `KIT-C-high`；「GPU 池」選 `獨占池（gpu-exclusive）`；「GPU 數量」輸入 `2`。
3. 點「新增群組」。
4. 「群組名稱（必填）」輸入 `KIT-C-low`；「GPU 池」選 `共享池（gpu-shared）`；「GPU 數量」輸入 `1`。
5. 點「新增群組」。
6. 按瀏覽器的重新整理（F5）。
7. 截圖群組列表。
8. （比對後端）執行：
   ```bash
   TOKEN=$(curl -s http://localhost:38180/realms/ai-platform/protocol/openid-connect/token -d grant_type=password -d client_id=ai-platform-web -d username=admin01 --data-urlencode 'password=Admin01-dev!' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
   curl -s -H "Authorization: Bearer $TOKEN" http://localhost:38980/api/admin/gpu-groups | python3 -m json.tool | tee C01-02-api.txt
   ```
   （甲方環境 Keycloak 關閉密碼授權，改以瀏覽器開發者工具「Network」查看 `gpu-groups` 回應，或省略本步。）

**預期結果**（`shots/TC-C01-02/01-重新載入後群組列表.png`）

- 步驟 3、5 後頁面上方出現綠色「完成：已新增 GPU 群組「KIT-C-high」」、「完成：已新增 GPU 群組「KIT-C-low」」。
- 重新整理後列表 4 列，與新增時相同：

  | 群組名稱 | GPU 池 | 模式 | GPU 數量 | 佇列 |
  |---|---|---|---|---|
  | gpu-exclusive | gpu-exclusive | 獨占 | 2 | gpu-exclusive |
  | gpu-shared | gpu-shared | 共享（時間片） | 1 | gpu-shared |
  | KIT-C-high | gpu-exclusive | 獨占 | 2 | gpu-exclusive |
  | KIT-C-low | gpu-shared | 共享（時間片） | 1 | gpu-shared |

- 步驟 8 的 JSON 與畫面一致（`"name": "KIT-C-high", "pool": "gpu-exclusive", "gpu_count": 2, "mode": "exclusive", "queue": "gpu-exclusive"` 等）。一致 100%。

**留存證據**：新增成功訊息截圖 2 張、重新整理後列表截圖；`C01-02-api.txt`。

**若結果不符**：新增時出現紅色錯誤「群組名稱」已存在：換名稱或先刪除舊群組；重新整理後消失：平台 API 資料庫未保存，查 `kubectl -n ai-platform logs deploy/api --tail=50`。

**開發環境與甲方環境的差異**：GPU 數量上限依甲方實際 GPU 數；預設群組 `gpu-exclusive`、`gpu-shared` 由部署建立，不可刪除或改名。

---

## TC-C01-03 專案綁定群組

**合約指標**：「專案指定 GPU 群組：建立專案時選擇用哪一群 GPU 訓練」，**3 次，綁定差異 0**；測試案例另要求「Job 進入該群組的佇列」。

**前置條件**：TC-C01-02 已建立 `KIT-C-high`、`KIT-C-low`。

**使用資料或帳號**：`admin01`。

**操作步驟**

1. 左側「帳號管理」→ 分頁「專案」。
2. 在「新增專案」區塊：「專案名稱（必填）」輸入 `KIT-C-p1`；「說明」輸入 `M1 驗收：C-01 專案綁定群組`；「GPU 群組」選 `KIT-C-high（獨占，2 張）`；點「新增專案」。
3. 同上建立 `KIT-C-p2`，「GPU 群組」選 `KIT-C-low（共享，1 張）`。
4. 同上建立 `KIT-C-p3`，「GPU 群組」選 `KIT-C-high（獨占，2 張）`。
5. 按 F5 重新整理，截圖專案列表。
6. 右上「目前專案」選 `KIT-C-p1` → 左側「建模管理」→ 卡片「專案工作」。
7. 「工作種類」選 `訓練（GPU）`，「執行秒數（1–3600）」輸入 `60`，點「送出工作」。
8. 右上「目前專案」改選 `KIT-C-p2`，重複步驟 7。
9. 右上「目前專案」改選 `KIT-C-p3`，重複步驟 7。
10. 執行（比對 Kubernetes Job 與 Kueue 佇列）：
    ```bash
    kubectl -n platform-jobs get jobs -L kueue.x-k8s.io/queue-name,platform/project-id,platform/job-id,platform/user --sort-by=.metadata.creationTimestamp | tail -3 | tee C01-03-jobs.txt
    kubectl -n platform-jobs get workloads -o custom-columns='WORKLOAD:.metadata.name,佇列:.spec.queueName,放行至:.status.admission.clusterQueue,JOB:.metadata.ownerReferences[0].name' | tail -3 | tee C01-03-workloads.txt
    ```

**預期結果**（`shots/TC-C01-03/01-專案與GPU群組.png`、`02-專案工作佇列.png`）

- 步驟 2–4 各出現「完成：已新增專案「KIT-C-p1」」等訊息；專案列表「GPU 群組」欄：`KIT-C-p1 → KIT-C-high`、`KIT-C-p2 → KIT-C-low`、`KIT-C-p3 → KIT-C-high`。
- 步驟 7–9 各出現「完成：已送出工作 <編號>，進入佇列 gpu-exclusive」（p2 為 `gpu-shared`）；工作列表該列「GPU 群組」＝專案綁定的群組、「佇列」＝群組的 GPU 池。
- 步驟 10（開發環境實測）：
  ```text
  job-67-964143   ... gpu-exclusive   42   67   admin01
  job-68-469626   ... gpu-shared      43   68   admin01
  job-69-38ed07   ... gpu-exclusive   44   69   admin01
  WORKLOAD                  佇列            放行至          JOB
  job-job-67-964143-0af86   gpu-exclusive   gpu-exclusive   job-67-964143
  job-job-68-469626-d637a   gpu-shared      gpu-shared      job-68-469626
  job-job-69-38ed07-1bf57   gpu-exclusive   gpu-exclusive   job-69-38ed07
  ```
  3 次綁定差異 0，Job 都進入該群組的佇列並由同名 ClusterQueue 放行。

**留存證據**：專案列表截圖、3 個專案的「專案工作」截圖；`C01-03-jobs.txt`、`C01-03-workloads.txt`。

**若結果不符**

- 「GPU 群組」選單沒有新群組：在專案頁按 F5 重新載入。
- 送出時錯誤「排程服務尚未設定」（503）：平台 API 沒有連到叢集（`JOB_BACKEND` 不是 `kubernetes`）。
- Job 一直「排隊中」：同池 GPU 被其他工作占用；`kubectl get clusterqueues` 看 PENDING WORKLOADS。

**開發環境與甲方環境的差異**：專案編號（開發環境重測時為 76–78）與工作編號依環境不同；甲方 GPU 為真實卡。

---

## TC-C01-04 GPU Dashboard

**合約指標**：「GPU Dashboard：每張 GPU 顯示 Project ID、Training ID、使用者」，**抽查 3 組，差異 0**。

**前置條件**：TC-C01-03 已建立 3 個專案；把 3 個不同帳號加入 3 個專案（使用者欄才會不同）：左側「帳號管理」→ 分頁「專案成員」→ 上方「專案」選 `KIT-C-p1`（下方列出該專案目前成員）→ 在「新增或調整成員」區塊選「帳號」`ra01`、「角色」`Research Assistant` → 點「加入專案」；同法 `KIT-C-p2`／`ca01`／`Coder Assistant`、`KIT-C-p3`／`pi01`／`Principal Investigator`。出現「完成：已將「ra01」設定為「KIT-C-p1」的 Research Assistant（權限：Project、Labeling、Training、Prediction）」等訊息，成員列表多一列。

**使用資料或帳號**：`ra01`、`ca01`、`pi01`（開發環境密碼 `Dev-Passw0rd!`），各用一個瀏覽器視窗（或無痕視窗）登入；`admin01` 看 Dashboard。

**操作步驟**

1. 視窗 A 以 `ra01` 登入，右上「目前專案」選 `KIT-C-p1` → 左側「建模管理」→「專案工作」。「執行秒數」輸入 `150`，點「送出工作」。
2. 視窗 B 以 `ca01` 登入，「目前專案」選 `KIT-C-p2`，同上送出 150 秒工作。
3. 視窗 C 以 `pi01` 登入，「目前專案」選 `KIT-C-p3`，同上送出 150 秒工作。
4. 在 `admin01` 視窗進入「GPU Dashboard」分頁，等 5 秒（頁面每 5 秒自動更新）。截圖。
5. 在 2 分鐘內執行（叢集實際值）：
   ```bash
   kubectl -n platform-jobs get pods -l platform/user --field-selector=status.phase=Running -o custom-columns='POD:.metadata.name,節點:.spec.nodeName,PROJECT:.metadata.labels.platform/project-id,JOB:.metadata.labels.platform/job-id,TRAINING:.metadata.labels.platform/training-id,使用者:.metadata.labels.platform/user' | tee C01-04-pods.txt
   ```
6. 逐列比對 Dashboard 表格與步驟 5：節點、Project ID、Training ID、使用者。

**預期結果**（`shots/TC-C01-04/01-GPU-Dashboard-3件.png`）

- 上方 3 張卡（同一高度對齊）：`gpu-exclusive · GPU 0`「使用中 1／1 份」`工作 121（ra01）`；`gpu-exclusive · GPU 1`「使用中 1／1 份」`工作 123（pi01）`；`gpu-shared · GPU 0`「使用中 1／4 份」`工作 122（ca01）`＋3 格「閒置」。
- 表格（開發環境實測）：

  | 節點 | GPU 編號 | 時間片 | 專案 | Project ID | Job ID | Training ID | 使用者 |
  |---|---|---|---|---|---|---|---|
  | ai-platform-worker3 | 0 | 0 | KIT-C-p1 | 76 | 121 | 121 | ra01 |
  | ai-platform-worker3 | 1 | 0 | KIT-C-p3 | 78 | 123 | 123 | pi01 |
  | ai-platform-worker4 | 0 | 0 | KIT-C-p2 | 77 | 122 | 122 | ca01 |

- 步驟 5 的 Pod 標籤與節點和表格完全相同。3 組差異 0。

**留存證據**：Dashboard 截圖；3 個送出成功截圖（`shots/TC-C01-04/00-ra01送出工作.png` 為例）；`C01-04-pods.txt`。

**若結果不符**

- 第 3 件沒出現：GPU 被占用而排隊中，等前面工作結束或改用較短秒數重做。
- 使用者都是 admin01：步驟 1–3 誤用 admin01 送出。
- 「專案」欄顯示「專案 76」而不是名稱：admin01 的專案清單未更新，重新整理頁面。

**開發環境與甲方環境的差異**：開發環境「GPU 編號／時間片」由工作開始時間推算（頁面上已註明）；甲方環境實際 GPU 編號以 `nvidia-smi` 對照（`kubectl exec <pod> -- nvidia-smi -L`，需 GPU 映像）。GPU 使用率需 DCGM，見 C-02。

---

## TC-C01-05 佇列排程

**合約指標**：「佇列排程：忙碌時新任務自動排隊，依序或時間片共享執行」，**同時送 3 件，順序不符 0、遺失 0**；等候時間不列驗收。

**前置條件**：TC-C01-03 完成；獨占池沒有執行中工作。

**使用資料或帳號**：`admin01`，專案 `KIT-C-p1`（綁 `KIT-C-high`，獨占池 2 張卡）。

**操作步驟**

1. 「目前專案」選 `KIT-C-p1` → 「建模管理」→「專案工作」。
2. 「工作種類」選 `訓練（GPU）`，「執行秒數」輸入 `30`。
3. 連續點「送出工作」3 次（每次間隔約 1 秒）。
4. 立即截圖工作列表。
5. 等約 70 秒（列表每 2 秒自動更新），3 件都「已完成」後再截圖。列表上方註明「開始與結束時間是叢集實際啟動與結束工作的時間（不是畫面更新的時間），可與叢集紀錄比對。」，**畫面上的「開始時間」即可判斷順序**。
6. （與叢集比對，選做）執行：
   ```bash
   kubectl -n platform-jobs get pods -l 'platform/job-id in (<編號1>,<編號2>,<編號3>)' --sort-by=.metadata.creationTimestamp -o custom-columns='JOB:.metadata.labels.platform/job-id,節點:.spec.nodeName,容器開始:.status.containerStatuses[0].state.terminated.startedAt,狀態:.status.phase' | tee C01-05-order.txt
   kubectl -n platform-jobs get jobs -l 'platform/job-id in (<編號1>,<編號2>,<編號3>)' -o custom-columns='JOB:.metadata.name,完成:.status.completionTime' | tee -a C01-05-order.txt
   ```

**預期結果**（`shots/TC-C01-05/01-第3件排隊中.png`、`02-3件依序完成.png`）

- 步驟 4：前 2 件「執行中」，第 3 件「排隊中」。
- 步驟 5：3 件都「已完成」，沒有消失或失敗。
- 步驟 5 畫面（開發環境 21:53 重測，工作 124–126；畫面時間為瀏覽器時區，開發機為 UTC）：

  | 工作 ID | 狀態 | 建立時間 | 開始時間 | 結束時間 |
  |---|---|---|---|---|
  | 124 | 已完成 | 21:53:12 | 21:53:13 | 21:53:46 |
  | 125 | 已完成 | 21:53:13 | 21:53:14 | 21:53:47 |
  | 126 | 已完成 | 21:53:15 | 21:53:46 | 21:54:19 |

  開始時間依送出順序遞增；第 3 件在第 1 件結束（21:53:46）時才開始。順序不符 0、遺失 0。
- 步驟 6：容器開始 `21:53:13Z`、`21:53:14Z`、`21:53:46Z`，Job 完成 `21:53:46Z`、`21:53:47Z`、`21:54:19Z`，與畫面一致（畫面的開始＝容器開始、結束＝Job 完成）。

**留存證據**：兩張截圖；`C01-05-order.txt`。

**若結果不符**：第 3 件也立即執行：獨占池卡數大於 2（甲方環境），改為送出「卡數＋1」件；畫面時間與步驟 6 不一致時，以叢集時間為準並回報（10/3 第一次演練時曾有此缺陷，已修正）。

**開發環境與甲方環境的差異**：開發環境獨占池 2 張假 GPU；甲方送出件數＝獨占池卡數＋1。

---

## TC-C01-06 負載平衡

**合約指標**：「負載平衡：網頁功能與資料清洗分散到不同伺服器」，**路由各 5 次，錯誤 0**。

**前置條件**：共同前置條件 1–3。

**使用資料或帳號**：`admin01`，專案 `KIT-C-p1`。

**操作步驟**

1. 網頁請求 5 次（`web-echo` 回應處理該請求的 Pod 名稱）：
   ```bash
   for i in 1 2 3 4 5; do p=$(kubectl get --raw /api/v1/namespaces/platform-web/services/web-echo:80/proxy/); echo "$i $p $(kubectl -n platform-web get pod $p -o jsonpath='{.spec.nodeName}')"; done | tee C01-06-web.txt
   kubectl get nodes -L platform/pool | tee -a C01-06-web.txt
   ```
2. 平台網頁服務的位置：`kubectl -n ai-platform get pods -o wide | tee C01-06-platform-pods.txt`
3. 網頁：「目前專案」選 `KIT-C-p1` →「建模管理」→「專案工作」；「工作種類」選 `資料清洗（CPU）`，「執行秒數」輸入 `5`；點「送出工作」5 次。
4. 等約 20 秒，按「重新整理」，截圖。
5. 執行：
   ```bash
   kubectl -n platform-jobs get pods -l 'platform/job-id in (<5 個編號>)' -o custom-columns='JOB:.metadata.labels.platform/job-id,節點:.spec.nodeName,狀態:.status.phase' | tee C01-06-data.txt
   ```

**預期結果**（`shots/TC-C01-06/01-資料清洗5件.png`）

- 步驟 1：5 行都落在 `ai-platform-worker`（池 `cpu-web`），開發環境實測 5 次分散在 2 個 web-echo Pod。
- 步驟 2：`web`、`apisix`、`api` 等平台 Pod 都在 `ai-platform-worker`（cpu-web）。
- 步驟 3、4：5 件「資料清洗（CPU）」「GPU 群組」為 `—`、「佇列」為 `cpu-data`，都「已完成」。
- 步驟 5：5 件都在 `ai-platform-worker2`（池 `cpu-data`）、`Succeeded`。路由錯誤 0。

**留存證據**：`C01-06-*.txt`；工作列表截圖。

**若結果不符**：資料清洗工作跑到其他節點：查 `cpu-data` ResourceFlavor 的 nodeLabels（`kubectl get resourceflavors -o yaml`）；`web-echo` 不存在（甲方正式環境沒有部署）時，改以步驟 2 的平台 Pod 位置佐證，並以 `curl -s -o /dev/null -w '%{http_code}\n' https://<平台網域>/` 5 次確認回 200。

**開發環境與甲方環境的差異**：開發環境 cpu-web 與 cpu-data 各 1 個節點；甲方依主機分配。`web-echo` 是 kind 叢集的測試服務。

---

## TC-C01-07 擴充（破壞性步驟，需協調）

**合約指標**：「擴充：新增 GPU 或 CPU 節點納管」，**無第二節點時以設定一致為準**；測試案例：新增 1 個節點並加標籤，平台清單自動出現；設定一致。

**前置條件**：無其他人正在用叢集做排程或監控測試（新增節點會觸發節點相關告警與排程變動）。開發環境用 `platform/deploy/kind/add-node.sh`；甲方環境依安裝腳本把新主機 `kubeadm join` 後加標籤〔待安裝腳本〕。

**使用資料或帳號**：`admin01`；可執行 docker 與 kubectl 的開發機帳號。

**操作步驟**

1. 「叢集節點」分頁截圖（新增前：節點數 5）。
2. 執行 `platform/deploy/kind/add-node.sh ai-platform-extra-1 cpu-data`（開發環境實測 20 秒，依序印出「== 啟動節點容器」「== kubeadm join」「== 加標籤 platform/pool=cpu-data」，最後 `node/ai-platform-extra-1 condition met`；中間的 `[WARNING Swap]`、`[WARNING SystemVerification]` 可忽略）。
   甲方環境：在新主機執行安裝腳本的加入指令後，`kubectl label node <新主機> platform/pool=cpu-data`。
3. 在「叢集節點」分頁點「重新整理」。截圖。
4. 執行 `kubectl get node ai-platform-extra-1 -L platform/pool | tee C01-07-node.txt`。
5. 執行 `kubectl get resourceflavor cpu-data -o jsonpath='{.spec.nodeLabels}{"\n"}' | tee -a C01-07-node.txt`（新節點的標籤符合 cpu-data 佇列的節點條件＝設定一致）。
6. 驗收完移除：`platform/deploy/kind/remove-node.sh ai-platform-extra-1`，「叢集節點」點「重新整理」，回到 5 個節點。

**預期結果**（`shots/TC-C01-07/01-新增前.png`、`02-新增節點後.png`、`03-移除節點後.png`；2026-10-03 已實際執行）

- 步驟 3：節點數 `6`、就緒節點 `6`；表格多一列 `ai-platform-extra-1｜cpu-data｜資料清洗｜就緒｜0｜0｜0`，不需在平台做任何設定。
- 步驟 4、5：`ai-platform-extra-1   Ready   <none>   49s   v1.37.0   cpu-data`；ResourceFlavor 印出 `{"platform/pool":"cpu-data"}`，與新節點標籤一致。
- 步驟 6：印出「已移除 ai-platform-extra-1」，網頁回到節點數 5。

**留存證據**：新增前、新增後、移除後 3 張截圖；`C01-07-node.txt`；`add-node.sh` 的終端機輸出。

**注意**：網頁閒置一段時間後會回到登入頁（要重新點「登入」），步驟 3 若出現登入頁，登入後再進「叢集節點」。

**若結果不符**：`kubeadm join` 失敗：token 過期，重跑腳本；節點出現但「未就緒」：等 CNI 就緒（1 分鐘內），或 `kubectl describe node ai-platform-extra-1`；甲方若沒有第二台主機，依合約以「設定一致」驗收（步驟 4、5 對既有節點執行，說明新主機加入後只需加標籤）。

**開發環境與甲方環境的差異**：開發環境用容器模擬新主機；甲方為實體／虛擬主機，是否有第二台伺服器待甲方確認（《應備事項需求函》）。

---

## TC-C01-08 工作取消與失敗

**合約指標**：測試案例：取消排隊中的工作、讓 1 件工作失敗，**佇列不卡住，下一件照順序執行**（合約「佇列排程」的補充驗證）。

**前置條件**：獨占池沒有執行中工作。

**使用資料或帳號**：`admin01`，專案 `KIT-C-p1`。

**操作步驟**

1. 「專案工作」頁，「工作種類」`訓練（GPU）`，「執行秒數」輸入 `90`，點「送出工作」（工作 A，長工作）。
2. 「執行秒數」輸入 `30`，勾選「讓這件工作以失敗結束（測試佇列不會卡住）」，點「送出工作」（工作 B，會失敗）。
3. 取消勾選，「執行秒數」輸入 `10`，點「送出工作」兩次（工作 C、D）。
4. 確認 C、D 為「排隊中」後，在工作 C 那列點「取消」。
5. 對話框「取消工作」出現「確定要取消工作 <C>（排隊中）嗎？取消後無法恢復。」與兩個按鈕「不要取消」「確定取消工作」，點紅色「確定取消工作」。截圖。
6. 等約 100 秒到 A 完成，截圖。畫面上的開始／結束時間是叢集實際時間，可直接判斷 D 是否在 B 失敗後接上。
7. （與叢集比對，選做）執行：
   ```bash
   kubectl -n platform-jobs get pods -l 'platform/job-id in (<A>,<B>,<C>,<D>)' --sort-by=.metadata.creationTimestamp -o custom-columns='JOB:.metadata.labels.platform/job-id,開始:.status.startTime,結束:.status.containerStatuses[0].state.terminated.finishedAt,狀態:.status.phase' | tee C01-08.txt
   ```

**預期結果**（`shots/TC-C01-08/01-取消確認.png`、`02-取消與失敗後下一件完成.png`）

- 步驟 5：綠色「完成：已取消工作 <C>」，C 狀態「已取消」。
- 步驟 6 畫面（開發環境 21:54 重測，A=127、B=128、C=129、D=130）：

  | 工作 ID | 狀態 | 開始時間 | 結束時間 | 訊息 |
  |---|---|---|---|---|
  | 130（D） | 已完成 | 21:55:15 | 21:55:28 | — |
  | 129（C） | 已取消 | — | 21:55:01 | — |
  | 128（B） | 失敗 | 21:54:42 | 21:55:15 | 工作失敗：BackoffLimitExceeded |
  | 127（A） | 已完成 | 21:54:41 | 21:56:13 | — |

  D 在 B 失敗（21:55:15）時立即開始，早於 A 結束（21:56:13）。佇列沒有卡住。成功的工作「訊息」欄都是「—」。
- 步驟 7：C（129）沒有 Pod；127、128、130 的 Pod 開始 `21:54:40Z`、`21:54:42Z`、`21:55:15Z`，與畫面相符（畫面開始取容器實際啟動時間，差 1 秒內）。

**留存證據**：兩張截圖；`C01-08.txt`。

**若結果不符**：C 已經開始執行才點取消（B 失敗得太快）：把 B 的秒數加長重做；D 等到 A 結束才開始：表示失敗工作沒有釋放 GPU，查 `kubectl -n platform-jobs describe job <B>`。

**開發環境與甲方環境的差異**：無（假工作，與 GPU 型號無關）；甲方獨占卡數不同時，工作 A、B 的件數改為「卡數」件，使 C、D 一定排隊。

---

## TC-C01-09 GPU 偵測（甲方環境）

**合約指標**：真實 GPU 偵測 3 次，全部偵測、驅動衝突 0。操作與 TC-A01-03 相同（`nvidia-smi` 3 次＋叢集內檢查 Job），另在平台「叢集節點」頁確認「實體 GPU」等於 `nvidia-smi -L` 的張數。〔待安裝腳本、待 GPU 映像〕

---

## 驗收後清除

1. 「帳號管理」→「專案成員」：上方「專案」選 `KIT-C-p1`，在成員列表 `ra01` 那列點「移除」→ 對話框點「確認移除」；同法 `KIT-C-p2`／`ca01`、`KIT-C-p3`／`pi01`。
2. 「帳號管理」→「專案」：`KIT-C-p1`、`KIT-C-p2`、`KIT-C-p3` 各點「刪除」並確認。
3. 「共享排程設定」→「GPU 群組」：`KIT-C-high`、`KIT-C-low` 各點「刪除」並確認（仍有專案綁定時無法刪除，所以先刪專案）。
（失敗的測試 Job 不需手動刪除：新版告警規則每次失敗只寄一封、15 分鐘後自動解除；Job 保留 24 小時供查紀錄後自動清除。）

## 演練發現的問題

第一次演練（2026-10-03 19:00 前）發現下列 1–4，已在 integration/wp5-8（1421f98 之後）修正，21:40 後重新驗證確認：

1. ~~工作的「開始時間／結束時間」是平台查詢時才記的時間，不是叢集實際時間~~（已修正：現在取 Kubernetes 的容器啟動時間與 Job 完成時間，TC-C01-05 可直接在畫面判斷）。
2. ~~成功完成的工作「訊息」欄留下開發者用語「忽略後端回報的狀態 queued（目前 running）」~~（已修正：內部訊息不再顯示）。
3. ~~「叢集節點」數字卡與「GPU Dashboard」GPU 卡第一張比其他張高約 16px~~（已修正，見 `shots/TC-C01-01/01-叢集節點.png`、`shots/TC-C01-04/01-GPU-Dashboard-3件.png`）。
4. ~~取消確認對話框左鍵也叫「取消」~~（已修正：改為「不要取消」「確定取消工作」，見 `shots/TC-C01-08/01-取消確認.png`）。

仍未解決：

5. 「GPU 群組依等級分群」未實作（已知缺口，見 TC-C01-02）。GPU 群組的「GPU 數量」目前只是記錄，不限制該群組可用的卡數（同池的群組共用同一個 Kueue 佇列與配額）。
6. 叢集更新映像後，`web` Deployment 沒有自動重啟（映像標籤都是 `:dev`），重測時曾看到舊版網頁；現場部署後要確認 `kubectl -n ai-platform rollout restart deploy/web` 或映像改用版本標籤。
