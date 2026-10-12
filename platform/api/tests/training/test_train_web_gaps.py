"""網頁缺口：授權對象的帳號查詢、部署回傳模型名稱、訓練紀錄分頁。"""
import pytest

from app.models import Membership, Project, User
from app.permissions import Role
from app.training.models import DatasetVersion, TrainingRun
from conftest_training import finish, ok, setting_body, start


# ---------------------------------------------------------------- 帳號查詢

def lookup(pid):
    return f"/api/projects/{pid}/user-lookup"


def test_lookup_by_prefix_members_first_and_only_username(client, pi, member, add_user, project, session):
    member("md01", Role.MEDICAL_DOCTOR)
    member("md02", Role.VIEWER)
    add_user("md99")                              # 不是本專案成員
    other = Project(name="P2")
    session.add(other)
    session.commit()
    member("md10", Role.VIEWER, target=other)     # 別的專案的成員，對 P1 來說也不是成員
    add_user("vw01")

    out = ok(client.get(lookup(project.id), headers=pi, params={"q": "MD"}))
    assert out == [{"username": "md01", "member": True}, {"username": "md02", "member": True},
                   {"username": "md10", "member": False}, {"username": "md99", "member": False}]
    assert all(set(row) == {"username", "member"} for row in out), "不回 Email、帳號類型等其他欄位"
    assert [r["username"] for r in ok(client.get(lookup(project.id), headers=pi,
                                                 params={"q": "md", "limit": 3}))] == ["md01", "md02", "md10"]
    assert ok(client.get(lookup(project.id), headers=pi, params={"q": "zz"})) == []


def test_lookup_treats_wildcards_literally_and_validates_input(client, pi, add_user, project):
    add_user("ab_c")
    add_user("abxc")
    assert [r["username"] for r in ok(client.get(lookup(project.id), headers=pi, params={"q": "ab_"}))] == ["ab_c"]
    assert ok(client.get(lookup(project.id), headers=pi, params={"q": "%"})) == []
    for params in ({}, {"q": ""}, {"q": "a" * 65}, {"q": "a", "limit": 21}, {"q": "a", "limit": 0}):
        assert client.get(lookup(project.id), headers=pi, params=params).status_code == 422, params


def test_lookup_needs_training_or_coding_in_the_project(client, member, add_user, admin, project, session):
    viewer = member("vw01", Role.VIEWER)            # project + prediction
    doctor = member("md01", Role.MEDICAL_DOCTOR)    # 沒有 training、coding
    coder = member("ca01", Role.CODER_ASSISTANT)    # training + coding
    ra = member("ra01", Role.RESEARCH_ASSISTANT)    # training
    outsider = add_user("user01")[1]
    llm_only = member("llm01", Role.VIEWER)
    user = session.query(User).filter_by(username="llm01").one()
    row = session.query(Membership).filter_by(user_id=user.id, project_id=project.id).one()
    row.permissions = ["project", "coding"]          # 只有 coding（發布 LLM 服務）也可以查
    session.commit()

    for headers in (viewer, doctor, outsider):
        response = client.get(lookup(project.id), headers=headers, params={"q": "m"})
        assert response.status_code == 403, response.text
        assert response.json()["detail"]["message"] == "你沒有 training或coding 權限"
    for headers in (coder, ra, llm_only, admin):
        assert client.get(lookup(project.id), headers=headers, params={"q": "m"}).status_code == 200
    assert client.get(lookup(project.id), params={"q": "m"}).status_code == 401
    assert client.get(lookup(99999), headers=coder, params={"q": "m"}).status_code == 403
    assert client.get(lookup(99999), headers=admin, params={"q": "m"}).status_code == 404


# ---------------------------------------------------------------- 部署回傳模型名稱

def test_deployment_carries_model_name_and_kind(client, pi, member, project, backend, inference, table, tmp_path):
    member("md01", Role.MEDICAL_DOCTOR)
    run = finish(client, backend, pi, start(client, pi, project.id,
                                            setting_body("tabular_classification", dataset_id=table)), tmp_path)
    model = ok(client.get(f"/api/projects/{project.id}/models/{run['model_id']}", headers=pi))
    base = f"/api/projects/{project.id}/deployments"
    created = ok(client.post(base, headers=pi, json={"model_id": model["id"], "title": "糖尿病預測",
                                                     "allowed_users": ["md01"]}), 201)
    assert (created["model_name"], created["model_kind"]) == (model["name"], "tabular_classification")
    listed = ok(client.get(base, headers=pi))
    assert [(d["model_name"], d["title"]) for d in listed] == [(model["name"], "糖尿病預測")]
    updated = ok(client.put(f"{base}/{created['id']}/access", headers=pi, json={"allowed_users": ["md01", "pi01"]}))
    assert updated["model_name"] == model["name"]


# ---------------------------------------------------------------- 訓練紀錄分頁

@pytest.fixture
def many_runs(session, project):
    version = DatasetVersion(project_id=project.id, kind="tabular_classification", content_hash="h" * 64,
                             manifest_key="m", item_count=1, source={}, created_by="pi01")
    session.add(version)
    session.flush()
    for i in range(7):
        session.add(TrainingRun(project_id=project.id, dataset_version_id=version.id, name=f"run-{i}",
                                kind="tabular_classification", executor="fake", config={}, seed=1,
                                status="succeeded", created_by="pi01" if i % 2 == 0 else "ra01"))
    session.commit()
    return [r.id for r in session.query(TrainingRun).order_by(TrainingRun.id)]


def test_runs_are_paged_newest_first(client, pi, member, project, backend, many_runs):
    base = f"/api/projects/{project.id}/training/runs"
    first = ok(client.get(base, headers=pi, params={"limit": 3}))
    assert (first["total"], first["offset"], first["limit"]) == (7, 0, 3)
    assert [r["id"] for r in first["items"]] == many_runs[::-1][:3]
    last = ok(client.get(base, headers=pi, params={"limit": 3, "offset": 6}))
    assert [r["id"] for r in last["items"]] == [many_runs[0]]
    mine = ok(client.get(base, headers=pi, params={"limit": 10, "mine": "true"}))
    assert mine["total"] == 4 and {r["created_by"] for r in mine["items"]} == {"pi01"}
    ra = member("ra01", Role.RESEARCH_ASSISTANT)
    assert ok(client.get(base, headers=ra, params={"limit": 10, "mine": "true"}))["total"] == 3
    # 不帶 limit：既有行為，完整陣列、由舊到新
    assert [r["id"] for r in ok(client.get(base, headers=pi))] == many_runs
    assert len(ok(client.get(base, headers=pi, params={"mine": "true"}))) == 4
    for params in ({"limit": 0}, {"limit": 201}, {"limit": 5, "offset": -1}):
        assert client.get(base, headers=pi, params=params).status_code == 422, params
