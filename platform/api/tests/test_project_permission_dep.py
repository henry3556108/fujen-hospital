from fastapi import Depends

from app.deps import require_project_permission
from app.models import Membership, Project
from app.permissions import AccountType, Permission


def _route(app):
    @app.get("/api/projects/{project_id}/__probe")
    def probe(project_id: int, ctx=Depends(require_project_permission(Permission.TRAINING))):
        return {"user": ctx.user.username, "project": ctx.project.name}


def test_member_with_permission_passes(app, client, add_user, session):
    _route(app)
    p = Project(name="P1")
    session.add(p)
    ra, headers = add_user("ra01")
    session.flush()
    session.add(Membership(user_id=ra.id, project_id=p.id, role="research_assistant", permissions=["project", "training"]))
    session.commit()
    response = client.get(f"/api/projects/{p.id}/__probe", headers=headers)
    assert response.status_code == 200 and response.json() == {"user": "ra01", "project": "P1"}


def test_missing_permission_is_403_with_reason(app, client, add_user, session):
    _route(app)
    p = Project(name="P1")
    session.add(p)
    vw, headers = add_user("vw01")
    session.flush()
    session.add(Membership(user_id=vw.id, project_id=p.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    response = client.get(f"/api/projects/{p.id}/__probe", headers=headers)
    assert response.status_code == 403
    assert response.json()["detail"]["permission"] == "training"


def test_unknown_project_is_404_for_admin(app, client, add_user):
    _route(app)
    _, admin = add_user("admin01", AccountType.ADMIN)
    response = client.get("/api/projects/999/__probe", headers=admin)
    assert response.status_code == 404
