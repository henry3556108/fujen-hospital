"""B-03 自動標註：經 Gateway 的驗收測試。同一份測試適用兩種自動標註服務，依 /autolabel/models 判斷：
- fake-autolabel（compose.labeling.yaml、kind 的預設）：模型 fake_segmentation、fake_detection，影像用合成的 20 個研究。
- 真實工具（compose.monai.yaml 疊加檔的 MONAI Label、正式環境）：分割模型（優先 segmentation_spleen），影像用腹部 CT
  （platform/autolabel/scripts/msd_to_dicom.py 的輸出，路徑由 AUTOLABEL_CT_DIR 指定；未設定時略過）。
  取 5 張不同、標準答案有脾臟的切面，結果遮罩都必須含前景（標籤值非 0）。
TC-B03-05 需要 COMPOSE_PROJECT 或 K8S_NAMESPACE（停止自動標註服務）；未設定時略過。"""
import json
import os
import time
from pathlib import Path

import pytest

import platform_exec as pe

from labeling_support import ensure_images, gateway, headers, p1_id

FAKE_MODELS = {"fake_detection", "fake_segmentation"}
CT_DIR = os.environ.get("AUTOLABEL_CT_DIR")
LIMIT_SECONDS = 30


def _ensure_ct(c, pid: int, folder: Path) -> list[tuple[str, str]]:
    """匯入腹部 CT 的第一個研究（已匯入的判為重複），回傳 5 個（研究, 切面）：標準答案脾臟較大的切面，平均分散取樣。"""
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    study = manifest["studies"][0]
    files = [folder / i["file"] for i in study["instances"]]
    for start in range(0, len(files), 20):
        batch = [("files", (p.name, p.read_bytes())) for p in files[start:start + 20]]
        r = c.post(f"/api/projects/{pid}/imaging/dicom", headers=headers("ra01"), files=batch, timeout=120)
        assert r.status_code == 201 and r.json()["counts"]["failed"] == 0, r.text
    with_spleen = sorted((i for i in study["instances"] if i["spleen_pixels"] > 0), key=lambda i: -i["spleen_pixels"])
    picked = sorted(with_spleen[: max(5, len(with_spleen) // 2)], key=lambda i: i["instance_number"])
    step = max(1, len(picked) // 5)
    return [(study["study_instance_uid"], i["sop_instance_uid"]) for i in picked[::step][:5]]


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    with gateway() as c:
        pid = p1_id(c)
        r = c.get(f"/api/projects/{pid}/labels/autolabel/models", headers=headers("md01"))
        assert r.status_code == 200, r.text
        models = {m["name"]: m["type"] for m in r.json()}
        fake = set(models) == FAKE_MODELS
        if fake:
            studies = ensure_images(c, pid, tmp_path_factory.mktemp("synth"))
            names = sorted(models, reverse=True)          # fake_segmentation、fake_detection 交替
            plan = [(names[i % 2], studies[i % len(studies)]["study_instance_uid"],
                     studies[i % len(studies)]["sop_instance_uids"][i // len(studies)]) for i in range(5)]
        else:
            if not CT_DIR:
                pytest.skip("真實自動標註工具要用腹部 CT：設定 AUTOLABEL_CT_DIR（msd_to_dicom.py 的輸出資料夾）")
            seg = sorted(n for n, t in models.items() if t == "segmentation")
            model = "segmentation_spleen" if "segmentation_spleen" in seg else seg[0]
            plan = [(model, study, sop) for study, sop in _ensure_ct(c, pid, Path(CT_DIR))]
        yield c, pid, fake, plan


def _submit(c, pid, model, study, sop):
    return c.post(f"/api/projects/{pid}/labels/autolabel", headers=headers("md01"),
                  json={"model": model, "study_instance_uid": study, "sop_instance_uid": sop}, timeout=60)


def _has_foreground(annotation: dict) -> bool:
    payload = annotation["payload"]
    return any(value != 0 for value, _ in payload.get("rle", [])) or bool(payload.get("boxes"))


def test_tc_b03_01_five_submissions_succeed(env):
    c, pid, fake, plan = env
    assert len(plan) == 5 and len({sop for _, _, sop in plan}) == 5
    ok, foreground = 0, 0
    for model, study, sop in plan:
        started = time.monotonic()
        r = _submit(c, pid, model, study, sop)
        elapsed = time.monotonic() - started
        assert r.status_code == 201, r.text
        body = r.json()
        print(f"TC-B03-01 {model} {sop}：{elapsed:.2f} 秒（服務端耗時 {body['run']['duration_ms']} 毫秒）")
        assert elapsed < LIMIT_SECONDS
        ok += 1
        foreground += _has_foreground(body["annotation"])
        c.delete(f"/api/projects/{pid}/labels/annotations/{body['annotation']['id']}", headers=headers("md01"))
    assert ok == 5
    if not fake:                    # 選的都是標準答案有脾臟的切面：真的模型要分割出東西
        assert foreground == 5


def test_tc_b03_02_stored_and_visible_time_is_recorded(env):
    c, pid, _, plan = env
    model, study, sop = plan[1]
    started = time.monotonic()
    r = _submit(c, pid, model, study, sop)
    assert r.status_code == 201, r.text
    annotation_id = r.json()["annotation"]["id"]
    got = c.get(f"/api/projects/{pid}/labels/annotations/{annotation_id}", headers=headers("vw01"))
    elapsed = time.monotonic() - started
    print(f"TC-B03-02 送出到可讀取：{elapsed:.2f} 秒（服務端耗時 {r.json()['run']['duration_ms']} 毫秒）")
    assert got.status_code == 200 and got.json()["source"] == "autolabel"
    assert elapsed < LIMIT_SECONDS
    c.delete(f"/api/projects/{pid}/labels/annotations/{annotation_id}", headers=headers("md01"))


@pytest.mark.skipif(not pe.AVAILABLE, reason=pe.REASON)
def test_tc_b03_05_service_stopped_clear_error_and_nothing_stored(env):
    c, pid, _, plan = env
    model, study, sop = plan[0]
    base = f"/api/projects/{pid}/labels"
    before = len(c.get(f"{base}/annotations", headers=headers("md01")).json())
    runs_before = len(c.get(f"{base}/autolabel/runs", headers=headers("md01")).json())
    pe.stop("autolabel")
    try:
        r = _submit(c, pid, model, study, sop)
        assert r.status_code == 503
        assert r.json()["detail"] == "自動標註服務目前無法連線，請稍後再試"
        assert len(c.get(f"{base}/annotations", headers=headers("md01")).json()) == before
        assert len(c.get(f"{base}/autolabel/runs", headers=headers("md01")).json()) == runs_before
    finally:
        pe.start("autolabel")
    for _ in range(60):
        if c.get(f"{base}/autolabel/models", headers=headers("md01")).status_code == 200:
            break
        time.sleep(1)
    r = _submit(c, pid, model, study, sop)
    assert r.status_code == 201, r.text
    c.delete(f"{base}/annotations/{r.json()['annotation']['id']}", headers=headers("md01"))
