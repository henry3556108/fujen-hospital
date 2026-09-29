"""TC-B01-08（DICOMweb 部分）：Gateway forward-auth 對 DICOMweb 的研究層級檢查，含繞過手法。"""
import pytest

from app.authz import DicomwebTarget, match_dicomweb, match_rule
from app.permissions import AccountType
from imaging_support import (STUDIES, accession, member, orthanc, project, series_uid, sop_uid,  # noqa: F401
                             study_files, study_uid, upload)

S, R, I = "1.2.3", "1.2.3.4", "1.2.3.4.5"


@pytest.mark.parametrize("path,expected", [
    (f"/dicomweb/projects/7/studies/{S}", DicomwebTarget(7, S, None, None)),
    (f"/dicomweb/projects/7/studies/{S}/metadata", DicomwebTarget(7, S, None, None)),
    (f"/dicomweb/projects/7/studies/{S}/series", DicomwebTarget(7, S, None, None)),
    (f"/dicomweb/projects/7/studies/{S}/series?SeriesInstanceUID={R}", DicomwebTarget(7, S, None, None)),
    (f"/dicomweb/projects/7/studies/{S}/series/{R}", DicomwebTarget(7, S, R, None)),
    (f"/dicomweb/projects/7/studies/{S}/series/{R}/metadata", DicomwebTarget(7, S, R, None)),
    (f"/dicomweb/projects/7/studies/{S}/series/{R}/instances", DicomwebTarget(7, S, R, None)),
    (f"/dicomweb/projects/7/studies/{S}/series/{R}/instances/{I}", DicomwebTarget(7, S, R, I)),
    (f"/dicomweb/projects/7/studies/{S}/series/{R}/instances/{I}/frames/1", DicomwebTarget(7, S, R, I)),
    (f"/dicomweb/projects/7/studies/{S}/series/{R}/instances/{I}/frames/1,2/rendered", DicomwebTarget(7, S, R, I)),
    (f"/dicomweb/projects/7/studies/{S}/series/{R}/instances/{I}/bulk/7fe00010", DicomwebTarget(7, S, R, I)),
    (f"/dicomweb/projects/7/studies?StudyInstanceUID={S}", DicomwebTarget(7, S, None, None)),
    (f"/dicomweb/projects/7/studies?StudyInstanceUID={S}&includefield=all&limit=1", DicomwebTarget(7, S, None, None)),
    # OHIF 送出的查詢形式（WP5a）：includefield 以 %2C 分隔、固定帶 fuzzymatching=false
    (f"/dicomweb/projects/7/studies?limit=101&offset=0&fuzzymatching=false&includefield=00081030%2C00080060"
     f"&StudyInstanceUID={S}", DicomwebTarget(7, S, None, None)),
    (f"/dicomweb/projects/7/studies/{S}/series?includefield=0008103E%2C00080021", DicomwebTarget(7, S, None, None)),
    (f"/dicomweb/projects/7/studies/{S}/series?includefield=0008103E%2c00080021", DicomwebTarget(7, S, None, None)),
    (f"/dicomweb/projects/7/studies?StudyInstanceUID={S}&fuzzymatching=true", None),
    (f"/dicomweb/projects/7/studies?StudyInstanceUID={S}%2C9.9.9", None),          # 編碼的逗號也不能拿來列多個研究
    (f"/dicomweb/projects/7/studies?fuzzymatching=false&includefield=00081030%2C00080060", None),
    (f"/dicomweb/projects/7/studies/{S}%2Cx", None),                                # 路徑裡的 %2C 仍然拒絕
    (f"/dicomweb/projects/7/studies/{S}/series?includefield=%2e%2e", None),
    (f"/dicomweb/projects/7/studies/{S}/series?includefield=a%252Cb", None),
    # 研究列表搜尋：只能指定單一研究
    ("/dicomweb/projects/7/studies", None),
    ("/dicomweb/projects/7/studies?PatientID=*", None),
    (f"/dicomweb/projects/7/studies?StudyInstanceUID={S},9.9.9", None),
    (f"/dicomweb/projects/7/studies?StudyInstanceUID={S}%5C9.9.9", None),
    (f"/dicomweb/projects/7/studies?StudyInstanceUID={S}&StudyInstanceUID=9.9.9", None),
    (f"/dicomweb/projects/7/studies?StudyInstanceUID={S}&0020000D=9.9.9", None),
    (f"/dicomweb/projects/7/studies?StudyInstanceUID=*", None),
    (f"/dicomweb/projects/7/studies?studyinstanceuid={S}", None),
    # 非正規路徑一律拒絕
    (f"/dicomweb/projects/7/studies/{S}/../9.9.9", None),
    (f"/dicomweb/projects/7/studies/{S}/%2e%2e/9.9.9", None),
    (f"/dicomweb/projects/7/studies/{S}/..%252f9.9.9", None),
    (f"/dicomweb/projects/7/../8/studies/{S}", None),
    (f"//dicomweb/projects/7/studies/{S}", None),
    (f"/dicomweb/projects/7/studies//{S}", None),
    (f"/dicomweb/projects/7/studies/{S};x=1", None),
    (f"/dicomweb/projects/7/studies/{S}%00", None),
    (f"/dicomweb/projects/7/studies/{S}\\series", None),
    (f"/dicomweb/projects/7/studies/{S}/series/{R}?x=%2e", None),
    (f"/dicomweb/projects/7/studies/{S}/./series", None),
    (f"/dicomweb/projects/7/studies/*", None),
    (f"/dicomweb/projects/7/studies/{S}/unknown", None),
    (f"/dicomweb/projects/7/series?StudyInstanceUID={S}", None),
    (f"/dicomweb/projects/7/instances", None),
    (f"/dicomweb/projects/abc/studies/{S}", None),
    (f"/dicom-web/studies/{S}", None),
    (f"/api/projects/7/imaging/studies", None),
])
def test_match_dicomweb(path, expected):
    assert match_dicomweb(path) == expected


def test_dicomweb_paths_never_match_api_rules():
    assert match_rule(f"/dicomweb/projects/7/studies/{S}") is None


# ---------- /authz/check 整合 ----------

@pytest.fixture
def setup(client, orthanc, project, member, add_user):
    p1, p2 = project("P1"), project("P2")
    ra = member("ra01", p1)
    vw = member("vw01", p1, permissions=("project", "prediction"))
    _, outsider = add_user("user01")
    _, admin = add_user("admin01", AccountType.ADMIN)
    upload(client, ra, p1.id, [f for no in STUDIES for f in study_files(no)])
    client.put(f"/api/projects/{p1.id}/imaging/accession-allowlist", headers=admin,
               json={"accession_numbers": [accession(1), accession(2)]})
    return p1, p2, ra, vw, outsider


def _check(client, headers, uri, method="GET"):
    return client.get("/authz/check", headers={**headers, "X-Forwarded-Uri": uri, "X-Forwarded-Method": method})


def _base(pid, no):
    return f"/dicomweb/projects/{pid}/studies/{study_uid(no)}"


def test_allowed_study_passes_for_viewer(client, setup):
    p1, _, _, vw, _ = setup
    for uri in [_base(p1.id, 1), _base(p1.id, 1) + "/metadata",
                f"{_base(p1.id, 1)}/series/{series_uid(1)}/instances/{sop_uid(1, 1)}/frames/1",
                f"/dicomweb/projects/{p1.id}/studies?StudyInstanceUID={study_uid(2)}"]:
        r = _check(client, vw, uri)
        assert r.status_code == 200, (uri, r.text)
        assert r.headers["X-User"] == "vw01"


def test_tc_b01_08_dicomweb_outside_allowlist_zero_success(client, setup):
    p1, _, ra, vw, _ = setup
    uris = [_base(p1.id, 3), _base(p1.id, 4) + "/metadata",
            f"{_base(p1.id, 3)}/series/{series_uid(3)}/instances/{sop_uid(3, 1)}/frames/1",
            f"/dicomweb/projects/{p1.id}/studies?StudyInstanceUID={study_uid(4)}",
            f"{_base(p1.id, 4)}/series/{series_uid(4)}"]
    assert len(uris) == 5
    assert sum(_check(client, h, u).status_code == 200 for u in uris for h in (ra, vw)) == 0


def test_series_or_instance_from_other_study_denied(client, setup):
    p1, _, ra, _, _ = setup
    # 研究 1 在清單內，但把研究 3 的 series／instance 掛在它底下
    assert _check(client, ra, f"{_base(p1.id, 1)}/series/{series_uid(3)}").status_code == 403
    assert _check(client, ra, f"{_base(p1.id, 1)}/series/{series_uid(1)}/instances/{sop_uid(3, 1)}").status_code == 403


def test_no_token_is_401(client, setup):
    p1, _, _, _, _ = setup
    assert _check(client, {}, _base(p1.id, 1)).status_code == 401


def test_other_project_path_denied(client, setup, member):
    p1, p2, _, _, _ = setup
    h2 = member("ra02", p2)
    assert _check(client, h2, _base(p2.id, 1)).status_code == 403      # 研究不在 P2
    assert _check(client, h2, _base(p1.id, 1)).status_code == 403      # 不是 P1 成員


def test_outsider_denied(client, setup):
    p1, _, _, _, outsider = setup
    assert _check(client, outsider, _base(p1.id, 1)).status_code == 403


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", ""])
def test_dicomweb_write_methods_denied(client, setup, method):
    p1, _, ra, _, _ = setup
    assert _check(client, ra, f"/dicomweb/projects/{p1.id}/studies", method=method).status_code == 403
    assert _check(client, ra, _base(p1.id, 1), method=method).status_code == 403


def test_traversal_to_outside_study_denied(client, setup):
    p1, _, ra, _, _ = setup
    assert _check(client, ra, f"{_base(p1.id, 1)}/../{study_uid(3)}").status_code == 403
    assert _check(client, ra, f"{_base(p1.id, 1)}/%2e%2e/{study_uid(3)}").status_code == 403
