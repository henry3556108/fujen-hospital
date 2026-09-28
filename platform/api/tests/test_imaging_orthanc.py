import json

import httpx
import pytest

from app.imaging.orthanc import HttpOrthanc, InMemoryOrthanc, OrthancError, orthanc_from_env
from imaging_support import accession, make_dicom, study_uid


def _pacs_with(*studies):
    return InMemoryOrthanc(pacs=[make_dicom(no, s) for no in studies for s in (1, 2)])


def test_store_is_idempotent_by_sop_uid():
    o = InMemoryOrthanc()
    a = o.store(make_dicom(1, 1))
    assert o.store(make_dicom(1, 1)) == a
    assert len(o.instances) == 1


def test_tc_b01_07_fake_pacs_find_filters_study_level():
    o = _pacs_with(1, 2, 3)
    answers = o.pacs_find({"Modality": "CT"})
    assert sorted(a["StudyInstanceUID"] for a in answers) == [study_uid(1), study_uid(3)]
    assert o.pacs_find({"AccessionNumber": accession(2)})[0]["StudyDescription"] == "MR BRAIN WWO CONTRAST"
    assert o.pacs_find({"StudyDate": "20240101-20240228"}) and len(o.pacs_find({"StudyDate": "20240101-20240228"})) == 2


def test_tc_b01_07_fake_pacs_move_copies_to_platform_node():
    o = _pacs_with(1, 2)
    assert o.study_instances(study_uid(1)) == []
    o.pacs_move(study_uid(1))
    assert len(o.study_instances(study_uid(1))) == 2
    assert o.study_instances(study_uid(2)) == []


def test_fake_move_unknown_study_errors():
    with pytest.raises(OrthancError):
        InMemoryOrthanc().pacs_move("1.2.3")


def _http(handler):
    return HttpOrthanc("http://orthanc:8042", username="u", password="p", pacs_modality="pacs",
                       transport=httpx.MockTransport(handler))


def test_http_store_posts_instance():
    seen = {}

    def handler(request):
        seen["path"], seen["auth"] = request.url.path, request.headers.get("authorization")
        return httpx.Response(200, json={"ID": "abc", "Status": "Success"})

    assert _http(handler).store(b"DICM") == "abc"
    assert seen["path"] == "/instances" and seen["auth"].startswith("Basic ")


def test_http_store_rejected_raises():
    with pytest.raises(OrthancError):
        _http(lambda r: httpx.Response(400, json={"Message": "Bad file format"})).store(b"x")


def test_http_find_uses_modality_query_and_answers():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/modalities/pacs/query":
            body = json.loads(request.content)
            assert body["Level"] == "Study" and body["Query"]["ModalitiesInStudy"] == "CT"
            return httpx.Response(200, json={"ID": "q1", "Path": "/queries/q1"})
        if request.url.path == "/queries/q1/answers":
            return httpx.Response(200, json=["0"])
        if request.url.path == "/queries/q1/answers/0/content":
            return httpx.Response(200, json={"StudyInstanceUID": "1.2", "AccessionNumber": "ACC0001",
                                             "ModalitiesInStudy": "CT"})
        return httpx.Response(404)

    answers = _http(handler).pacs_find({"Modality": "CT"})
    assert answers == [{"StudyInstanceUID": "1.2", "AccessionNumber": "ACC0001", "ModalitiesInStudy": "CT",
                        "Modality": "CT"}]


def test_http_move_and_fetch_study():
    def handler(request):
        if request.url.path == "/modalities/pacs/move":
            body = json.loads(request.content)
            assert body["Resources"] == [{"StudyInstanceUID": "1.2"}] and body["Level"] == "Study"
            return httpx.Response(200, json={})
        if request.url.path == "/tools/find":
            return httpx.Response(200, json=["i1", "i2"])
        if request.url.path.startswith("/instances/"):
            return httpx.Response(200, content=request.url.path.encode())
        return httpx.Response(404)

    o = _http(handler)
    o.pacs_move("1.2")
    assert o.study_instances("1.2") == [b"/instances/i1/file", b"/instances/i2/file"]


def test_http_unreachable_is_orthanc_error():
    def handler(request):
        raise httpx.ConnectError("down")
    with pytest.raises(OrthancError, match="影像節點"):
        _http(handler).store(b"x")


def test_orthanc_from_env():
    assert orthanc_from_env({}) is None
    o = orthanc_from_env({"ORTHANC_URL": "http://orthanc:8042", "ORTHANC_USERNAME": "api",
                          "ORTHANC_PASSWORD": "x", "ORTHANC_PACS_MODALITY": "pacs"})
    assert isinstance(o, HttpOrthanc) and o.pacs_modality == "pacs"
