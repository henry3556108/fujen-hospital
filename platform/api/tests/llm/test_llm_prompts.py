"""Prompt 範本與生成參數：TC-B07-02、TC-B07-05。"""
import pytest

PROMPTS = [
    {"title": "出院摘要", "content": "請把以下病歷整理成出院摘要：{text}", "tags": ["摘要", "病歷"], "visibility": "public"},
    {"title": "衛教單張", "content": "請用白話寫一份衛教單張，主題：{topic}", "tags": ["衛教"], "visibility": "public"},
    {"title": "檢驗判讀", "content": "判讀以下檢驗數值並列出異常項目", "tags": ["檢驗", "判讀"], "visibility": "public"},
    {"title": "我的草稿", "content": "個人用的草稿提示", "tags": ["草稿"], "visibility": "personal"},
    {"title": "英文翻譯", "content": "Translate the summary into English", "tags": ["翻譯", "摘要"], "visibility": "personal"},
    {"title": "會議紀錄", "content": "整理會議紀錄重點", "tags": ["摘要"], "visibility": "personal"},
]


@pytest.fixture
def seeded(client, llm, coder, base):
    created = [client.post(f"{base}/prompts", headers=coder, json=p) for p in PROMPTS]
    assert [r.status_code for r in created] == [201] * 6
    return [r.json() for r in created]


def titles(response):
    assert response.status_code == 200, response.text
    return [p["title"] for p in response.json()]


def test_tc_b07_02_six_prompts_tags_and_five_searches(client, seeded, coder, base):
    for created, wanted in zip(seeded, PROMPTS):
        reloaded = client.get(f"{base}/prompts/{created['id']}", headers=coder).json()
        assert {k: reloaded[k] for k in wanted} == wanted and reloaded["owner"] == "ca01"
    assert titles(client.get(f"{base}/prompts", headers=coder)) == [p["title"] for p in PROMPTS]
    searches = [
        ({"q": "摘要"}, ["出院摘要", "英文翻譯", "會議紀錄"]),          # 標題、內容或 tag 命中
        ({"tag": "摘要"}, ["出院摘要", "英文翻譯", "會議紀錄"]),
        ({"tag": ["摘要", "翻譯"]}, ["英文翻譯"]),                        # 多個 tag 取交集
        ({"q": "TRANSLATE"}, ["英文翻譯"]),                              # 不分大小寫
        ({"q": "檢驗", "visibility": "public"}, ["檢驗判讀"]),
    ]
    for params, expected in searches:
        assert titles(client.get(f"{base}/prompts", headers=coder, params=params)) == expected, params
    assert titles(client.get(f"{base}/prompts", headers=coder, params={"q": "不存在的字"})) == []


def test_tc_b07_02_others_cannot_see_personal_prompts(client, seeded, coder, admin, project, member, base):
    other = member(project, "ca02")
    public = [p["title"] for p in PROMPTS if p["visibility"] == "public"]
    assert titles(client.get(f"{base}/prompts", headers=other)) == public
    assert titles(client.get(f"{base}/prompts", headers=other, params={"q": "草稿"})) == []
    assert titles(client.get(f"{base}/prompts", headers=other, params={"tag": "摘要"})) == ["出院摘要"]
    personal = next(p for p in seeded if p["visibility"] == "personal")
    assert client.get(f"{base}/prompts/{personal['id']}", headers=other).status_code == 404
    assert client.patch(f"{base}/prompts/{personal['id']}", headers=other, json={"title": "x"}).status_code == 404
    assert client.delete(f"{base}/prompts/{personal['id']}", headers=other).status_code == 404
    # 管理者也看不到別人的個人範本
    assert titles(client.get(f"{base}/prompts", headers=admin)) == public
    # 公開範本別人看得到但不能改
    shared = next(p for p in seeded if p["visibility"] == "public")
    assert client.patch(f"{base}/prompts/{shared['id']}", headers=other, json={"title": "x"}).status_code == 403


def test_prompts_are_project_scoped(client, seeded, session, member, base):
    from app.models import Project
    p2 = Project(name="P-other")
    session.add(p2)
    session.commit()
    outsider = member(p2, "ca09")
    assert client.get(f"{base}/prompts", headers=outsider).status_code == 403
    assert client.get(f"/api/projects/{p2.id}/llm/prompts", headers=outsider).json() == []
    assert client.get(f"/api/projects/{p2.id}/llm/prompts/{seeded[0]['id']}", headers=outsider).status_code == 404


def test_prompt_update_delete_and_validation(client, seeded, coder, viewer, base):
    pid = seeded[3]["id"]
    updated = client.patch(f"{base}/prompts/{pid}", headers=coder,
                           json={"visibility": "public", "tags": ["草稿", " 草稿 ", "新"]})
    assert updated.status_code == 200 and updated.json()["tags"] == ["草稿", "新"]
    assert updated.json()["visibility"] == "public"
    assert client.delete(f"{base}/prompts/{pid}", headers=coder).status_code == 204
    assert client.get(f"{base}/prompts/{pid}", headers=coder).status_code == 404
    bad = [{"title": "", "content": "x"}, {"title": "t", "content": "x", "visibility": "secret"},
           {"title": "t", "content": "x", "tags": ["t" * 33]}, {"title": "t", "content": "x", "tags": [str(i) for i in range(11)]}]
    for body in bad:
        assert client.post(f"{base}/prompts", headers=coder, json=body).status_code == 422, body
    assert client.post(f"{base}/prompts", headers=viewer, json=PROMPTS[0]).status_code == 403


def test_tc_b07_05_seven_generation_params_round_trip(client, llm, coder, project, member, base):
    url = f"{base}/generation-params"
    defaults = client.get(url, headers=coder).json()
    assert set(defaults) == {"temperature", "max_new_tokens", "repetition_penalty", "length_penalty", "top_k",
                             "top_p", "system_prompt"}
    wanted = {"temperature": 0.35, "max_new_tokens": 256, "repetition_penalty": 1.15, "length_penalty": 0.8,
              "top_k": 40, "top_p": 0.85, "system_prompt": "你是輔大醫院的院內助理，只根據提供的資料回答。"}
    assert client.put(url, headers=coder, json=wanted).json() == wanted
    for _ in range(3):
        assert client.get(url, headers=coder).json() == wanted
    # 每人一份：別人的設定不受影響
    assert client.get(url, headers=member(project, "ca02")).json() == defaults
    for bad in ({"temperature": 3}, {"top_p": 1.5}, {"max_new_tokens": 0}, {"extra": 1}):
        assert client.put(url, headers=coder, json={**wanted, **bad}).status_code == 422, bad
    assert client.get(url, headers=coder).json() == wanted
