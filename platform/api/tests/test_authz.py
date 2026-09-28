import pytest
from fastapi import HTTPException

from app.authz import effective_permissions, require_permission
from app.models import Membership, Project
from app.permissions import AccountType, Permission


@pytest.fixture
def project(session):
    p = Project(name="P1-lung-ct")
    session.add(p)
    session.commit()
    return p


def test_admin_has_all_permissions_everywhere(session, add_user, project):
    admin, _ = add_user("admin01", AccountType.ADMIN)
    assert effective_permissions(session, admin, project.id) == frozenset(Permission)


def test_non_member_has_nothing(session, add_user, project):
    outsider, _ = add_user("user01")
    assert effective_permissions(session, outsider, project.id) == frozenset()


def test_member_gets_stored_permissions(session, add_user, project):
    vw, _ = add_user("vw01")
    session.add(Membership(user_id=vw.id, project_id=project.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    assert effective_permissions(session, vw, project.id) == {Permission.PROJECT, Permission.PREDICTION}


def test_tc_a03_05_require_permission_rejects_with_message(session, add_user, project):
    vw, _ = add_user("vw01")
    session.add(Membership(user_id=vw.id, project_id=project.id, role="viewer", permissions=["project", "prediction"]))
    session.commit()
    for perm in [Permission.TRAINING, Permission.LABELING, Permission.CODING]:
        with pytest.raises(HTTPException) as exc:
            require_permission(session, vw, project.id, perm)
        assert exc.value.status_code == 403
        assert exc.value.detail["permission"] == perm.value


def test_tc_a03_06_change_is_visible_on_next_check(session, add_user, project):
    ra, _ = add_user("ra01")
    m = Membership(user_id=ra.id, project_id=project.id, role="research_assistant", permissions=["project", "training"])
    session.add(m)
    session.commit()
    require_permission(session, ra, project.id, Permission.TRAINING)

    m.permissions = ["project"]
    session.commit()
    with pytest.raises(HTTPException):
        require_permission(session, ra, project.id, Permission.TRAINING)
