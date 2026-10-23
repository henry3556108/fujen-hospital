from sqlalchemy import select

from app.models import AuditLog
from tabular_helpers import PROJECT_ONLY, dataset, member, schema_text, synth, upload  # noqa: F401


def _url(pid, did="", suffix=""):
    return f"/api/projects/{pid}/tabular/datasets" + (f"/{did}" if did != "" else "") + suffix


def test_list_datasets_only_this_project(client, member, synth, schema_text):
    pid, headers = member("pi01")
    other_pid, other_headers = member("pi02", project_name="P9-other")
    raw = (synth / "cohort_01.csv").read_bytes()
    upload(client, pid, headers, raw, schema_text, name="a")
    upload(client, pid, headers, raw, schema_text, name="b")
    upload(client, other_pid, other_headers, raw, schema_text, name="c")
    response = client.get(_url(pid), headers=headers)
    assert response.status_code == 200
    assert [d["name"] for d in response.json()] == ["a", "b"]


def test_get_dataset_includes_columns_for_show_hide(client, dataset):
    pid, headers, did = dataset
    body = client.get(_url(pid, did), headers=headers).json()
    assert body["id"] == did and body["valid_rows"] == 100
    cols = {c["name"]: c for c in body["columns"]}
    assert list(cols)[:3] == ["patient_id", "age", "sex"]
    assert cols["age"]["kind"] == "numeric" and cols["sex"]["kind"] == "categorical"
    assert cols["glucose"]["missing"] == 5


def test_get_report(client, member, synth, schema_text):
    pid, headers = member("pi01")
    body = upload(client, pid, headers, (synth / "bad.csv").read_bytes(), schema_text, name="bad").json()
    report = client.get(_url(pid, body["dataset"]["id"], "/report"), headers=headers)
    assert report.status_code == 200 and report.json() == body["report"]


def test_dataset_of_other_project_is_404(client, member, synth, schema_text):
    pid, headers = member("pi01")
    other_pid, other_headers = member("pi02", project_name="P9-other")
    did = upload(client, other_pid, other_headers, (synth / "cohort_01.csv").read_bytes(), schema_text,
                 name="x").json()["dataset"]["id"]
    assert client.get(_url(pid, did), headers=headers).status_code == 404
    assert client.delete(_url(pid, did), headers=headers).status_code == 404
    assert client.get(_url(pid, 999), headers=headers).json()["detail"] == "找不到資料集 999"


def test_delete_removes_row_and_objects_and_is_audited(client, dataset, store, session):
    pid, headers, did = dataset
    assert client.delete(_url(pid, did), headers=headers).status_code == 204
    assert client.get(_url(pid, did), headers=headers).status_code == 404
    assert store.list(f"projects/{pid}/tabular/{did}/") == []
    entry = session.scalars(select(AuditLog).where(AuditLog.action == "tabular_delete")).one()
    assert entry.category == "dataset" and entry.target == f"tabular_dataset:{did}"
    assert entry.detail["valid_rows"] == 100 and entry.detail["project_id"] == pid


def test_viewer_can_list_but_not_delete(client, dataset, member):
    pid, _, did = dataset
    _, viewer = member("vw01", PROJECT_ONLY)
    assert client.get(_url(pid), headers=viewer).status_code == 200
    response = client.delete(_url(pid, did), headers=viewer)
    assert response.status_code == 403 and response.json()["detail"]["permission"] == "training"
    assert client.get(_url(pid, did), headers=viewer).status_code == 200


def test_non_member_cannot_read(client, dataset, add_user):
    pid, _, did = dataset
    _, outsider = add_user("user01")
    assert client.get(_url(pid), headers=outsider).status_code == 403
    assert client.get(_url(pid, did), headers=outsider).status_code == 403
