import pytest

from app.authz import match_rule
from app.models import Membership, Project
from app.permissions import Permission


@pytest.mark.parametrize("path,expected", [
    ("/api/projects/7/inference/predict", (7, Permission.PREDICTION)),
    ("/api/projects/7/training", (7, Permission.TRAINING)),
    ("/api/projects/7/labels/12", (7, Permission.LABELING)),
    ("/api/projects/7/code/export", (7, Permission.CODING)),
    ("/api/projects/7/datasets", (7, Permission.PROJECT)),
    ("/api/projects/7", (7, Permission.PROJECT)),
    ("/api/projects/7/training?x=1", (7, Permission.TRAINING)),
    # 非正規路徑一律拒絕（canonical-or-deny），不嘗試「正規化後放行」
    ("/api/projects/2/../1/training", None),
    ("/api/projects/1/%2e%2e/2/training", None),
    ("//api//projects/3//inference", None),
    ("/api/projects/2/%252e%252e/1/training", None),
    ("/api/projects/1/inference/..%252ftraining", None),
    ("/api/projects/1/training;x=1", None),
    ("/api/projects/1/training%00", None),
    ("/api/projects/1\\training", None),
    ("/api/projects/1/./training", None),
    ("/api/projects/1/inferencex", (1, Permission.PROJECT)),
    ("/api/other", None),
    ("/api/projects/abc/training", None),
])
def test_match_rule(path, expected):
    assert match_rule(path) == expected


@pytest.fixture
def p1(session):
    p = Project(name="P1")
    session.add(p)
    session.commit()
    return p


def _check(client, headers, uri):
    return client.get("/authz/check", headers={**headers, "X-Forwarded-Uri": uri})


def test_allowed_request_returns_200_with_user(client, add_user, session, p1):
    vw, headers = add_user("vw01")
    session.add(Membership(user_id=vw.id, project_id=p1.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    response = _check(client, headers, f"/api/projects/{p1.id}/inference/predict")
    assert response.status_code == 200
    assert response.headers["X-User"] == "vw01"


def test_tc_a03_05_viewer_denied_ten_times(client, add_user, session, p1):
    vw, headers = add_user("vw01")
    session.add(Membership(user_id=vw.id, project_id=p1.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    uris = [f"/api/projects/{p1.id}/{s}" for s in ["training", "labels", "code"] * 3] + [f"/api/projects/{p1.id}/training/1"]
    assert len(uris) == 10
    assert all(_check(client, headers, u).status_code == 403 for u in uris)


def test_tc_a02_04_outsider_denied_ten_times(client, add_user, p1):
    _, headers = add_user("user01")
    for _ in range(10):
        assert _check(client, headers, f"/api/projects/{p1.id}/datasets").status_code == 403


def test_path_traversal_cannot_escape_to_other_project(client, add_user, session, p1):
    p2 = Project(name="P2")
    session.add(p2)
    vw, headers = add_user("vw01")
    session.add(Membership(user_id=vw.id, project_id=p1.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    assert _check(client, headers, f"/api/projects/{p1.id}/../{p2.id}/inference").status_code == 403


def test_unknown_route_is_denied_by_default(client, add_user):
    _, headers = add_user("user01")
    assert _check(client, headers, "/something/else").status_code == 403


def test_no_token_is_401(client):
    assert client.get("/authz/check", headers={"X-Forwarded-Uri": "/api/projects/1"}).status_code == 401
