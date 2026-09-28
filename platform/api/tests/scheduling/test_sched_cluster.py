from sqlalchemy import select

from app.models import AuditLog

NODES = "/api/admin/cluster/nodes"
DASHBOARD = "/api/admin/cluster/gpu-dashboard"
SHARED = "/api/admin/cluster/shared-scheduling"


def test_tc_c01_01_node_list_matches_backend(client, backend, admin):
    rows = client.get(NODES, headers=admin).json()
    assert sorted(r["name"] for r in rows) == sorted(n.name for n in backend.nodes())
    gpu = next(r for r in rows if r["name"] == "gpu-exclusive-1")
    assert gpu == {"name": "gpu-exclusive-1", "pool": "gpu-exclusive", "ready": True, "gpu_capacity": 2,
                   "gpu_allocatable": 2, "gpu_physical": 2}


def test_new_node_appears_without_configuration(client, backend, admin):
    backend.add_node("cpu-data-2", "cpu-data")
    rows = {r["name"]: r for r in client.get(NODES, headers=admin).json()}
    assert rows["cpu-data-2"]["pool"] == "cpu-data"


def test_tc_c01_04_dashboard_matches_running_jobs(client, backend, admin, make_project, member):
    p1 = make_project("P1", "gpu-exclusive")
    p2 = make_project("P2", "gpu-shared")
    submitted = [
        (p1, member(p1, "ra01")), (p2, member(p2, "ca01")), (p2, member(p2, "pi01")),
    ]
    jobs = []
    for project, headers in submitted:
        jobs.append(client.post(f"/api/projects/{project.id}/jobs", headers=headers,
                                json={"kind": "training"}).json())
    rows = client.get(DASHBOARD, headers=admin).json()
    actual = {(r["project_id"], r["job_id"], r["training_id"], r["user"]) for r in rows}
    expected = {(j["project_id"], j["id"], j["id"], j["user"]) for j in jobs}
    assert actual == expected
    assert {(r["node"], r["gpu_index"]) for r in rows} == {("gpu-exclusive-1", 0), ("gpu-shared-1", 0)}
    assert sorted(r["slot"] for r in rows if r["node"] == "gpu-shared-1") == [0, 1]


def test_tc_a02_05_exclusive_gpu_has_no_other_job_while_running(client, backend, admin, make_project, member):
    p1 = make_project("P1", "gpu-exclusive")
    headers = member(p1, "ra01")
    job = client.post(f"/api/projects/{p1.id}/jobs", headers=headers, json={"kind": "training"}).json()
    rows = client.get(DASHBOARD, headers=admin).json()
    mine = next(r for r in rows if r["job_id"] == job["id"])
    same_card = [r for r in rows if (r["node"], r["gpu_index"]) == (mine["node"], mine["gpu_index"])]
    assert same_card == [mine]


def test_dashboard_is_empty_without_running_jobs(client, backend, admin):
    assert client.get(DASHBOARD, headers=admin).json() == []


def test_tc_a02_07_shared_settings_survive_reload_three_times(client, backend, admin):
    assert client.get(SHARED, headers=admin).json() == {"time_slice_replicas": 4, "job_timeout_minutes": 60}
    for replicas, timeout in [(2, 30), (8, 120), (4, 45)]:
        body = {"time_slice_replicas": replicas, "job_timeout_minutes": timeout}
        assert client.put(SHARED, headers=admin, json=body).json() == body
        assert client.get(SHARED, headers=admin).json() == body
        shared = next(n for n in backend.nodes() if n.pool == "gpu-shared")
        assert shared.gpu_capacity == replicas


def test_shared_settings_validation_and_audit(client, backend, admin, session):
    for body in [{"time_slice_replicas": 0, "job_timeout_minutes": 60},
                 {"time_slice_replicas": 17, "job_timeout_minutes": 60},
                 {"time_slice_replicas": 4, "job_timeout_minutes": 0}]:
        assert client.put(SHARED, headers=admin, json=body).status_code == 422
    client.put(SHARED, headers=admin, json={"time_slice_replicas": 2, "job_timeout_minutes": 10})
    row = session.scalar(select(AuditLog).where(AuditLog.action == "shared_scheduling.update"))
    assert row.category == "project" and row.detail == {"time_slice_replicas": 2, "job_timeout_minutes": 10}


def test_shared_timeout_applies_to_shared_jobs(client, backend, admin, make_project, member):
    client.put(SHARED, headers=admin, json={"time_slice_replicas": 4, "job_timeout_minutes": 1})
    p2 = make_project("P2", "gpu-shared")
    headers = member(p2, "ra02")
    job = client.post(f"/api/projects/{p2.id}/jobs", headers=headers,
                      json={"kind": "training", "duration_seconds": 600}).json()
    backend.advance(60)
    got = client.get(f"/api/projects/{p2.id}/jobs/{job['id']}", headers=headers).json()
    assert got["status"] == "failed" and "時限" in got["message"]


def test_cluster_endpoints_are_admin_only(client, backend, add_user):
    _, headers = add_user("user01")
    for url in (NODES, DASHBOARD, SHARED):
        assert client.get(url, headers=headers).status_code == 403
    assert client.put(SHARED, headers=headers, json={"time_slice_replicas": 1,
                                                     "job_timeout_minutes": 1}).status_code == 403
