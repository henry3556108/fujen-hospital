"""模型白名單、下載、刪除、遠端程式碼、載入設定：TC-B07-01、TC-B07-04、TC-D01-02～04。"""
import json

from sqlalchemy import select

from app.llm.models import InstalledModel, ModelDownload
from app.models import AuditLog

HOST, TOKEN = "models.test.invalid", "hf_test_valid_token"


def audits(session, action):
    session.expire_all()
    return list(session.scalars(select(AuditLog).where(AuditLog.action == action).order_by(AuditLog.id)))


def test_tc_b07_01_download_by_name_and_token_then_delete(client, llm, whitelist, install, coder, base, session):
    catalog = {m["name"]: m for m in client.get(f"{base}/models/catalog", headers=coder).json()}
    assert set(catalog) == {"small", "gated", "remote-code"} and not catalog["gated"]["installed"]

    done = install("gated", token=TOKEN)
    assert (done["status"], done["mode"], done["commit"]) == ("completed", "online", "b" * 40)
    files = sorted(p.name for p in (llm.model_dir / "gated").iterdir())
    assert files == ["config.json"]
    assert {m["name"]: m["installed"] for m in client.get(f"{base}/models/catalog", headers=coder).json()}["gated"]

    assert client.delete(f"{base}/models/gated", headers=coder).status_code == 204
    assert not (llm.model_dir / "gated").exists()
    assert session.scalar(select(InstalledModel).where(InstalledModel.name == "gated")) is None
    assert client.delete(f"{base}/models/gated", headers=coder).status_code == 404
    # 刪除後可以再下載一次
    assert install("gated", token=TOKEN)["status"] == "completed"
    assert [a.result for a in audits(session, "llm.model.download")] == ["success", "success"]
    assert len(audits(session, "llm.model.delete")) == 1


def test_tc_b07_01_offline_preload_when_source_unreachable(client, llm, source, whitelist, install):
    source.reachable = False
    done = install("small")
    assert (done["status"], done["mode"], done["commit"], done["hash"]) == (
        "completed", "offline", "a" * 40, source.repos["org/small"].sha256)
    assert source.fetches == []
    assert (llm.model_dir / "small" / "config.json").read_bytes() == b'{"model_type": "fake"}'


def test_tc_b07_01_offline_preload_missing_is_a_clear_error(client, llm, source, whitelist, admin, coder, base):
    source.reachable = False
    download_id = client.post(f"{base}/models/downloads", headers=coder, json={"name": "gated"}).json()["id"]
    client.post(f"/api/admin/llm/downloads/{download_id}/approve", headers=admin)
    response = client.post(f"{base}/models/downloads/{download_id}/execute", headers=coder, json={"token": TOKEN})
    assert response.status_code == 503 and "離線預載" in response.text
    assert not (llm.model_dir / "gated").exists()
    # 失敗後申請維持已核准，網路恢復可再執行
    source.reachable = True
    assert client.post(f"{base}/models/downloads/{download_id}/execute", headers=coder,
                       json={"token": TOKEN}).status_code == 200


def test_download_needs_approval_before_execute(client, llm, whitelist, coder, base):
    download_id = client.post(f"{base}/models/downloads", headers=coder, json={"name": "small"}).json()["id"]
    response = client.post(f"{base}/models/downloads/{download_id}/execute", headers=coder, json={})
    assert response.status_code == 409 and "核准" in response.text
    assert not (llm.model_dir / "small").exists()


def test_rejected_request_cannot_execute(client, llm, whitelist, admin, coder, base):
    download_id = client.post(f"{base}/models/downloads", headers=coder, json={"name": "small"}).json()["id"]
    rejected = client.post(f"/api/admin/llm/downloads/{download_id}/reject", headers=admin, json={"reason": "授權不明"})
    assert rejected.json()["status"] == "rejected" and rejected.json()["reviewer"] == "admin01"
    assert client.post(f"{base}/models/downloads/{download_id}/execute", headers=coder, json={}).status_code == 409
    assert client.post(f"/api/admin/llm/downloads/{download_id}/approve", headers=admin).status_code == 409


def test_gated_model_requires_valid_token(client, llm, whitelist, admin, coder, base, session):
    download_id = client.post(f"{base}/models/downloads", headers=coder, json={"name": "gated"}).json()["id"]
    client.post(f"/api/admin/llm/downloads/{download_id}/approve", headers=admin)
    url = f"{base}/models/downloads/{download_id}/execute"
    assert client.post(url, headers=coder, json={}).status_code == 422
    wrong = client.post(url, headers=coder, json={"token": "hf_wrong"})
    assert wrong.status_code == 403 and wrong.json()["detail"]["code"] == "token_rejected"
    assert not (llm.model_dir / "gated").exists()
    assert [a.result for a in audits(session, "llm.model.download")] == ["failed"]


def test_tampered_content_is_refused(client, llm, source, whitelist, admin, coder, base):
    source.add("org/small", "a" * 40, {"config.json": b'{"model_type": "tampered"}'})
    download_id = client.post(f"{base}/models/downloads", headers=coder, json={"name": "small"}).json()["id"]
    client.post(f"/api/admin/llm/downloads/{download_id}/approve", headers=admin)
    response = client.post(f"{base}/models/downloads/{download_id}/execute", headers=coder, json={})
    assert response.status_code == 409 and "hash" in response.text
    assert not (llm.model_dir / "small").exists()


def test_only_requester_or_admin_can_execute_and_delete(client, llm, whitelist, install, admin, coder, project, member,
                                                         base):
    other = member(project, "ca02")
    download_id = client.post(f"{base}/models/downloads", headers=coder, json={"name": "small"}).json()["id"]
    client.post(f"/api/admin/llm/downloads/{download_id}/approve", headers=admin)
    url = f"{base}/models/downloads/{download_id}/execute"
    assert client.post(url, headers=other, json={}).status_code == 403
    assert client.post(url, headers=coder, json={}).status_code == 200
    assert client.delete(f"{base}/models/small", headers=other).status_code == 403
    assert client.delete(f"{base}/models/small", headers=admin).status_code == 204


def test_model_endpoints_need_coding_permission_and_login(client, llm, whitelist, viewer, base):
    assert client.get(f"{base}/models/catalog", headers=viewer).status_code == 403
    assert client.post(f"{base}/models/downloads", headers=viewer, json={"name": "small"}).status_code == 403
    assert client.get(f"{base}/models/catalog").status_code == 401
    assert client.get("/api/admin/llm/whitelist", headers=viewer).status_code == 403
    assert client.post("/api/admin/llm/downloads/1/approve", headers=viewer).status_code == 403


def test_tc_d01_02_download_outside_whitelist_never_succeeds(client, llm, source, whitelist, coder, admin, base,
                                                            session):
    attempts = [
        {"name": "not-listed"},
        {"source": HOST, "repo": "org/not-listed"},
        {"source": "evil.example.com", "repo": "org/small"},       # 白名單內的 repo，但來源不同
        {"source": HOST, "repo": "org/SMALL"},
        {"name": "small/../not-listed"},
    ]
    for body in attempts:
        response = client.post(f"{base}/models/downloads", headers=coder, json=body)
        assert response.status_code == 403, body
        assert response.json()["detail"]["code"] == "not_whitelisted"
    # Admin 也不能繞過白名單
    assert client.post(f"{base}/models/downloads", headers=admin, json={"name": "not-listed"}).status_code == 403
    assert session.scalars(select(ModelDownload)).all() == [] and source.fetches == []
    assert not llm.model_dir.exists() or not list(llm.model_dir.iterdir())
    denied = audits(session, "llm.model.download.request")
    assert len(denied) == 6 and {a.result for a in denied} == {"denied"}


def test_tc_d01_02_removed_from_whitelist_blocks_pending_request(client, llm, whitelist, admin, coder, base):
    download_id = client.post(f"{base}/models/downloads", headers=coder, json={"name": "small"}).json()["id"]
    assert client.delete("/api/admin/llm/whitelist/small", headers=admin).status_code == 204
    assert client.post(f"/api/admin/llm/downloads/{download_id}/approve", headers=admin).status_code == 404


def test_tc_d01_03_approved_download_record_has_every_field(client, llm, whitelist, install, admin, coder, base,
                                                           session):
    install("small")
    install("gated", token=TOKEN)
    install("remote-code")
    rows = [d for d in client.get("/api/admin/llm/downloads", headers=admin).json() if d["status"] == "completed"]
    assert len(rows) == 3
    for row in rows:
        for column in ("commit", "hash", "time", "user", "token_usage", "reviewer"):
            assert row[column], (row["name"], column)
        assert row["user"] == "ca01" and row["reviewer"] == "admin01"
        assert len(row["commit"]) == 40 and len(row["hash"]) == 64
    usage = {r["name"]: r["token_usage"] for r in rows}
    assert usage["small"]["used"] is False and usage["small"]["result"] == "not_required"
    assert usage["gated"]["used"] is True and len(usage["gated"]["fingerprint"]) == 12 and usage["gated"]["used_at"]
    # 專案成員看得到自己專案的紀錄
    assert len(client.get(f"{base}/models/downloads", headers=coder).json()) == 3
    # Token 本身不落地：資料庫、稽核、回應都找不到
    session.expire_all()
    stored = json.dumps([[d.token_usage, d.message] for d in session.scalars(select(ModelDownload))])
    logged = json.dumps([a.detail for a in session.scalars(select(AuditLog))])
    assert TOKEN not in stored and TOKEN not in logged and TOKEN not in json.dumps(rows)


def test_tc_d01_04_remote_code_needs_admin_approval(client, llm, whitelist, install, admin, coder, base, session):
    install("remote-code")
    for _ in range(3):
        response = client.post(f"{base}/models/remote-code/load", headers=coder)
        assert response.status_code == 403 and response.json()["detail"]["code"] == "remote_code_not_approved"
    assert llm.runtime.loaded() == []
    assert [a.result for a in audits(session, "llm.model.load")] == ["denied"] * 3

    # 非管理者不能核准
    assert client.post("/api/admin/llm/models/remote-code/remote-code-approval", headers=coder).status_code == 403
    approved = client.post("/api/admin/llm/models/remote-code/remote-code-approval", headers=admin)
    assert approved.status_code == 201 and approved.json()["approved_by"] == "admin01"

    loaded = client.post(f"{base}/models/remote-code/load", headers=coder)
    assert loaded.status_code == 200 and loaded.json()["trust_remote_code"] is True
    assert [(r.name, r.trust_remote_code) for r in llm.runtime.loaded()] == [("remote-code", True)]

    # 撤銷後又回到不可執行
    assert client.delete("/api/admin/llm/models/remote-code/remote-code-approval", headers=admin).status_code == 204
    assert client.post(f"{base}/models/remote-code/load", headers=coder).status_code == 403


def test_tc_d01_04_code_found_in_files_is_blocked_even_if_whitelist_says_none(client, llm, source, whitelist, install,
                                                                             coder, base):
    whitelist("sneaky", "org/remote-code", has_remote_code=False)
    # 同一個 repo 已以 remote-code 登記；這裡模擬審核時漏勾「夾帶程式碼」
    install("sneaky")
    assert client.post(f"{base}/models/sneaky/load", headers=coder).status_code == 403


def test_model_without_code_loads_without_trust(client, llm, whitelist, install, coder, base):
    install("small")
    loaded = client.post(f"{base}/models/small/load", headers=coder)
    assert loaded.status_code == 200 and loaded.json()["trust_remote_code"] is False
    assert client.post(f"{base}/models/small/unload", headers=coder).json() == {"name": "small", "loaded": False}
    assert llm.runtime.loaded() == []


def test_tc_b07_04_quantization_and_resources_round_trip(client, llm, whitelist, install, coder, base):
    install("small")
    url = f"{base}/models/small/load-config"
    assert client.get(url, headers=coder).json()["quantization"] == "none"
    for config in ({"quantization": "4bit", "cpu": 8, "memory_gb": 32, "gpu_type": "gpu-exclusive", "gpu_count": 1},
                   {"quantization": "8bit", "cpu": 4, "memory_gb": 24, "gpu_type": "gpu-shared", "gpu_count": 1}):
        saved = client.put(url, headers=coder, json=config)
        assert saved.status_code == 200, saved.text
        reloaded = client.get(url, headers=coder).json()
        assert {k: reloaded[k] for k in config} == config
        client.post(f"{base}/models/small/load", headers=coder)
        request = llm.runtime.loaded()[0]
        assert {k: getattr(request, k) for k in config} == config


def test_tc_b07_04_invalid_load_config_is_rejected(client, llm, whitelist, coder, base):
    url = f"{base}/models/small/load-config"
    ok = {"quantization": "4bit", "cpu": 4, "memory_gb": 16, "gpu_type": "gpu-exclusive", "gpu_count": 1}
    for change in ({"quantization": "2bit"}, {"gpu_type": "tpu"}, {"cpu": 0}, {"gpu_type": "cpu", "gpu_count": 1},
                   {"gpu_count": 0}):
        assert client.put(url, headers=coder, json={**ok, **change}).status_code == 422, change
    assert client.put(f"{base}/models/unknown/load-config", headers=coder, json=ok).status_code == 404


def test_whitelist_validation_and_duplicates(client, llm, whitelist, admin):
    body = {"name": "x", "source": HOST, "repo": "org/x", "revision": "a" * 40, "sha256": "f" * 64}
    assert client.post("/api/admin/llm/whitelist", headers=admin, json={**body, "sha256": "short"}).status_code == 422
    assert client.post("/api/admin/llm/whitelist", headers=admin, json={**body, "name": "../x"}).status_code == 422
    assert client.post("/api/admin/llm/whitelist", headers=admin, json={**body, "name": "small"}).status_code == 409


def test_inspect_shows_commit_hash_and_code_flag(client, llm, source, admin):
    body = client.post("/api/admin/llm/whitelist/inspect", headers=admin,
                       json={"source": HOST, "repo": "org/remote-code", "revision": "c" * 40}).json()
    assert body["sha256"] == source.repos["org/remote-code"].sha256 and body["has_remote_code"] is True


def test_inspect_with_only_a_repo_uses_the_configured_source_and_latest_commit(client, llm, source, admin):
    body = client.post("/api/admin/llm/whitelist/inspect", headers=admin, json={"repo": "org/remote-code"}).json()
    assert body["source"] == HOST and body["commit"] == "c" * 40


def test_inspect_unknown_repo_is_not_found(client, llm, admin):
    assert client.post("/api/admin/llm/whitelist/inspect", headers=admin, json={"repo": "org/none"}).status_code == 404
