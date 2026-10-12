"""TC-D01-02～04 模型白名單、下載審核紀錄、遠端程式碼管控（經 Gateway）。執行方式見 llm_support.py。"""
import json

from llm_support import FAKE_HOST, FAKE_TOKEN, documents, llm, unique  # noqa: F401


def test_tc_d01_02_download_outside_whitelist_never_succeeds(api, llm):
    before = len(api.get("/api/admin/llm/downloads", headers=llm.admin).json())
    attempts = [
        {"name": unique("not-listed")},
        {"source": FAKE_HOST, "repo": "fake-org/fake-llm-small"},      # 來源上有，但沒登記進白名單
        {"source": "huggingface.co", "repo": "meta-llama/Llama-3-8B"},
        {"source": "evil.example.com", "repo": "fake-org/fake-llm-small"},
        {"name": "../fake-llm-small"},
    ]
    for body in attempts:
        for headers in (llm.ca, llm.admin):
            response = api.post(f"{llm.base}/models/downloads", headers=headers, json=body)
            assert response.status_code == 403, (body, response.text)
            assert response.json()["detail"]["code"] == "not_whitelisted"
    assert len(api.get("/api/admin/llm/downloads", headers=llm.admin).json()) == before


def test_tc_d01_03_approved_download_record_has_every_field(api, llm):
    names = [unique("d0103-a"), unique("d0103-b"), unique("d0103-c")]
    llm.whitelist_from_source(names[0], "fake-org/fake-llm-small", "a" * 40, license="apache-2.0")
    llm.whitelist_from_source(names[1], "fake-org/fake-llm-gated", "b" * 40, requires_token=True)
    llm.whitelist_from_source(names[2], "fake-org/fake-llm-remote-code", "c" * 40, has_remote_code=True)
    llm.install(llm.ca, names[0])
    llm.install(llm.ca, names[1], token=FAKE_TOKEN)
    llm.install(llm.ca, names[2])
    rows = [d for d in api.get("/api/admin/llm/downloads", headers=llm.admin).json() if d["name"] in names]
    assert len(rows) == 3 and {d["status"] for d in rows} == {"completed"}
    for row in rows:
        for column in ("commit", "hash", "time", "user", "token_usage", "reviewer"):
            assert row[column], (row["name"], column)
        assert (row["user"], row["reviewer"]) == ("ca01", "admin01")
        assert len(row["commit"]) == 40 and len(row["hash"]) == 64
    gated = next(d for d in rows if d["name"] == names[1])
    assert gated["token_usage"]["used"] is True and gated["token_usage"]["fingerprint"]
    assert FAKE_TOKEN not in json.dumps(rows)


def test_tc_d01_04_remote_code_needs_admin_approval(api, llm):
    name = unique("d0104")
    llm.whitelist_from_source(name, "fake-org/fake-llm-remote-code", "c" * 40, has_remote_code=True)
    llm.install(llm.ca, name)
    for _ in range(3):
        response = api.post(f"{llm.base}/models/{name}/load", headers=llm.ca)
        assert response.status_code == 403 and response.json()["detail"]["code"] == "remote_code_not_approved"
    catalog = {m["name"]: m for m in api.get(f"{llm.base}/models/catalog", headers=llm.ca).json()}
    assert catalog[name]["loaded"] is False and catalog[name]["remote_code_approved"] is False
    assert api.post(f"/api/admin/llm/models/{name}/remote-code-approval", headers=llm.ca).status_code == 403
    approved = api.post(f"/api/admin/llm/models/{name}/remote-code-approval", headers=llm.admin)
    assert approved.status_code == 201, approved.text
    loaded = api.post(f"{llm.base}/models/{name}/load", headers=llm.ca)
    if llm.real:
        # 假 repo 沒有權重檔，Ollama 載不起來；這裡只確認已不再被遠端程式碼的管控擋下
        assert loaded.status_code == 422 and "GGUF" in loaded.text, loaded.text
        return
    assert loaded.status_code == 200 and loaded.json()["trust_remote_code"] is True
    assert api.post(f"{llm.base}/models/{name}/unload", headers=llm.ca).status_code == 200
