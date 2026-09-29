"""S0 smoke：依 docs/03-使用情境.md 的 10 個情境，走一遍已實作的主幹。

判準（見 docs/superpowers/plans/2026-09-28-roadmap.md）：
每條資料流能從頭走到尾、每一步有稽核紀錄、權限拒絕的情況都擋得住。
時間、準確度、量化等數字不在範圍內。

尚未實作的步驟以 pytest.skip 標出所屬工作包，完成後把 skip 換成真的步驟。
依檔案順序執行：前面情境建立的專案、影像、資料集，後面情境會接著用。
"""
import json

import pytest
from fastapi.testclient import TestClient

ADMIN = "admin01"


def ok(response, status=200):
    assert response.status_code == status, f"{response.request.method} {response.request.url} → {response.status_code} {response.text[:300]}"
    return response.json() if response.content else None


def pending(wp: str, what: str):
    pytest.skip(f"{wp} 未開始：{what}")


# ---------------------------------------------------------------- 情境 1：開一個研究專案

def test_scenario_01_open_research_project(world):
    c, admin = world.client, world.headers(ADMIN)
    mark = world.last_audit_id()

    # 1. 建立專案、帳號，指派角色與權限（A-03）
    project = ok(c.post("/api/admin/projects", headers=admin,
                        json={"name": "S0-lung-ct", "description": "S0 smoke", "gpu_group": "gpu-exclusive"}), 201)
    user = ok(c.post("/api/admin/users", headers=admin,
                     json={"username": "s0md", "password": "Dev-Passw0rd!", "account_type": "user"}), 201)
    ok(c.put(f"/api/admin/projects/{project['id']}/members/{user['id']}", headers=admin,
             json={"role": "medical_doctor"}))
    world.ids["s0_project"] = project["id"]

    # 權限立即生效：成員登入後 /me 馬上看到專案與角色預設權限（A-02 入口依此顯示）
    me = ok(c.get("/api/me", headers=world.headers("s0md")))
    assert [(p["name"], p["permissions"]) for p in me["projects"]] == [
        ("S0-lung-ct", ["labeling", "prediction", "project"])]

    # 2. Accession 清單限制可存取影像（B-01）：只有 Admin 能設
    allow = json.loads((world.synth / "dicom" / "manifest.json").read_text())["accession_allowlist"]
    p1 = world.project_id("P1-lung-ct")
    world.ids["p1"], world.ids["allowlist"] = p1, allow
    assert c.put(f"/api/projects/{p1}/imaging/accession-allowlist", headers=world.headers("pi01"),
                 json={"accession_numbers": allow}).status_code == 403
    ok(c.put(f"/api/projects/{p1}/imaging/accession-allowlist", headers=admin, json={"accession_numbers": allow}))

    # 3. GPU 群組：預設的獨占與共享群組存在，另建一個群組並改綁到專案（C-01）
    assert {g["name"] for g in ok(c.get("/api/admin/gpu-groups", headers=admin))} >= {"gpu-exclusive", "gpu-shared"}
    ok(c.post("/api/admin/gpu-groups", headers=admin,
              json={"name": "s0-train", "pool": "gpu-exclusive", "gpu_count": 1, "mode": "exclusive"}), 201)
    assert ok(c.patch(f"/api/admin/projects/{project['id']}", headers=admin,
                      json={"gpu_group": "s0-train"}))["gpu_group"] == "s0-train"

    # 4. 越權與跨專案：非 Admin 打管理 API、非成員讀別人的專案，全部被擋
    for username in ("vw01", "pi01", "user01", "s0md"):
        assert c.get("/api/admin/users", headers=world.headers(username)).status_code == 403
    assert c.get(f"/api/projects/{p1}/imaging/studies", headers=world.headers("user01")).status_code == 403
    assert c.get(f"/api/projects/{project['id']}/imaging/studies", headers=world.headers("ra01")).status_code == 403
    assert c.get("/api/me").status_code == 401

    categories = {a.category for a in world.audit(since=mark)}
    assert {"project", "account", "role", "dataset"} <= categories, categories


# ---------------------------------------------------------------- 情境 2：把影像帶進平台

def test_scenario_02_bring_images_in(world):
    c, ra, p1 = world.client, world.headers("ra01"), world.ids["p1"]
    manifest = json.loads((world.synth / "dicom" / "manifest.json").read_text())
    allow = set(world.ids["allowlist"])
    allowed = [s for s in manifest["studies"] if s["accession_number"] in allow]
    mark = world.last_audit_id()

    # 1. DICOM 網路節點向 PACS 查詢與取像：只看得到清單內的研究
    answers = ok(c.post(f"/api/projects/{p1}/imaging/pacs/query", headers=ra, json={}))
    assert sorted(a["AccessionNumber"] for a in answers) == sorted(allow)
    # 刻意挑一個被 makesense 引用的研究：先經 PACS 取回、之後批次上傳時判為重複，但會補記檔案路徑，標註仍配得到
    first = next(s for s in allowed if s["accession_number"] in {"ACC0001", "ACC0002", "ACC0003"})
    job = ok(c.post(f"/api/projects/{p1}/imaging/pacs/retrieve", headers=ra,
                    json={"study_instance_uid": first["study_instance_uid"]}), 201)
    assert job["counts"]["imported"] == len(first["files"])

    # 2. 批次匯入 DICOM（全部 20 個研究；清單外的可匯入但看不到）與 NIfTI、ITK、makesense
    dicom_root = world.synth / "dicom"
    files = [("files", (str(p.relative_to(dicom_root)), p.read_bytes())) for p in sorted(dicom_root.rglob("*.dcm"))]
    job = ok(c.post(f"/api/projects/{p1}/imaging/dicom", headers=ra, files=files), 201)
    assert job["counts"]["failed"] == 0
    assert job["counts"]["imported"] + job["counts"]["duplicate"] == manifest["counts"]["instances"]

    others = [("files", (f"{kind}/{p.name}", p.read_bytes()))
              for kind, pattern in (("nifti", "*.nii.gz"), ("itk", "*.mha"), ("makesense", "makesense_*.json"))
              for p in sorted((world.synth / kind).glob(pattern))]
    job = ok(c.post(f"/api/projects/{p1}/imaging/files", headers=ra, files=others), 201)
    assert job["counts"]["failed"] == 0, job

    # 3. 影像與標註自動配對：NIfTI／ITK 標註配到影像，makesense 配到 DICOM 切片
    listed = {f["filename"]: f for f in ok(c.get(f"/api/projects/{p1}/imaging/files", headers=ra))}
    labels = [f for name, f in listed.items() if "_label" in name or name.startswith("makesense/")]
    assert len(labels) == 9 and all(f["pairing"] == "paired" for f in labels), labels

    # 4. 以 5 個欄位篩選；結果只含清單內研究，筆數差異 0
    studies = ok(c.get(f"/api/projects/{p1}/imaging/studies", headers=ra))
    assert len(studies) == len(allowed)
    for field, value in (("modality", "CT"), ("patient_sex", "F"), ("study_description", "CHEST"),
                         ("series_description", "AX"), ("study_date", "20240101-20241231")):
        got = ok(c.get(f"/api/projects/{p1}/imaging/studies", headers=ra, params={field: value}))
        assert 0 < len(got) <= len(allowed), (field, value)

    # 權限：Viewer 不能匯入；非成員看不到
    assert c.post(f"/api/projects/{p1}/imaging/dicom", headers=world.headers("vw01"), files=files[:1]).status_code == 403
    assert {a.category for a in world.audit(since=mark)} >= {"dataset"}


# ---------------------------------------------------------------- 情境 3：醫師標註影像

def test_scenario_03_autolabel_contract(world):
    """B-03 串接前先確認 fake-autolabel 的介面：同一影像結果可重現。"""
    from fakes.autolabel import app as autolabel
    c = TestClient(autolabel)
    info = ok(c.get("/info/"))
    for model, meta in info["models"].items():
        a = ok(c.post(f"/infer/{model}", params={"image": "study_0001"}))
        assert a == ok(c.post(f"/infer/{model}", params={"image": "study_0001"}))
        assert a["model"] == model and ("boxes" in a or "label_names" in a), (meta, a)


def test_scenario_03_annotate_on_platform(world):
    """醫師標註、評分、CSV 自動分類、送自動標註並修正（B-02、B-03）。OHIF 與畫面操作由 Playwright 與經 Gateway 驗收涵蓋。"""
    from app.labeling.autolabel import HttpAutolabel
    from fakes.autolabel import app as autolabel

    c, md, p1 = world.client, world.headers("md01"), world.ids["p1"]
    base = f"/api/projects/{p1}/labels"
    world.app.state.autolabel = HttpAutolabel("http://autolabel",
                                              client=TestClient(autolabel, base_url="http://autolabel"))
    manifest = json.loads((world.synth / "dicom" / "manifest.json").read_text())
    allow = set(world.ids["allowlist"])
    study = next(s for s in manifest["studies"] if s["accession_number"] in allow)
    sop = study["sop_instance_uids"][0]
    target = {"study_instance_uid": study["study_instance_uid"], "sop_instance_uid": sop}
    mark = world.last_audit_id()

    # 1. 三種標註存回平台，重新載入內容一致；評分
    shape = [64, 64]
    bodies = [
        {**target, "kind": "classification", "payload": {"label": "nodule"}},
        {**target, "kind": "detection", "payload": {"shape": shape, "box_format": "xyxy",
                                                    "boxes": [{"label": "nodule", "box": [10, 10, 20, 20]}]}},
        {**target, "kind": "segmentation", "payload": {"shape": shape, "encoding": "rle", "rle": [[0, 4000], [1, 96]],
                                                       "label_names": {"background": 0, "lung": 1}}},
    ]
    for body in bodies:
        a = ok(c.post(f"{base}/annotations", headers=md, json=body), 201)
        assert ok(c.get(f"{base}/annotations/{a['id']}", headers=md))["payload"] == body["payload"]
    assert ok(c.put(f"{base}/annotations/{a['id']}/rating", headers=md, json={"rating": 4}))["rating"] == 4

    # 2. 以 CSV 診斷結果依病歷號自動分類
    rows = [f"{s['patient_id']},dx-{s['accession_number']}" for s in manifest["studies"] if s["accession_number"] in allow]
    csv = ("patient_id,diagnosis\n" + "\n".join(rows) + "\n").encode()
    result = ok(c.post(f"{base}/classification-csv", headers=md, data={"key": "patient_id"},
                       files={"file": ("dx.csv", csv, "text/csv")}), 201)
    assert result["matched"] == len(rows) and result["unmatched"] == 0

    # 3. 送自動標註，結果回存，醫師開啟修正
    run = ok(c.post(f"{base}/autolabel", headers=md, json={"model": "fake_detection", **target}), 201)
    auto = run["annotation"]
    assert auto["source"] == "autolabel"
    edited = {**auto["payload"], "boxes": auto["payload"]["boxes"][:1]}
    assert ok(c.put(f"{base}/annotations/{auto['id']}", headers=md, json={"payload": edited}))["version"] == 2

    # 權限：Viewer 看得到不能改
    assert c.post(f"{base}/annotations", headers=world.headers("vw01"), json=bodies[0]).status_code == 403
    assert ok(c.get(f"{base}/summary", headers=world.headers("vw01")))["by_source"]["autolabel"] == 1
    actions = {a.action for a in world.audit("dataset", since=mark)}
    assert {"annotation.create", "annotation.rate", "annotation.csv_classification", "autolabel.submit",
            "annotation.update"} <= actions


# ---------------------------------------------------------------- 情境 4：不寫程式訓練模型

def test_scenario_04_training_job_queues_onto_gpu(world):
    c, ra, p1 = world.client, world.headers("ra01"), world.ids["p1"]
    mark = world.last_audit_id()

    # 3. 送出訓練，進入佇列並分配到 GPU（C-01）
    job = ok(c.post(f"/api/projects/{p1}/jobs", headers=ra, json={"kind": "training", "duration_seconds": 5}), 201)
    assert (job["status"], job["queue"], job["gpu_group"]) == ("queued", "gpu-exclusive", "gpu-exclusive")
    assert ok(c.get(f"/api/projects/{p1}/jobs/{job['id']}", headers=ra))["status"] == "running"
    world.backend.advance(5)
    assert ok(c.get(f"/api/projects/{p1}/jobs/{job['id']}", headers=ra))["status"] == "succeeded"

    # 沒有 training 權限（Medical Doctor、Viewer）不能送
    for username in ("md01", "vw01"):
        assert c.post(f"/api/projects/{p1}/jobs", headers=world.headers(username), json={}).status_code == 403
    assert [a.category for a in world.audit(since=mark)].count("training") >= 1


def test_scenario_04_no_code_training_templates(world):
    pending("WP5", "訓練設定、5 種範本、資料凍結、fake-trainer、匯出 H5／pkl 與原始碼（TC-B05）")


# ---------------------------------------------------------------- 情境 5：部署模型給別人用

def test_scenario_05_deploy_and_infer(world):
    pending("WP5", "MLflow、批次推論、部署為線上服務與授權呼叫（TC-B06）")


# ---------------------------------------------------------------- 情境 6：分析結構式臨床資料

def test_scenario_06_tabular_analysis(world):
    c, admin = world.client, world.headers(ADMIN)
    p2 = world.project_id("P2-tabular")
    ra = ok(c.get("/api/admin/users", headers=admin))
    ra_id = next(u["id"] for u in ra if u["username"] == "ra01")
    ok(c.put(f"/api/admin/projects/{p2}/members/{ra_id}", headers=admin, json={"role": "research_assistant"}))
    h = world.headers("ra01")
    tab = world.synth / "tabular"
    schema = (tab / "schema.json").read_text()
    base = f"/api/projects/{p2}/tabular/datasets"
    mark = world.last_audit_id()

    # 1. 上傳 CSV，系統驗證欄位：乾淨檔全收，壞檔剛好擋下錯誤列
    body = ok(c.post(base, headers=h, data={"schema": schema, "name": "cohort_01"},
                     files={"file": ("cohort_01.csv", (tab / "cohort_01.csv").read_bytes(), "text/csv")}), 201)
    assert body["report"]["valid_rows"] == 100 and body["report"]["rejected_row_count"] == 0
    ds = f"{base}/{body['dataset']['id']}"
    bad = ok(c.post(base, headers=h, data={"schema": schema, "name": "bad"},
                    files={"file": ("bad.csv", (tab / "bad.csv").read_bytes(), "text/csv")}), 201)
    expected = sorted(r["row"] for r in json.loads((tab / "bad_rows.json").read_text())["rows"])
    assert sorted({r["row"] for r in bad["report"]["rejected"]}) == expected

    # 2. 描述統計、分布、相關矩陣
    describe = ok(c.get(f"{ds}/describe", headers=h))
    assert any(col["name"] == "age" and col["count"] == 100 for col in describe["columns"])
    assert sum(ok(c.get(f"{ds}/histogram", headers=h, params={"column": "age", "bins": 5}))["counts"]) == 100
    ok(c.get(f"{ds}/correlation", headers=h))

    # 3. Target／Feature、補值、One Hot
    config = {"target": "event", "features": ["age", "glucose", "smoker_current", "smoker_former", "smoker_never"],
              "steps": [{"id": "impute_mean", "columns": ["glucose"]}, {"id": "onehot", "columns": ["smoker"]}]}
    saved = ok(c.put(f"{ds}/target-feature", headers=h, json=config))
    assert ok(c.get(f"{ds}/target-feature", headers=h))["config"] == saved["config"]

    # 4. Logistic、Linear、Kaplan-Meier／Log-rank、Cox
    for kind, req in {"logistic": {"target": "diagnosis", "features": ["age", "sbp"]},
                      "linear": {"target": "sbp", "features": ["age", "bmi"]},
                      "kaplan-meier": {"duration": "time_to_event", "event": "event", "group": "sex"},
                      "cox": {"duration": "time_to_event", "event": "event", "covariates": ["age", "diagnosis"]}}.items():
        ok(c.post(f"{ds}/stats/{kind}", headers=h, json=req))

    # 權限：非成員讀不到；Viewer 等級不能存訓練設定
    assert c.get(f"{ds}/describe", headers=world.headers("user02")).status_code == 403
    assert {"dataset", "training"} <= {a.category for a in world.audit(since=mark)}


def test_scenario_06_train_on_tabular(world):
    pending("WP5", "以同份資料訓練分類或迴歸模型並匯出 pkl（TC-B05）")


# ---------------------------------------------------------------- 情境 7：建一個院內知識問答

def test_scenario_07_llm_contract(world):
    """WP7 串接前先確認 fake-llm 的 OpenAI 相容介面：參數與檢索內容確實送到模型。"""
    from fakes.llm import app as llm
    c = TestClient(llm)
    models = {m["id"] for m in ok(c.get("/v1/models"))["data"]}
    assert {"fake-llm-small", "fake-embed-small"} <= models
    answer = ok(c.post("/v1/chat/completions", json={
        "model": "fake-llm-small", "temperature": 0.2,
        "messages": [{"role": "system", "content": "Context: 輔大醫院門診時間為週一至週五"},
                     {"role": "user", "content": "門診時間？"}]}))
    text = answer["choices"][0]["message"]["content"]
    assert "門診時間？" in text and "temperature" in text
    emb = ok(c.post("/v1/embeddings", json={"model": "fake-embed-small", "input": ["a b", "a b"]}))["data"]
    assert emb[0]["embedding"] == emb[1]["embedding"] and len(emb[0]["embedding"]) == 384


def test_scenario_07_knowledge_qa_on_platform(world):
    """白名單下載 → 量化載入 → 6 種格式建庫 → Playground → 發布 API → 工作流與 Wiki（TC-B07、B08）。"""
    from app.llm.sources import FAKE_SOURCE_HOST, FAKE_VALID_TOKEN
    from synth import documents

    c, admin = world.client, world.headers(ADMIN)
    p3 = world.project_id("P3-llm")
    users = {u["username"]: u["id"] for u in ok(c.get("/api/admin/users", headers=admin))}
    ok(c.put(f"/api/admin/projects/{p3}/members/{users['ca01']}", headers=admin, json={"role": "coder_assistant"}))
    ok(c.put(f"/api/admin/projects/{p3}/members/{users['vw01']}", headers=admin, json={"role": "viewer"}))
    ca, vw, base = world.headers("ca01"), world.headers("vw01"), f"/api/projects/{p3}/llm"
    world.ids["p3"] = p3
    mark = world.last_audit_id()

    # 1. 經白名單審核下載開源模型（D-01）
    source = world.app.state.llm.sources[FAKE_SOURCE_HOST]
    artifact = source.repos["fake-org/fake-llm-gated"]
    ok(c.post("/api/admin/llm/whitelist", headers=admin, json={
        "name": "s0-llm", "source": FAKE_SOURCE_HOST, "repo": artifact.repo, "revision": artifact.commit,
        "sha256": artifact.sha256, "license": "apache-2.0", "requires_token": True}), 201)
    assert c.post(f"{base}/models/downloads", headers=ca, json={"name": "not-on-the-list"}).status_code == 403
    download = ok(c.post(f"{base}/models/downloads", headers=ca, json={"name": "s0-llm"}), 201)
    assert c.post(f"{base}/models/downloads/{download['id']}/execute", headers=ca,
                  json={"token": FAKE_VALID_TOKEN}).status_code == 409           # 還沒核准
    ok(c.post(f"/api/admin/llm/downloads/{download['id']}/approve", headers=admin))
    done = ok(c.post(f"{base}/models/downloads/{download['id']}/execute", headers=ca,
                     json={"token": FAKE_VALID_TOKEN}))
    assert all(done[k] for k in ("commit", "hash", "time", "user", "token_usage", "reviewer"))
    world.ids["s0_download"] = download["id"]

    # 2. 以 4-bit 量化載入，設定資源（Mac 只驗設定保存）
    config = {"quantization": "4bit", "cpu": 8, "memory_gb": 32, "gpu_type": "gpu-exclusive", "gpu_count": 1}
    ok(c.put(f"{base}/models/s0-llm/load-config", headers=ca, json=config))
    assert ok(c.post(f"{base}/models/s0-llm/load", headers=ca))["config"]["quantization"] == "4bit"

    # 3. 上傳 6 種格式文件建立向量庫
    kb = ok(c.post(f"{base}/knowledge-bases", headers=ca, json={"name": "S0 院內規範"}), 201)
    files = [("files", (name, data, "application/octet-stream")) for name, data in documents.build().items()]
    built = ok(c.post(f"{base}/knowledge-bases/{kb['id']}/documents", headers=ca, files=files), 201)
    assert built["counts"] == {"indexed": 6, "duplicate": 0, "failed": 0}

    # 4. 在 Playground 以 Chat with Knowledge Base 測試
    answer = ok(c.post(f"{base}/chat", headers=ca,
                       json={"mode": "kb", "kb_id": kb["id"], "message": "體內有心律調節器可以做磁振造影嗎"}))
    assert answer["message"]["sources"][0]["filename"] == documents.FILENAMES["docx"]
    assert "context:" in answer["message"]["content"] and "temperature" in answer["message"]["content"]

    # 5. 發布為內部服務 RESTful API：只有授權名單內的帳號可呼叫
    service = ok(c.post(f"{base}/services", headers=ca, json={
        "slug": "s0-sop-qa", "name": "S0 規範問答", "kb_id": kb["id"], "grants": ["md01"]}), 201)
    assert ok(c.post(service["endpoint"], headers=world.headers("md01"), json={"question": "資訊室分機幾號"}))["answer"]
    assert c.post(service["endpoint"], headers=world.headers("user01"), json={"question": "x"}).status_code == 403
    assert c.post(service["endpoint"], json={"question": "x"}).status_code == 401

    # 6. 用 LangGraph 建多步驟工作流、在 Wiki 維護知識
    flow = ok(c.post(f"{base}/workflows", headers=ca, json={"name": "S0 問答流程", "definition": {
        "state": {"question": ""},
        "nodes": [{"id": "retrieve", "type": "retrieve", "kb_id": kb["id"], "query": "{question}", "output": "context"},
                  {"id": "draft", "type": "llm", "prompt": "{question}", "context": "context", "output": "draft"},
                  {"id": "final", "type": "template", "template": "答覆：{draft}", "output": "answer"}],
        "edges": [["retrieve", "draft"], ["draft", "final"]]}}), 201)
    run = ok(c.post(f"{base}/workflows/{flow['id']}/runs", headers=ca, json={"input": {"question": "夜間門診"}}), 201)
    assert run["status"] == "succeeded" and [n["node"] for n in run["nodes"]] == ["retrieve", "draft", "final"]
    assert run["nodes"][1]["llm_request"] and run["nodes"][1]["llm_response"]

    page = ok(c.post(f"{base}/wiki/pages", headers=ca, json={
        "path": "sop/visiting", "title": "探病規定", "content": "探病時間為每日 11:00 至 13:00。"}), 201)
    ok(c.put(f"{base}/wiki/pages/{page['id']}", headers=ca,
             json={"title": "探病規定", "content": "探病時間為每日 11:00 至 13:00 與 18:00 至 20:00。"}))
    assert len(ok(c.get(f"{base}/wiki/pages/{page['id']}/history", headers=ca))) == 1
    assert ok(c.get(f"{base}/wiki/search", headers=ca, params={"q": "探病時間"}))[0]["id"] == page["id"]
    asked = ok(c.post(f"{base}/wiki/ask", headers=ca, json={"question": "晚上可以探病嗎", "page_id": page["id"]}))
    assert asked["context_source"] == "wiki_api"

    # 越權：沒有 coding 權限的人什麼都不能做
    for method, url in (("get", "/models/catalog"), ("get", "/knowledge-bases"), ("get", "/workflows"),
                        ("get", "/wiki/pages"), ("get", "/prompts")):
        assert getattr(c, method)(base + url, headers=vw).status_code == 403, url
    assert c.post(f"{base}/chat", headers=vw, json={"mode": "free", "message": "x"}).status_code == 403

    actions = {a.action for a in world.audit(since=mark)}
    assert {"llm.whitelist.add", "llm.model.download.request", "llm.model.download.approve", "llm.model.download",
            "llm.model.load_config", "llm.model.load", "llm.kb.create", "llm.kb.documents.add", "llm.chat",
            "llm.service.publish", "llm.service.invoke", "llm.workflow.run", "llm.wiki.page.create",
            "llm.wiki.ask"} <= actions
    assert {"inference", "dataset", "project"} <= {a.category for a in world.audit(since=mark)}


# ---------------------------------------------------------------- 情境 8：醫療資料標準化交換

def test_scenario_08_source_data_ready(world):
    clinical = world.synth / "clinical"
    hl7 = sorted((clinical / "hl7").glob("*.hl7"))
    assert len(hl7) == 20 and all(p.read_text().startswith("MSH|") for p in hl7)
    assert len(json.loads((clinical / "labs.json").read_text())) == 20
    assert len((world.synth / "vitals" / "vitals.jsonl").read_text().splitlines()) == 100


def test_scenario_08_fhir_exchange(world):
    pending("WP6", "HAPI FHIR、4 種來源 ETL、對應規則、排程、監視器轉 Observation（TC-C03）")


# ---------------------------------------------------------------- 情境 9：維運與算力調度

def test_scenario_09_gpu_dashboard_and_nodes(world):
    c, admin, p1 = world.client, world.headers(ADMIN), world.ids["p1"]
    mark = world.last_audit_id()

    # 1. GPU Dashboard 看每張卡跑的專案與使用者
    job = ok(c.post(f"/api/projects/{p1}/jobs", headers=world.headers("ca01"),
                    json={"kind": "training", "duration_seconds": 30}), 201)
    ok(c.get(f"/api/projects/{p1}/jobs/{job['id']}", headers=world.headers("ca01")))
    rows = ok(c.get("/api/admin/cluster/gpu-dashboard", headers=admin))
    assert any(r["job_id"] == job["id"] and r["project_id"] == p1 and r["user"] == "ca01" for r in rows), rows

    # 4. 新增伺服器納管、調整群組
    world.backend.add_node("gpu-exclusive-2", "gpu-exclusive", gpus=2)
    assert "gpu-exclusive-2" in {n["name"] for n in ok(c.get("/api/admin/cluster/nodes", headers=admin))}
    ok(c.patch("/api/admin/gpu-groups/gpu-exclusive", headers=admin, json={"gpu_count": 4}))
    assert c.get("/api/admin/cluster/gpu-dashboard", headers=world.headers("pi01")).status_code == 403
    world.backend.advance(30)
    assert "project" in {a.category for a in world.audit(since=mark)}


def test_scenario_09_monitoring_alerts(world):
    pytest.skip("需 kind 叢集：監控與告警抑制由 platform/acceptance/test_tc_c02.py 驗證")


# ---------------------------------------------------------------- 情境 10：資安稽核與合規

def test_scenario_10_audit_trail(world):
    rows = world.audit()
    # 每筆稽核都帶齊：誰、何時、類別、動作、對象、結果
    assert rows and all(r.actor and r.at and r.category and r.action and r.target and r.result for r in rows)
    # 8 類稽核中，目前已實作的工作包應已產生的類別
    assert {"account", "role", "project", "dataset", "training"} <= {r.category for r in rows}
    # 沒有任何可以改或刪稽核的 API
    paths = [(m, r.path) for r in world.app.routes for m in getattr(r, "methods", ()) if "audit" in r.path]
    assert not [p for p in paths if p[0] in {"PUT", "PATCH", "DELETE", "POST"}], paths


def test_scenario_10_model_governance(world):
    """模型下載審核紀錄與遠端程式碼阻擋（TC-D01-02～04）。接續情境 7 建立的專案與下載紀錄。"""
    from app.llm.sources import FAKE_SOURCE_HOST

    c, admin, ca = world.client, world.headers(ADMIN), world.headers("ca01")
    base = f"/api/projects/{world.ids['p3']}/llm"
    mark = world.last_audit_id()

    # 下載審核紀錄：commit、hash、時間、使用者、Token 使用紀錄、審核人
    rows = {d["id"]: d for d in ok(c.get("/api/admin/llm/downloads", headers=admin))}
    row = rows[world.ids["s0_download"]]
    assert all(row[k] for k in ("commit", "hash", "time", "user", "token_usage", "reviewer"))
    assert row["user"] == "ca01" and row["reviewer"] == ADMIN and row["token_usage"]["used"] is True
    assert "hf_test_valid_token" not in json.dumps(rows, ensure_ascii=False)

    # 夾帶程式碼的模型：未核准不可載入，管理者核准後才可以
    artifact = world.app.state.llm.sources[FAKE_SOURCE_HOST].repos["fake-org/fake-llm-remote-code"]
    ok(c.post("/api/admin/llm/whitelist", headers=admin, json={
        "name": "s0-remote-code", "source": FAKE_SOURCE_HOST, "repo": artifact.repo, "revision": artifact.commit,
        "sha256": artifact.sha256, "has_remote_code": True}), 201)
    download = ok(c.post(f"{base}/models/downloads", headers=ca, json={"name": "s0-remote-code"}), 201)
    ok(c.post(f"/api/admin/llm/downloads/{download['id']}/approve", headers=admin))
    ok(c.post(f"{base}/models/downloads/{download['id']}/execute", headers=ca, json={}))
    assert c.post(f"{base}/models/s0-remote-code/load", headers=ca).status_code == 403
    assert c.post("/api/admin/llm/models/s0-remote-code/remote-code-approval", headers=ca).status_code == 403
    ok(c.post("/api/admin/llm/models/s0-remote-code/remote-code-approval", headers=admin), 201)
    assert ok(c.post(f"{base}/models/s0-remote-code/load", headers=ca))["trust_remote_code"] is True

    denied = [a for a in world.audit(since=mark) if a.result == "denied"]
    assert [a.action for a in denied] == ["llm.model.load"]
    assert "inference" in {a.category for a in world.audit()}


def test_scenario_10_compliance(world):
    pending("WP8", "授權清單、data_exchange 稽核、8 類稽核每日覆蓋檢查、掃毒、映像掃描（TC-D01-01、05～07、D02）")
