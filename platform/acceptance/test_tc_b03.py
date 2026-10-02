"""B-03 自動標註：經 Gateway 的驗收測試（compose.labeling.yaml 堆疊，自動標註服務為 fake-autolabel）。
TC-B03-05 需要 COMPOSE_PROJECT（用 docker stop／start 停止自動標註服務）；未設定時略過。"""
import os
import subprocess
import time

import pytest

import platform_exec as pe

from labeling_support import ensure_images, gateway, headers, p1_id

PROJECT = os.environ.get("COMPOSE_PROJECT")


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    with gateway() as c:
        pid = p1_id(c)
        studies = ensure_images(c, pid, tmp_path_factory.mktemp("synth"))
        yield c, pid, studies


def _submit(c, pid, model, study, sop):
    return c.post(f"/api/projects/{pid}/labels/autolabel", headers=headers("md01"),
                  json={"model": model, "study_instance_uid": study, "sop_instance_uid": sop})


def test_tc_b03_01_five_submissions_succeed(env):
    c, pid, studies = env
    models = c.get(f"/api/projects/{pid}/labels/autolabel/models", headers=headers("md01")).json()
    names = [m["name"] for m in models]
    assert set(names) == {"fake_detection", "fake_segmentation"}
    ok = 0
    for i in range(5):
        s = studies[i % len(studies)]
        r = _submit(c, pid, names[i % 2], s["study_instance_uid"], s["sop_instance_uids"][0])
        assert r.status_code == 201, r.text
        ok += 1
        c.delete(f"/api/projects/{pid}/labels/annotations/{r.json()['annotation']['id']}", headers=headers("md01"))
    assert ok == 5


def test_tc_b03_02_stored_and_visible_time_is_recorded(env):
    """Mac 只驗流程並記錄時間；30 秒的判準要在甲方以真正的自動標註工具量測。"""
    c, pid, studies = env
    s = studies[0]
    started = time.monotonic()
    r = _submit(c, pid, "fake_segmentation", s["study_instance_uid"], s["sop_instance_uids"][1])
    assert r.status_code == 201, r.text
    annotation_id = r.json()["annotation"]["id"]
    got = c.get(f"/api/projects/{pid}/labels/annotations/{annotation_id}", headers=headers("vw01"))
    elapsed = time.monotonic() - started
    print(f"TC-B03-02 送出到可讀取：{elapsed:.2f} 秒（服務端耗時 {r.json()['run']['duration_ms']} 毫秒）")
    assert got.status_code == 200 and got.json()["source"] == "autolabel"
    assert elapsed < 30
    c.delete(f"/api/projects/{pid}/labels/annotations/{annotation_id}", headers=headers("md01"))


@pytest.mark.skipif(not pe.AVAILABLE, reason=pe.REASON)
def test_tc_b03_05_service_stopped_clear_error_and_nothing_stored(env):
    c, pid, studies = env
    s = studies[0]
    base = f"/api/projects/{pid}/labels"
    before = len(c.get(f"{base}/annotations", headers=headers("md01")).json())
    runs_before = len(c.get(f"{base}/autolabel/runs", headers=headers("md01")).json())
    pe.stop("autolabel")
    try:
        r = _submit(c, pid, "fake_detection", s["study_instance_uid"], s["sop_instance_uids"][0])
        assert r.status_code == 503
        assert r.json()["detail"] == "自動標註服務目前無法連線，請稍後再試"
        assert len(c.get(f"{base}/annotations", headers=headers("md01")).json()) == before
        assert len(c.get(f"{base}/autolabel/runs", headers=headers("md01")).json()) == runs_before
    finally:
        pe.start("autolabel")
    for _ in range(30):
        if c.get(f"{base}/autolabel/models", headers=headers("md01")).status_code == 200:
            break
        time.sleep(1)
    r = _submit(c, pid, "fake_detection", s["study_instance_uid"], s["sop_instance_uids"][0])
    assert r.status_code == 201
    c.delete(f"{base}/annotations/{r.json()['annotation']['id']}", headers=headers("md01"))
