"""B-02 影像標註：經 Gateway 的驗收測試（需要 compose.labeling.yaml 堆疊與 seed 基線）。
畫面操作（TC-B02-01～04、06）由 platform/web/e2e/labeling.spec.ts 驗；這裡驗 API 與權限。"""
import pytest

from labeling_support import ensure_images, gateway, headers, p1_id


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    with gateway() as c:
        pid = p1_id(c)
        studies = ensure_images(c, pid, tmp_path_factory.mktemp("synth"))
        yield c, pid, studies


def _cleanup(c, pid, ids):
    for i in ids:
        c.delete(f"/api/projects/{pid}/labels/annotations/{i}", headers=headers("md01"))


def test_tc_b02_04_three_kinds_ten_each_saved_and_reloaded(env):
    c, pid, studies = env
    base = f"/api/projects/{pid}/labels"
    md = headers("md01")
    targets = [(s, sop) for s in studies for sop in s["sop_instance_uids"]][:10]
    assert len(targets) == 10
    payloads = {
        "classification": lambda i: {"label": ("nodule", "normal")[i % 2]},
        "detection": lambda i: {"shape": [64, 64], "box_format": "xyxy",
                                "boxes": [{"label": "nodule", "box": [i, i, i + 10, i + 12], "score": 0.5}]},
        "segmentation": lambda i: {"shape": [64, 64], "encoding": "rle", "rle": [[0, 4096 - 10 - i], [1, 10 + i]],
                                   "label_names": {"background": 0, "lung": 1}},
    }
    created = []
    try:
        for kind, make in payloads.items():
            for i, (s, sop) in enumerate(targets):
                body = {"study_instance_uid": s["study_instance_uid"], "sop_instance_uid": sop, "kind": kind,
                        "payload": make(i)}
                r = c.post(f"{base}/annotations", headers=md, json=body)
                assert r.status_code == 201, r.text
                created.append((r.json()["id"], body))
        assert len(created) == 30
        for annotation_id, body in created:
            got = c.get(f"{base}/annotations/{annotation_id}", headers=md).json()
            assert got["payload"] == body["payload"] and got["kind"] == body["kind"]
    finally:
        _cleanup(c, pid, [i for i, _ in created])


def test_tc_b02_03_rate_ten_then_reload(env):
    c, pid, studies = env
    base = f"/api/projects/{pid}/labels"
    md = headers("md01")
    ids = []
    try:
        for i, s in enumerate((studies * 2)[:10]):
            a = c.post(f"{base}/annotations", headers=md, json={"study_instance_uid": s["study_instance_uid"],
                       "kind": "classification", "payload": {"label": f"r{i}"}}).json()
            ids.append(a["id"])
            assert c.put(f"{base}/annotations/{a['id']}/rating", headers=md, json={"rating": 1 + i % 5}).status_code == 200
        got = {a["id"]: a["rating"] for a in c.get(f"{base}/annotations", headers=md).json() if a["id"] in ids}
        assert got == {aid: 1 + i % 5 for i, aid in enumerate(ids)}
    finally:
        _cleanup(c, pid, ids)


def test_tc_b02_05_csv_ten_rows_zero_alignment_errors(env):
    c, pid, studies = env
    assert len(studies) >= 10
    chosen = studies[:10]
    csv = "病歷號,診斷結果\n" + "\n".join(f"{s['patient_id']},dx-{s['accession_number']}" for s in chosen) + "\n"
    r = c.post(f"/api/projects/{pid}/labels/classification-csv", headers=headers("md01"), data={"key": "patient_id"},
               files={"file": ("dx.csv", csv.encode(), "text/csv")})
    assert r.status_code == 201, r.text
    body = r.json()
    ids = sorted({i for row in body["results"] for i in row["annotation_ids"]})
    try:
        assert (body["rows"], body["matched"], body["unmatched"], body["conflict"], body["invalid"]) == (10, 10, 0, 0, 0)
        errors = 0
        for s in chosen:
            rows = c.get(f"/api/projects/{pid}/labels/annotations", headers=headers("md01"),
                         params={"study_uid": s["study_instance_uid"], "source": "csv"}).json()
            if [a["payload"]["label"] for a in rows] != [f"dx-{s['accession_number']}"]:
                errors += 1
        assert errors == 0
    finally:
        _cleanup(c, pid, ids)


def test_tc_b02_07_viewer_cannot_save_five_attempts(env):
    c, pid, studies = env
    s = studies[0]
    body = {"study_instance_uid": s["study_instance_uid"], "kind": "classification", "payload": {"label": "x"}}
    vw = headers("vw01")
    successes = sum(c.post(f"/api/projects/{pid}/labels/annotations", headers=vw, json=body).status_code < 300
                    for _ in range(5))
    assert successes == 0
    r = c.post(f"/api/projects/{pid}/labels/annotations", headers=vw, json=body)
    assert r.status_code == 403 and r.json()["detail"]["permission"] == "labeling"
