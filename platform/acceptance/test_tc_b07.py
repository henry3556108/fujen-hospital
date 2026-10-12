"""TC-B07 大型語言模型與 RAG（經 Gateway）。執行方式見 llm_support.py。

TC-B07-03、TC-B07-08 的頁面行為（10 秒內顯示、30 秒內提示重試、頁面不卡住）在 platform/web/e2e/llm.spec.ts；
這裡驗證同一條路徑的 API 行為。時間數字要在甲方環境重跑才算數。
"""
import os
import subprocess
import time

import httpx
import pytest

import platform_exec as pe

from llm_support import (FAKE_TOKEN, HF_HOST, PRELOAD, content_hash, documents, llm, reply_text,  # noqa: F401
                         sent_params, unique)

# 真的從 Hugging Face 下載用的小模型（約 80 MB）：commit 固定、只取 Q4_K_M 一個檔
HF_SMALL = ("nomic-ai/nomic-embed-text-v1.5-GGUF", "0188c9bf409793f810680a5a431e7b899c46104c",
            ["*Q4_K_M.gguf"])
HF_GATED = "google/gemma-3-1b-it"      # 需要同意授權的 repo：沒有 Token 不能取得檔案


def need_real(llm):
    if not llm.real:
        pytest.skip("需要真模型環境（compose.ollama.yaml）")


def hf_commit(repo: str) -> str:
    try:
        return httpx.get(f"https://{HF_HOST}/api/models/{repo}", timeout=30).json()["sha"]
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        pytest.skip(f"開發機連不到 Hugging Face：{exc}")


def test_tc_b07_01_real_huggingface_download_by_commit(api, llm):
    """真的從 Hugging Face 下載：依白名單的 commit 與 hash 核對，只取登記的檔案，刪除後可再下載。"""
    need_real(llm)
    repo, commit, files = HF_SMALL
    name = unique("b0701-hf")
    entry = llm.whitelist_from_hf(name, repo, commit, files, license="apache-2.0")
    assert entry["files"] == files
    done = llm.install(llm.ca, name)
    assert (done["status"], done["mode"], done["commit"]) == ("completed", "online", commit), done
    assert done["hash"] == entry["sha256"]
    catalog = {m["name"]: m for m in api.get(f"{llm.base}/models/catalog", headers=llm.ca).json()}
    assert catalog[name]["installed"] is True
    assert api.delete(f"{llm.base}/models/{name}", headers=llm.ca).status_code == 204


def test_tc_b07_01_real_huggingface_gated_needs_token(api, llm):
    need_real(llm)
    commit = hf_commit(HF_GATED)
    body = {"source": HF_HOST, "repo": HF_GATED, "revision": commit}
    refused = api.post("/api/admin/llm/whitelist/inspect", headers=llm.admin, timeout=120, json=body)
    assert refused.status_code == 403, refused.text
    token = os.environ.get("HF_TOKEN")
    if not token:
        pytest.skip("沒有設定 HF_TOKEN，略過有 Token 的那一段")
    allowed = api.post("/api/admin/llm/whitelist/inspect", headers=llm.admin, timeout=120,
                       json={**body, "token": token, "files": ["config.json"]})
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["gated"] is True


def test_tc_b07_01_download_by_name_and_token_then_delete(api, llm):
    name = unique("b0701")
    llm.whitelist_from_source(name, "fake-org/fake-llm-gated", "b" * 40, requires_token=True)
    done = llm.install(llm.ca, name, token=FAKE_TOKEN)
    assert (done["status"], done["mode"]) == ("completed", "online")
    catalog = {m["name"]: m for m in api.get(f"{llm.base}/models/catalog", headers=llm.ca).json()}
    assert catalog[name]["installed"] is True
    assert api.delete(f"{llm.base}/models/{name}", headers=llm.ca).status_code == 204
    catalog = {m["name"]: m for m in api.get(f"{llm.base}/models/catalog", headers=llm.ca).json()}
    assert catalog[name]["installed"] is False
    assert api.delete(f"{llm.base}/models/{name}", headers=llm.ca).status_code == 404


def test_tc_b07_01_offline_preload_without_outbound_network(api, llm):
    """白名單登記的來源連不上（本機沒有這個來源）時，改從離線預載目錄取得，並核對 commit 與 hash。"""
    name = "offline-small"
    folder = PRELOAD / name
    files = {p.name: p.read_bytes() for p in folder.iterdir() if p.name != "manifest.json"}
    api.delete(f"{llm.base}/models/{name}", headers=llm.admin)
    api.delete(f"/api/admin/llm/whitelist/{name}", headers=llm.admin)
    llm.whitelist(name, source="models.offline.invalid", repo="offline-org/offline-small", revision="0ff1" * 10,
                  sha256=content_hash(files), license="apache-2.0")
    done = llm.install(llm.ca, name)
    assert (done["status"], done["mode"], done["hash"]) == ("completed", "offline", content_hash(files))


def test_tc_b07_02_prompt_templates(api, llm):
    mark = unique("b0702")
    prompts = [
        {"title": f"{mark} 出院摘要", "content": "請整理成出院摘要：{input}", "tags": [mark, "摘要"], "visibility": "public"},
        {"title": f"{mark} 衛教單張", "content": "請寫衛教單張", "tags": [mark, "衛教"], "visibility": "public"},
        {"title": f"{mark} 檢驗判讀", "content": "判讀檢驗數值", "tags": [mark, "檢驗"], "visibility": "public"},
        {"title": f"{mark} 我的草稿", "content": "個人草稿", "tags": [mark, "草稿"], "visibility": "personal"},
        {"title": f"{mark} 英文翻譯", "content": "Translate the summary", "tags": [mark, "摘要"], "visibility": "personal"},
        {"title": f"{mark} 會議紀錄", "content": "整理會議重點", "tags": [mark, "摘要"], "visibility": "personal"},
    ]
    created = []
    for body in prompts:
        r = api.post(f"{llm.base}/prompts", headers=llm.ca, json=body)
        assert r.status_code == 201, r.text
        created.append(r.json())
        llm.later("DELETE", f"{llm.base}/prompts/{r.json()['id']}", llm.ca)
    for saved, wanted in zip(created, prompts):
        reloaded = api.get(f"{llm.base}/prompts/{saved['id']}", headers=llm.ca).json()
        assert {k: reloaded[k] for k in wanted} == wanted

    def titles(headers, **params):
        rows = api.get(f"{llm.base}/prompts", headers=headers, params={"tag": [mark, *params.pop("tags", [])], **params})
        assert rows.status_code == 200, rows.text
        return [p["title"].removeprefix(mark + " ") for p in rows.json()]

    searches = [({}, ["出院摘要", "衛教單張", "檢驗判讀", "我的草稿", "英文翻譯", "會議紀錄"]),
                ({"tags": ["摘要"]}, ["出院摘要", "英文翻譯", "會議紀錄"]),
                ({"q": "translate"}, ["英文翻譯"]),
                ({"q": "衛教"}, ["衛教單張"]),
                ({"visibility": "personal", "tags": ["摘要"]}, ["英文翻譯", "會議紀錄"])]
    for params, expected in searches:
        assert titles(llm.ca, **dict(params)) == expected, params

    # 別人（同專案的另一位成員、管理者）看不到個人範本
    other = llm.join("pi01", "principal_investigator")
    for headers in (other, llm.admin):
        assert titles(headers) == ["出院摘要", "衛教單張", "檢驗判讀"]
        assert api.get(f"{llm.base}/prompts/{created[3]['id']}", headers=headers).status_code == 404
    assert api.get(f"{llm.base}/prompts", headers=llm.vw).status_code == 403


def test_tc_b07_03_twenty_messages_each_within_ten_seconds(api, llm, documents):
    kb = llm.knowledge_base(llm.ca, documents)
    sessions = {"free": None, "kb": None}
    slowest = 0.0
    for i in range(20):
        mode = "free" if i % 2 == 0 else "kb"
        body = {"mode": mode, "message": f"第 {i + 1} 則：夜間門診是星期幾", "session_id": sessions[mode]}
        if mode == "kb":
            body["kb_id"] = kb["id"]
        started = time.monotonic()
        answer = api.post(f"{llm.base}/chat", headers=llm.ca, json=body, timeout=30)
        slowest = max(slowest, time.monotonic() - started)
        assert answer.status_code == 200, answer.text
        sessions[mode] = answer.json()["session_id"]
        assert answer.json()["message"]["content"]
        assert bool(answer.json()["message"]["sources"]) == (mode == "kb")
    assert slowest < 10, f"最慢一則 {slowest:.1f} 秒"
    for session_id in sessions.values():
        conversation = api.get(f"{llm.base}/chat/sessions/{session_id}", headers=llm.ca).json()
        assert len(conversation["messages"]) == 20


def test_tc_b07_03_prompt_and_rag_alone_and_combined(api, llm, documents):
    """Playground 套用公開與個人範本各至少 1 次；提示詞、檢索增強、兩者混合各 3 次，呼叫紀錄可查。"""
    kb = llm.knowledge_base(llm.ca, documents)
    mark = unique("b0703")
    templates = []
    for visibility in ("public", "personal"):
        r = api.post(f"{llm.base}/prompts", headers=llm.ca, json={
            "title": f"{mark} {visibility}", "content": f"請以條列方式簡短回答（{visibility}）：{{input}}",
            "tags": [mark], "visibility": visibility})
        assert r.status_code == 201, r.text
        llm.later("DELETE", f"{llm.base}/prompts/{r.json()['id']}", llm.ca)
        templates.append(r.json())
    questions = ["夜間門診是星期幾", "資訊室分機幾號", "乾洗手要搓多久"]
    cases = ([("prompt", templates[i % 2], None, q) for i, q in enumerate(questions)]
             + [("rag", None, kb["id"], q) for q in questions]
             + [("both", templates[(i + 1) % 2], kb["id"], q) for i, q in enumerate(questions)])
    for kind, template, kb_id, question in cases:
        body = {"mode": "kb" if kb_id else "free", "message": question, "kb_id": kb_id,
                "prompt_id": template["id"] if template else None}
        answer = api.post(f"{llm.base}/chat", headers=llm.ca, json=body, timeout=60)
        assert answer.status_code == 200, (kind, answer.text)
        call = api.get(f"{llm.base}/calls/{answer.json()['call_id']}", headers=llm.ca).json()
        assert call["prompt_id"] == body["prompt_id"], kind
        assert call["context_source"] == ("vector" if kb_id else "none"), kind
        assert bool(call["context_refs"]) == bool(kb_id), kind
        user_message = call["request"]["messages"][-1]["content"]
        if template:
            assert user_message == template["content"].replace("{input}", question), kind
        else:
            assert user_message == question, kind
        assert reply_text(call["response"]) == answer.json()["message"]["content"]


def test_tc_b07_04_quantization_settings_are_saved(api, llm):
    name = unique("b0704")
    llm.whitelist_from_source(name, "fake-org/fake-llm-small", "a" * 40)
    url = f"{llm.base}/models/{name}/load-config"
    for config in ({"quantization": "4bit", "cpu": 8, "memory_gb": 32, "gpu_type": "gpu-exclusive", "gpu_count": 1},
                   {"quantization": "8bit", "cpu": 4, "memory_gb": 24, "gpu_type": "gpu-shared", "gpu_count": 1}):
        assert api.put(url, headers=llm.ca, json=config).status_code == 200
        reloaded = api.get(url, headers=llm.ca).json()
        assert {k: reloaded[k] for k in config} == config


def test_tc_b07_04_real_model_loads_in_4bit_and_8bit(api, llm):
    """真的以 4-bit、8-bit 載入對話模型，從 Ollama 讀回實際的量化等級與 CPU 執行緒數；結束時恢復原設定。"""
    need_real(llm)
    name = llm.chat_model
    url = f"{llm.base}/models/{name}"
    original = api.get(f"{url}/load-config", headers=llm.ca).json()
    keys = ("quantization", "cpu", "memory_gb", "gpu_type", "gpu_count")
    try:
        for quantization, level, cpu in (("4bit", "Q4_K_M", 6), ("8bit", "Q8_0", 4)):
            config = {**{k: original[k] for k in keys}, "quantization": quantization, "cpu": cpu}
            assert api.put(f"{url}/load-config", headers=llm.ca, json=config).status_code == 200
            loaded = api.post(f"{url}/load", headers=llm.ca, timeout=300)
            assert loaded.status_code == 200, loaded.text
            runtime = api.get(f"{url}/runtime", headers=llm.ca).json()["runtime"]
            assert (runtime["running"], runtime["quantization_level"], runtime["num_thread"]) == (True, level, cpu)
            assert runtime["processor"] == "gpu"
            answer = api.post(f"{llm.base}/chat", headers=llm.ca, timeout=60,
                              json={"mode": "free", "message": "用一句話說明手部衛生的重要性", "model": name})
            assert answer.status_code == 200 and answer.json()["message"]["content"], answer.text
    finally:
        api.put(f"{url}/load-config", headers=llm.ca, json={k: original[k] for k in keys})
        api.post(f"{url}/load", headers=llm.ca, timeout=300)


def test_tc_b07_05_generation_params_round_trip_and_reach_the_model(api, llm):
    url = f"{llm.base}/generation-params"
    original = api.get(url, headers=llm.ca).json()
    wanted = {"temperature": 0.35, "max_new_tokens": 256, "repetition_penalty": 1.15, "length_penalty": 0.8,
              "top_k": 40, "top_p": 0.85, "system_prompt": "你是輔大醫院的院內助理。"}
    try:
        assert api.put(url, headers=llm.ca, json=wanted).json() == wanted
        for _ in range(3):
            assert api.get(url, headers=llm.ca).json() == wanted
        answer = api.post(f"{llm.base}/chat", headers=llm.ca, json={"mode": "free", "message": "hi"},
                          timeout=60).json()
        call = api.get(f"{llm.base}/calls/{answer['call_id']}", headers=llm.ca).json()
        sent = sent_params(call["request"])
        expected = {"temperature": 0.35, "max_tokens": 256, "repetition_penalty": 1.15, "top_k": 40, "top_p": 0.85}
        if not llm.real:
            # 假模型把收到的參數寫回回覆；Ollama（llama.cpp）沒有 length_penalty（只對 beam search 有效），不送出
            expected["length_penalty"] = 0.8
            for key, value in expected.items():
                assert f"{key}={value}" in answer["message"]["content"], key
        assert {k: sent.get(k) for k in expected} == expected, sent
        assert call["request"]["messages"][0] == {"role": "system", "content": wanted["system_prompt"]}
    finally:
        api.put(url, headers=llm.ca, json=original)


def test_tc_b07_06_six_formats_build_and_mount(api, llm, documents):
    kb = llm.knowledge_base(llm.ca, documents)
    assert kb["build"]["counts"] == {"indexed": 6, "duplicate": 0, "failed": 0}
    assert sorted(r["document"]["format"] for r in kb["build"]["results"]) == sorted(documents)
    url = f"{llm.base}/knowledge-bases/{kb['id']}"
    assert api.get(url, headers=llm.ca).json()["documents"] == 6
    for fmt, (filename, _, phrase) in documents.items():
        hits = api.post(f"{url}/search", headers=llm.ca, json={"query": phrase, "k": 2}).json()
        assert hits and hits[0]["filename"] == filename and phrase in hits[0]["content"], fmt
    answer = api.post(f"{llm.base}/chat", headers=llm.ca, timeout=60,
                      json={"mode": "kb", "kb_id": kb["id"], "message": "體內有心律調節器可以做磁振造影嗎"}).json()
    assert answer["message"]["sources"][0]["filename"] == documents["docx"][0]
    call = api.get(f"{llm.base}/calls/{answer['call_id']}", headers=llm.ca).json()
    assert call["context_source"] == "vector" and call["context_refs"][0]["filename"] == documents["docx"][0]
    assert "心律調節器" in call["request"]["messages"][0]["content"]     # 檢索到的段落放進系統訊息
    if not llm.real:
        assert "context:" in answer["message"]["content"]
    assert api.get(url, headers=llm.vw).status_code == 403


def test_tc_b07_07_published_api_through_gateway(api, llm, auth, documents):
    kb = llm.knowledge_base(llm.ca, documents)
    slug = unique("sop-qa")
    service = api.post(f"{llm.base}/services", headers=llm.ca,
                       json={"slug": slug, "name": "院內規範問答", "kb_id": kb["id"], "grants": ["md01"]})
    assert service.status_code == 201, service.text
    llm.later("DELETE", f"{llm.base}/services/{service.json()['id']}", llm.ca)
    endpoint = service.json()["endpoint"]
    caller = auth("md01")          # 不是 P3 的成員，只在授權名單內
    for question in ("夜間門診是星期幾", "資訊室分機幾號", "乾洗手要搓多久"):
        response = api.post(endpoint, headers=caller, json={"question": question})
        assert response.status_code == 200, response.text
        assert response.json()["answer"] and response.json()["sources"]
    outcomes = [api.post(endpoint, json={"question": "x"}).status_code,
                api.post(endpoint, headers={"Authorization": "Bearer forged"}, json={"question": "x"}).status_code,
                api.post(endpoint, headers=auth("user01"), json={"question": "x"}).status_code,
                api.post(endpoint, headers=llm.vw, json={"question": "x"}).status_code,
                api.post(endpoint, headers=llm.ca, json={"question": "x"}).status_code]
    assert outcomes == [401, 401, 403, 403, 403]


def test_tc_b07_08_model_service_down(api, llm):
    if not pe.AVAILABLE:
        pytest.skip(pe.REASON)

    started = api.post(f"{llm.base}/chat", headers=llm.ca, timeout=60,
                       json={"mode": "free", "message": "先問一題"}).json()
    pe.stop(llm.service)
    try:
        begin = time.monotonic()
        answer = api.post(f"{llm.base}/chat", headers=llm.ca, timeout=35,
                          json={"mode": "free", "message": "還在嗎", "session_id": started["session_id"]})
        elapsed = time.monotonic() - begin
        assert answer.status_code in (503, 504), answer.text
        assert answer.json()["detail"]["retry"] is True and "重試" in answer.json()["detail"]["message"]
        assert elapsed < 30, f"{elapsed:.1f} 秒才回應"
        # 平台其他功能不受影響
        assert api.get(f"{llm.base}/prompts", headers=llm.ca).status_code == 200
    finally:
        pe.start(llm.service)
    for _ in range(90):         # Ollama 重啟後要重新把模型載入 GPU
        again = api.post(f"{llm.base}/chat", headers=llm.ca, timeout=60,
                         json={"mode": "free", "message": "恢復了嗎", "session_id": started["session_id"]})
        if again.status_code == 200:
            break
        time.sleep(1)
    assert again.status_code == 200, again.text
    conversation = api.get(f"{llm.base}/chat/sessions/{started['session_id']}", headers=llm.ca).json()
    assert [m["content"] for m in conversation["messages"] if m["role"] == "user"] == ["先問一題", "恢復了嗎"]
