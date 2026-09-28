"""TC-B01-09：5 欄位篩選，結果不符 0 筆。"""
import pytest

from imaging_support import STUDIES, member, orthanc, project, study_files, study_uid, upload  # noqa: F401


@pytest.fixture
def loaded(client, orthanc, project, member):
    p1 = project()
    h = member("ra01", p1)
    upload(client, h, p1.id, [f for no in STUDIES for f in study_files(no)])
    return lambda **params: client.get(f"/api/projects/{p1.id}/imaging/studies", headers=h, params=params)


def _uids(response):
    assert response.status_code == 200, response.text
    return sorted(s["study_instance_uid"] for s in response.json())


def _expected(pred):
    return sorted(study_uid(no) for no, m in STUDIES.items() if pred(m))


def test_tc_b01_09_modality(loaded):
    assert _uids(loaded(modality="CT")) == _expected(lambda m: m["modality"] == "CT")
    assert _uids(loaded(modality="mr")) == _expected(lambda m: m["modality"] == "MR")


def test_tc_b01_09_patient_sex(loaded):
    assert _uids(loaded(patient_sex="F")) == _expected(lambda m: m["sex"] == "F")


def test_tc_b01_09_study_description(loaded):
    assert _uids(loaded(study_description="contrast")) == _expected(lambda m: "CONTRAST" in m["study"])
    assert _uids(loaded(study_description="BRAIN")) == _expected(lambda m: "BRAIN" in m["study"])


def test_tc_b01_09_study_date(loaded):
    assert _uids(loaded(study_date="20240220")) == [study_uid(2)]
    assert _uids(loaded(study_date="20240201-20240331")) == [study_uid(2), study_uid(3)]
    assert _uids(loaded(study_date="20240301-")) == [study_uid(3), study_uid(4)]


def test_tc_b01_09_series_description(loaded):
    assert _uids(loaded(series_description="AX T")) == _expected(lambda m: "AX T" in m["series"])


def test_combined_filters(loaded):
    assert _uids(loaded(modality="MR", patient_sex="F")) == [study_uid(4)]


def test_like_wildcards_are_literal(loaded):
    assert _uids(loaded(study_description="%")) == []
    assert _uids(loaded(series_description="_")) == []


def test_bad_date_is_422(loaded):
    assert loaded(study_date="2024-01-01").status_code == 422
