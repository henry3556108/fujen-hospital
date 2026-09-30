"""研究清單分頁：帶 limit 才分頁（回 {items, total, offset, limit}）；不帶時照舊回完整陣列，既有呼叫端不受影響。"""
from imaging_support import STUDIES, member, orthanc, project, study_files, study_uid, upload  # noqa: F401


def _setup(client, project, member):
    p1 = project()
    h = member("ra01", p1)
    upload(client, h, p1.id, [f for no in STUDIES for f in study_files(no)])
    return lambda **params: client.get(f"/api/projects/{p1.id}/imaging/studies", headers=h, params=params)


def test_without_limit_the_response_is_the_full_list(client, orthanc, project, member):
    get = _setup(client, project, member)
    everything = get().json()
    assert isinstance(everything, list) and len(everything) == len(STUDIES)


def test_pages_cover_every_study_once_in_list_order(client, orthanc, project, member):
    get = _setup(client, project, member)
    everything = [s["study_instance_uid"] for s in get().json()]
    seen = []
    for offset in range(0, len(STUDIES), 2):
        page = get(limit=2, offset=offset)
        assert page.status_code == 200, page.text
        body = page.json()
        assert (body["total"], body["offset"], body["limit"]) == (len(STUDIES), offset, 2)
        assert len(body["items"]) == min(2, len(STUDIES) - offset)
        seen += [s["study_instance_uid"] for s in body["items"]]
    assert seen == everything
    past = get(limit=2, offset=len(STUDIES) + 5).json()
    assert past["items"] == [] and past["total"] == len(STUDIES)
    first = get(limit=2).json()                                # offset 預設 0
    assert first["offset"] == 0 and first["items"][0]["study_instance_uid"] == everything[0]


def test_total_counts_after_filters(client, orthanc, project, member):
    get = _setup(client, project, member)
    ct = [no for no, m in STUDIES.items() if m["modality"] == "CT"]
    body = get(modality="CT", limit=1).json()
    assert body["total"] == len(ct) and len(body["items"]) == 1
    assert body["items"][0]["study_instance_uid"] in {study_uid(no) for no in ct}


def test_out_of_range_paging_is_422(client, orthanc, project, member):
    get = _setup(client, project, member)
    for params in ({"limit": 0}, {"limit": 501}, {"limit": 10, "offset": -1}, {"limit": "x"}):
        assert get(**params).status_code == 422, params
