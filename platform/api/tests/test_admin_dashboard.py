"""Admin Dashboard（A-03「可檢視 Dashboard 頁面」、TC-A03-10）：每個數字都與資料庫的 count 一致。"""
from app.imaging.models import ImagingStudy
from app.models import LabelGroup, LabelGroupMember, Membership, Project
from app.permissions import AccountType
from app.scheduling.models import GpuGroup, Job
from app.tabular_api.models import TabularDataset


def _dataset(project_id, name):
    return TabularDataset(project_id=project_id, name=name, object_key="k", original_key="o", schema={},
                          total_rows=1, valid_rows=1, rejected_rows=0, created_by="ra01")


def test_dashboard_counts_match_the_database(client, add_user, session):
    _, admin = add_user("admin01", AccountType.ADMIN)
    add_user("admin02", AccountType.ADMIN)
    users = [add_user(n)[0] for n in ("pi01", "md01", "ra01")]
    p1, p2, p3 = Project(name="P1"), Project(name="P2"), Project(name="P3")
    session.add_all([p1, p2, p3])
    session.flush()
    session.add_all([Membership(user_id=u.id, project_id=p1.id, role="viewer", permissions=[]) for u in users])
    session.add(Membership(user_id=users[0].id, project_id=p2.id, role="viewer", permissions=[]))
    g = LabelGroup(project_id=p1.id, name="G1", created_by="admin01")
    session.add_all([g, LabelGroup(project_id=p1.id, name="G2", created_by="admin01")])
    session.flush()
    session.add(LabelGroupMember(group_id=g.id, user_id=users[1].id))
    session.add_all([_dataset(p2.id, "d1"), _dataset(p2.id, "d2")])
    session.add_all([ImagingStudy(project_id=p1.id, study_instance_uid=f"1.2.{i}") for i in range(3)])
    session.add_all([GpuGroup(name="gpu-exclusive", pool="gpu-exclusive", gpu_count=1, mode="exclusive"),
                     GpuGroup(name="gpu-shared", pool="gpu-shared", gpu_count=1, mode="shared")])
    session.add_all([Job(project_id=p1.id, user="ra01", kind="training", queue="q", status=s)
                     for s in ("queued", "running", "running", "succeeded", "failed")])
    session.commit()

    response = client.get("/api/admin/dashboard", headers=admin)
    assert response.status_code == 200
    got = response.json()
    assert got["accounts"] == {"total": 5, "admin": 2, "user": 3}
    assert got["projects"] == 3
    assert got["memberships"] == 4
    assert got["labeling_groups"] == 2
    assert got["labeling_group_members"] == 1
    assert got["tabular_datasets"] == 2
    assert got["imaging_studies"] == 3
    assert got["gpu_groups"] == 2
    assert got["jobs"] == {"total": 5, "by_status": {"queued": 1, "running": 2, "succeeded": 1, "failed": 1,
                                                    "cancelled": 0, "held": 0}}
    assert got["generated_at"]
    per = {p["name"]: p for p in got["per_project"]}
    assert list(per) == ["P1", "P2", "P3"]
    assert per["P1"] == {"id": p1.id, "name": "P1", "gpu_group": None, "members": 3, "labeling_groups": 2,
                         "tabular_datasets": 0, "imaging_studies": 3, "jobs": 5}
    assert per["P2"]["members"] == 1 and per["P2"]["tabular_datasets"] == 2
    assert per["P3"] == {"id": p3.id, "name": "P3", "gpu_group": None, "members": 0, "labeling_groups": 0,
                         "tabular_datasets": 0, "imaging_studies": 0, "jobs": 0}


def test_dashboard_is_admin_only(client, add_user):
    _, user = add_user("pi01")
    assert client.get("/api/admin/dashboard", headers=user).status_code == 403
    assert client.get("/api/admin/dashboard").status_code == 401
