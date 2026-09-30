"""TC-B04-02 欄位顯示／隱藏存在伺服器：每位使用者、每個資料集各一份，換瀏覽器或電腦後狀態一致。"""
from sqlalchemy import func, select

from app.models import AuditLog
from app.tabular_api.models import TabularColumnView
from tabular_helpers import PROJECT_ONLY, dataset, member, schema_text, synth, upload  # noqa: F401


def _url(pid, did):
    return f"/api/projects/{pid}/tabular/datasets/{did}/column-view"


def test_tc_b04_02_hidden_columns_round_trip(client, dataset, session):
    pid, headers, did = dataset
    assert client.get(_url(pid, did), headers=headers).json() == {"hidden": [], "saved": False}

    saved = client.put(_url(pid, did), headers=headers, json={"hidden": ["sbp", "age", "bmi"]})
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"hidden": ["sbp", "age", "bmi"], "saved": True}
    # 「換一台電腦」＝不帶任何本機狀態，只用同一個帳號再讀一次
    assert client.get(_url(pid, did), headers=headers).json() == {"hidden": ["sbp", "age", "bmi"], "saved": True}

    assert client.put(_url(pid, did), headers=headers, json={"hidden": []}).json() == {"hidden": [], "saved": True}
    assert client.get(_url(pid, did), headers=headers).json()["hidden"] == []
    # 個人檢視偏好，不寫稽核
    assert session.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action.like("%column%"))) == 0


def test_setting_is_per_user(client, dataset, member):
    pid, owner, did = dataset
    _, viewer = member("vw01", PROJECT_ONLY)
    client.put(_url(pid, did), headers=owner, json={"hidden": ["age"]})
    assert client.get(_url(pid, did), headers=viewer).json() == {"hidden": [], "saved": False}
    assert client.put(_url(pid, did), headers=viewer, json={"hidden": ["bmi"]}).status_code == 200  # 只需讀取權
    assert client.get(_url(pid, did), headers=owner).json()["hidden"] == ["age"]
    assert client.get(_url(pid, did), headers=viewer).json()["hidden"] == ["bmi"]


def test_unknown_or_duplicate_columns_are_422(client, dataset):
    pid, headers, did = dataset
    bad = client.put(_url(pid, did), headers=headers, json={"hidden": ["age", "no_such_column"]})
    assert bad.status_code == 422 and "no_such_column" in bad.json()["detail"]
    dup = client.put(_url(pid, did), headers=headers, json={"hidden": ["age", "age"]})
    assert dup.status_code == 422 and "重複" in dup.json()["detail"]
    assert client.put(_url(pid, did), headers=headers, json={"hidden": "age"}).status_code == 422


def test_non_member_and_missing_dataset(client, dataset, add_user):
    pid, headers, did = dataset
    _, outsider = add_user("outsider")
    assert client.get(_url(pid, did), headers=outsider).status_code == 403
    assert client.put(_url(pid, did), headers=outsider, json={"hidden": []}).status_code == 403
    assert client.get(_url(pid, 999), headers=headers).status_code == 404
    assert client.get(_url(pid, did)).status_code == 401


def test_deleting_dataset_or_project_removes_settings(client, dataset, session, synth, schema_text, add_user):
    from app.permissions import AccountType
    pid, headers, did = dataset
    client.put(_url(pid, did), headers=headers, json={"hidden": ["age"]})
    other = upload(client, pid, headers, (synth / "cohort_02.csv").read_bytes(), schema_text, name="c2").json()
    client.put(_url(pid, other["dataset"]["id"]), headers=headers, json={"hidden": ["bmi"]})
    assert session.scalar(select(func.count()).select_from(TabularColumnView)) == 2

    assert client.delete(f"/api/projects/{pid}/tabular/datasets/{did}", headers=headers).status_code == 204
    assert session.scalars(select(TabularColumnView.dataset_id)).all() == [other["dataset"]["id"]]

    _, admin = add_user("admin01", AccountType.ADMIN)
    assert client.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204
    assert session.scalar(select(func.count()).select_from(TabularColumnView)) == 0
