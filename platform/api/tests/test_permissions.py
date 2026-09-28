from app.permissions import DEFAULT_ROLE_PERMISSIONS, AccountType, Permission, Role


def test_five_permissions_and_roles():
    assert {p.value for p in Permission} == {"project", "training", "labeling", "coding", "prediction"}
    assert {r.value for r in Role} == {
        "viewer", "coder_assistant", "research_assistant", "medical_doctor", "principal_investigator",
    }
    assert {a.value for a in AccountType} == {"admin", "user"}


def test_tc_a03_04_every_role_has_defaults():
    assert set(DEFAULT_ROLE_PERMISSIONS) == set(Role)
    for perms in DEFAULT_ROLE_PERMISSIONS.values():
        assert Permission.PROJECT in perms


def test_role_defaults_match_baseline():
    P = Permission
    assert DEFAULT_ROLE_PERMISSIONS[Role.VIEWER] == {P.PROJECT, P.PREDICTION}
    assert DEFAULT_ROLE_PERMISSIONS[Role.MEDICAL_DOCTOR] == {P.PROJECT, P.LABELING, P.PREDICTION}
    assert DEFAULT_ROLE_PERMISSIONS[Role.RESEARCH_ASSISTANT] == {P.PROJECT, P.LABELING, P.TRAINING, P.PREDICTION}
    assert DEFAULT_ROLE_PERMISSIONS[Role.CODER_ASSISTANT] == {P.PROJECT, P.TRAINING, P.CODING, P.PREDICTION}
    assert DEFAULT_ROLE_PERMISSIONS[Role.PRINCIPAL_INVESTIGATOR] == set(P)
