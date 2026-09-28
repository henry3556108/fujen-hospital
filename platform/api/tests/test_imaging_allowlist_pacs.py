"""TC-B01-08（API 部分）Accession 清單；TC-B01-07 PACS 查詢取像（記憶體 PACS）。"""
import pytest
from sqlalchemy import select

from app.models import AuditLog
from app.permissions import AccountType
from imaging_support import (STUDIES, SLICES, accession, member, orthanc, project, study_files,  # noqa: F401
                             study_uid, upload)

ALLOWED = [accession(1), accession(2)]


@pytest.fixture
def p1_loaded(client, orthanc, project, member, add_user):
    p1 = project()
    h = member("ra01", p1)
    _, admin = add_user("admin01", AccountType.ADMIN)
    upload(client, h, p1.id, [f for no in STUDIES for f in study_files(no)])
    return p1, h, admin


def _set(client, headers, pid, accessions):
    return client.put(f"/api/projects/{pid}/imaging/accession-allowlist", headers=headers,
                      json={"accession_numbers": accessions})


def test_admin_sets_allowlist_with_audit(client, session, p1_loaded):
    p1, h, admin = p1_loaded
    r = _set(client, admin, p1.id, ALLOWED + [accession(1)])
    assert r.status_code == 200 and r.json() == {"accession_numbers": ALLOWED}
    assert client.get(f"/api/projects/{p1.id}/imaging/accession-allowlist", headers=h).json() == {
        "accession_numbers": ALLOWED}
    entry = session.scalars(select(AuditLog).where(AuditLog.action == "imaging.set_allowlist")).one()
    assert entry.category == "dataset" and entry.detail["count"] == 2


def test_non_admin_cannot_set_allowlist(client, p1_loaded, add_user, session):
    from app.models import Membership
    p1, h, _ = p1_loaded
    assert _set(client, h, p1.id, ALLOWED).status_code == 403
    pi, pi_h = add_user("pi01")
    session.add(Membership(user_id=pi.id, project_id=p1.id, role="principal_investigator",
                           permissions=["project", "training", "labeling", "coding", "prediction"]))
    session.commit()
    assert _set(client, pi_h, p1.id, ALLOWED).status_code == 403


@pytest.mark.parametrize("bad", [[""], ["A" * 65], ["ACC\\0001"], ["ACC*"]])
def test_invalid_accession_rejected(client, p1_loaded, bad):
    p1, _, admin = p1_loaded
    assert _set(client, admin, p1.id, bad).status_code == 422


def test_tc_b01_08_api_outside_list_zero_success(client, p1_loaded):
    p1, h, admin = p1_loaded
    _set(client, admin, p1.id, ALLOWED)
    listed = client.get(f"/api/projects/{p1.id}/imaging/studies", headers=h).json()
    assert sorted(s["accession_number"] for s in listed) == ALLOWED
    successes = 0
    for _ in range(5):
        for no in (3, 4):
            successes += client.get(f"/api/projects/{p1.id}/imaging/studies/{study_uid(no)}",
                                    headers=h).status_code == 200
        successes += any(s["accession_number"] == accession(3) for s in client.get(
            f"/api/projects/{p1.id}/imaging/studies", headers=h, params={"modality": "CT"}).json())
    assert successes == 0
    assert client.get(f"/api/projects/{p1.id}/imaging/studies/{study_uid(1)}", headers=h).status_code == 200


def test_empty_allowlist_means_unrestricted(client, p1_loaded):
    p1, h, admin = p1_loaded
    _set(client, admin, p1.id, ALLOWED)
    _set(client, admin, p1.id, [])
    assert len(client.get(f"/api/projects/{p1.id}/imaging/studies", headers=h).json()) == len(STUDIES)


# ---------- PACS ----------

@pytest.fixture
def p1_empty(client, orthanc, project, member, add_user):
    p1 = project()
    h = member("ra01", p1)
    _, admin = add_user("admin01", AccountType.ADMIN)
    return p1, h, admin


def test_tc_b01_07_query_returns_study_metadata(client, p1_empty):
    p1, h, _ = p1_empty
    r = client.post(f"/api/projects/{p1.id}/imaging/pacs/query", headers=h, json={"Modality": "MR"})
    assert r.status_code == 200, r.text
    answers = r.json()
    assert sorted(a["StudyInstanceUID"] for a in answers) == [study_uid(2), study_uid(4)]
    a2 = next(a for a in answers if a["StudyInstanceUID"] == study_uid(2))
    assert (a2["AccessionNumber"], a2["PatientSex"], a2["StudyDate"], a2["StudyDescription"]) == (
        accession(2), "M", "20240220", STUDIES[2]["study"])


def test_tc_b01_07_retrieve_indexes_study(client, orthanc, p1_empty):
    p1, h, _ = p1_empty
    r = client.post(f"/api/projects/{p1.id}/imaging/pacs/retrieve", headers=h,
                    json={"study_instance_uid": study_uid(3)})
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "pacs" and r.json()["counts"]["imported"] == SLICES
    study = client.get(f"/api/projects/{p1.id}/imaging/studies/{study_uid(3)}", headers=h).json()
    assert study["accession_number"] == accession(3) and study["instances"] == SLICES
    assert study["series"][0]["series_description"] == STUDIES[3]["series"]
    again = client.post(f"/api/projects/{p1.id}/imaging/pacs/retrieve", headers=h,
                        json={"study_instance_uid": study_uid(3)}).json()
    assert again["counts"] == {"imported": 0, "duplicate": SLICES, "failed": 0}


def test_restricted_project_query_hides_and_retrieve_rejects(client, orthanc, p1_empty):
    p1, h, admin = p1_empty
    _set(client, admin, p1.id, ALLOWED)
    answers = client.post(f"/api/projects/{p1.id}/imaging/pacs/query", headers=h, json={}).json()
    assert sorted(a["AccessionNumber"] for a in answers) == ALLOWED
    r = client.post(f"/api/projects/{p1.id}/imaging/pacs/retrieve", headers=h,
                    json={"study_instance_uid": study_uid(3)})
    assert r.status_code == 403
    assert orthanc.study_instances(study_uid(3)) == []


def test_retrieve_unknown_study_is_404(client, p1_empty):
    p1, h, _ = p1_empty
    r = client.post(f"/api/projects/{p1.id}/imaging/pacs/retrieve", headers=h, json={"study_instance_uid": "1.2.3"})
    assert r.status_code == 404


def test_query_rejects_unknown_keys(client, p1_empty):
    p1, h, _ = p1_empty
    r = client.post(f"/api/projects/{p1.id}/imaging/pacs/query", headers=h, json={"PatientName": "*"})
    assert r.status_code == 422


def test_pacs_requires_labeling(client, orthanc, project, member):
    p1 = project()
    h = member("vw01", p1, permissions=("project", "prediction"))
    assert client.post(f"/api/projects/{p1.id}/imaging/pacs/query", headers=h, json={}).status_code == 403
