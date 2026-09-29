"""自動標註：送出、回存、開啟編輯、離線、格式規格（TC-B03-01、03、04、05）。"""
import re
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.labeling import formats
from app.labeling.autolabel import (AutolabelRejected, AutolabelUnavailable, HttpAutolabel, InMemoryAutolabel,
                                    autolabel_from_env)
from app.labeling.models import Annotation, AutolabelRun
from app.models import AuditLog
from imaging_support import sop_uid, study_uid

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "platform" / "fakes"))
from fakes import faults  # noqa: E402
from fakes.autolabel import app as fake_app  # noqa: E402


@pytest.fixture
def auto(app):
    client = InMemoryAutolabel()
    app.state.autolabel = client
    return client


@pytest.fixture
def fake_service(app, monkeypatch):
    """HttpAutolabel 接 platform/fakes 的 fake-autolabel（ASGI 直接呼叫，不開連接埠）。"""
    monkeypatch.delenv("FAKE_AUTOLABEL_FAIL_RATE", raising=False)
    monkeypatch.delenv("FAKE_AUTOLABEL_DELAY_MS", raising=False)
    faults.reset_counter(fake_app)
    app.state.autolabel = HttpAutolabel("http://autolabel", client=TestClient(fake_app, base_url="http://autolabel"))
    return app.state.autolabel


def _submit(client, lab, model, no=1, s=1, headers=None):
    return client.post(f"{lab.base}/autolabel", headers=headers or lab.doctor,
                       json={"model": model, "study_instance_uid": study_uid(no), "sop_instance_uid": sop_uid(no, s)})


def _counts(session):
    session.expire_all()
    return (session.scalar(select(func.count()).select_from(Annotation)),
            session.scalar(select(func.count()).select_from(AutolabelRun)))


# ---------- 送出與回存 ----------

def test_tc_b03_01_five_submissions_all_succeed_and_are_stored(client, lab, fake_service, session):
    models = client.get(f"{lab.base}/autolabel/models", headers=lab.doctor).json()
    assert [(m["name"], m["type"]) for m in models] == [("fake_detection", "detection"),
                                                        ("fake_segmentation", "segmentation")]
    sent = [("fake_segmentation", 1, 1), ("fake_segmentation", 1, 2), ("fake_detection", 2, 1),
            ("fake_detection", 3, 1), ("fake_segmentation", 4, 3)]
    for model, no, s in sent:
        r = _submit(client, lab, model, no, s)
        assert r.status_code == 201, r.text
        body = r.json()
        a, run = body["annotation"], body["run"]
        assert a["source"] == "autolabel" and a["kind"] == run["model_type"] == model.removeprefix("fake_")
        assert a["sop_instance_uid"] == sop_uid(no, s) and a["autolabel_run_id"] == run["id"]
        assert run["annotation_id"] == a["id"] and run["model"] == model and run["duration_ms"] >= 0
        # 回存的內容與服務回應一致
        raw = fake_service.infer(model, sop_uid(no, s))
        assert a["payload"] == {k: raw[k] for k in formats.STORED_FIELDS[a["kind"]]}
        # 重新載入取得同一份
        assert client.get(f"{lab.base}/annotations/{a['id']}", headers=lab.viewer).json() == a
    assert _counts(session) == (5, 5)
    runs = client.get(f"{lab.base}/autolabel/runs", headers=lab.viewer).json()
    assert len(runs) == 5 and runs[0]["id"] > runs[-1]["id"]
    listed = client.get(f"{lab.base}/annotations", headers=lab.doctor, params={"source": "autolabel"}).json()
    assert len(listed) == 5


def test_tc_b03_03_open_result_edit_and_save(client, lab, auto, member):
    created = _submit(client, lab, "mem_detection").json()["annotation"]
    opened = client.get(f"{lab.base}/annotations/{created['id']}", headers=lab.doctor).json()
    edited = dict(opened["payload"])
    edited["boxes"] = [*edited["boxes"], {"label": "lung", "box": [0, 0, 8, 8]}]
    ra = member("ra01", lab.project)
    r = client.put(f"{lab.base}/annotations/{created['id']}", headers=ra, json={"payload": edited})
    assert r.status_code == 200, r.text
    got = client.get(f"{lab.base}/annotations/{created['id']}", headers=lab.doctor).json()
    assert got["payload"]["boxes"] == edited["boxes"]
    assert (got["source"], got["version"], got["created_by"], got["updated_by"]) == ("autolabel", 2, "md01", "ra01")
    assert got["autolabel_run_id"] == created["autolabel_run_id"]

    seg = _submit(client, lab, "mem_segmentation", 2, 1).json()["annotation"]
    payload = dict(seg["payload"])
    payload["rle"] = [[0, 60], [2, 4]]
    assert client.put(f"{lab.base}/annotations/{seg['id']}", headers=lab.doctor, json={"payload": payload}).status_code == 200
    assert client.get(f"{lab.base}/annotations/{seg['id']}", headers=lab.doctor).json()["payload"]["rle"] == [[0, 60], [2, 4]]


def test_submission_is_audited_as_dataset(client, lab, auto, session):
    body = _submit(client, lab, "mem_segmentation").json()
    row = session.scalars(select(AuditLog).order_by(AuditLog.id.desc())).first()
    assert (row.category, row.action, row.result, row.actor) == ("dataset", "autolabel.submit", "success", "md01")
    assert row.target == f"project:{lab.pid}/image:{sop_uid(1, 1)}"
    assert row.detail["annotation_id"] == body["annotation"]["id"] and row.detail["model"] == "mem_segmentation"
    assert row.detail["spec_version"] == formats.SPEC_VERSION


def test_permission_and_target_checks(client, lab, auto, session):
    assert _submit(client, lab, "mem_detection", headers=lab.viewer).status_code == 403
    assert client.post(f"{lab.base}/autolabel", json={}).status_code == 401
    r = client.post(f"{lab.base}/autolabel", headers=lab.doctor,
                    json={"model": "mem_detection", "study_instance_uid": study_uid(1), "sop_instance_uid": sop_uid(2, 1)})
    assert r.status_code == 404
    assert _submit(client, lab, "no_such_model").status_code == 404
    assert client.post(f"{lab.base}/autolabel", headers=lab.doctor,
                       json={"model": "../x", "study_instance_uid": study_uid(1), "sop_instance_uid": sop_uid(1, 1)}
                       ).status_code == 422
    assert auto.calls == []             # 以上都沒有打到自動標註服務
    assert _counts(session) == (0, 0)


def test_not_configured_is_503(client, lab, monkeypatch):
    monkeypatch.delenv("AUTOLABEL_URL", raising=False)
    r = _submit(client, lab, "mem_detection")
    assert r.status_code == 503 and "尚未設定" in r.json()["detail"]
    assert autolabel_from_env({}) is None
    assert isinstance(autolabel_from_env({"AUTOLABEL_URL": "http://autolabel:8102/"}), HttpAutolabel)


# ---------- 離線與異常 ----------

def test_tc_b03_05_service_offline_clear_error_and_nothing_stored(client, lab, auto, session):
    ok = _submit(client, lab, "mem_segmentation")
    assert ok.status_code == 201
    before = _counts(session)
    auto.offline = True
    for _ in range(3):
        r = _submit(client, lab, "mem_segmentation", 2, 1)
        assert r.status_code == 503
        assert r.json()["detail"] == "自動標註服務目前無法連線，請稍後再試"
    assert client.get(f"{lab.base}/autolabel/models", headers=lab.doctor).status_code == 503
    assert _counts(session) == before
    failures = session.scalars(select(AuditLog).where(AuditLog.action == "autolabel.submit",
                                                      AuditLog.result == "failure")).all()
    assert len(failures) == 3 and all(f.detail["reason"] == "unavailable" for f in failures)
    # 服務恢復後可以再送
    auto.offline = False
    assert _submit(client, lab, "mem_segmentation", 2, 1).status_code == 201


def test_tc_b03_05_http_service_down_timeout_and_5xx(client, lab, app, session, fake_service):
    def boom(request):
        raise httpx.ConnectError("connection refused", request=request)

    def slow(request):
        raise httpx.ReadTimeout("timed out", request=request)

    for handler in (boom, slow, lambda request: httpx.Response(503, json={"detail": "down"})):
        app.state.autolabel = HttpAutolabel("http://autolabel", client=httpx.Client(
            base_url="http://autolabel", transport=httpx.MockTransport(handler)))
        r = _submit(client, lab, "fake_segmentation")
        assert r.status_code == 503 and "無法連線" in r.json()["detail"]
    assert _counts(session) == (0, 0)


def test_tc_b03_05_fault_injected_mid_request_leaves_nothing(client, lab, fake_service, session, monkeypatch):
    """模型清單查得到、送出推論時服務才掛掉：仍然不留下半筆結果。"""
    monkeypatch.setenv("FAKE_AUTOLABEL_FAIL_RATE", "0.5")   # 第 2、4、6… 個請求回 503
    faults.reset_counter(fake_app)
    r = _submit(client, lab, "fake_detection")               # 第 1 個請求 /info/ 成功，第 2 個 /infer 失敗
    assert r.status_code == 503
    assert _counts(session) == (0, 0)


def test_malformed_result_is_502_and_nothing_stored(client, lab, auto, session):
    auto.corrupt = True
    for model in ("mem_segmentation", "mem_detection"):
        r = _submit(client, lab, model)
        assert r.status_code == 502 and "不合規格" in r.json()["detail"]
    assert _counts(session) == (0, 0)


def test_empty_detection_creates_no_annotation(client, lab, auto, session):
    auto.empty_detection = True
    r = _submit(client, lab, "mem_detection")
    assert r.status_code == 422 and "沒有偵測到物件" in r.json()["detail"]
    assert _counts(session) == (0, 0)


def test_http_client_maps_4xx_to_rejected():
    c = HttpAutolabel("http://x", client=httpx.Client(base_url="http://x", transport=httpx.MockTransport(
        lambda request: httpx.Response(404, json={"detail": "Model not found"}))))
    with pytest.raises(AutolabelRejected):
        c.infer("m", "1.2.3")
    c = HttpAutolabel("http://x", client=httpx.Client(base_url="http://x", transport=httpx.MockTransport(
        lambda request: httpx.Response(200, text="<html>"))))
    with pytest.raises(formats.FormatError):
        c.info()
    with pytest.raises(AutolabelUnavailable):
        HttpAutolabel("http://127.0.0.1:1", timeout=0.5).info()


# ---------- 格式規格（TC-B03-04） ----------

SPEC_DOC = REPO / "docs" / "specs" / "autolabel-io-format.md"


def _doc_table(section: str) -> list[tuple[str, str, bool]]:
    text = SPEC_DOC.read_text(encoding="utf-8")
    block = re.search(rf"<!-- spec:{section} -->\n(.*?)<!-- /spec:{section} -->", text, re.S).group(1)
    rows = [[c.strip() for c in line.strip().strip("|").split("|")] for line in block.strip().splitlines()[2:]]
    return [(name, kind, {"是": True, "否": False}[required]) for name, kind, required, _ in rows]


@pytest.mark.parametrize("section,fields", [
    ("info", formats.INFO_FIELDS), ("model", formats.MODEL_FIELDS),
    ("segmentation", formats.SEGMENTATION_FIELDS), ("detection", formats.DETECTION_FIELDS)])
def test_tc_b03_04_document_and_code_agree(section, fields):
    assert _doc_table(section) == fields


def test_tc_b03_04_document_states_version_and_call_shape():
    text = SPEC_DOC.read_text(encoding="utf-8")
    assert f"版本：{formats.SPEC_VERSION}" in text
    assert f"`GET {formats.INFO_PATH}`" in text
    assert f"`POST {formats.INFER_PATH}?{formats.IMAGE_PARAM}={{image_id}}`" in text


def test_tc_b03_04_service_output_matches_spec_with_zero_differences(fake_service):
    """實際服務回應的欄位集合＝規格欄位集合（不多不少），型別全部符合。"""
    info = fake_service.info()
    models = formats.validate_info(info)
    assert set(info) == {name for name, _, _ in formats.INFO_FIELDS}
    differences = []
    for name, meta in models.items():
        extra = set(meta) - {f for f, _, _ in formats.MODEL_FIELDS}
        if extra:
            differences.append((name, "model", extra))
        for image in ("1.2.3.1", "1.2.3.2", "1.2.3.3"):
            body = fake_service.infer(name, image)
            spec = formats.RESULT_FIELDS[meta["type"]]
            required = {f for f, _, req in spec if req}
            allowed = {f for f, _, _ in spec}
            if not required <= set(body) or set(body) - allowed:
                differences.append((name, image, set(body) ^ allowed))
            payload = formats.to_payload(meta["type"], body, model=name, image=image)
            assert payload is not None and set(payload) == set(formats.STORED_FIELDS[meta["type"]])
    assert differences == []


def test_tc_b03_04_request_shape_sent_to_service():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, dict(request.url.params), request.content))
        return httpx.Response(200, json={})

    c = HttpAutolabel("http://x", client=httpx.Client(base_url="http://x", transport=httpx.MockTransport(handler)))
    c.info()
    c.infer("fake_segmentation", "1.2.3")
    assert seen == [("GET", "/info/", {}, b""), ("POST", "/infer/fake_segmentation", {"image": "1.2.3"}, b"")]


@pytest.mark.parametrize("model_type,mutate", [
    ("segmentation", lambda b: b.pop("rle")),
    ("segmentation", lambda b: b.update(shape="64x64")),
    ("segmentation", lambda b: b.update(image="other")),
    ("detection", lambda b: b.pop("box_format")),
    ("detection", lambda b: b.update(boxes=[{"label": "a", "box": [1, 1, 1, 1]}])),
    ("detection", lambda b: b.update(model="other")),
])
def test_tc_b03_04_deviations_are_rejected(model_type, mutate):
    body = InMemoryAutolabel().infer(f"mem_{model_type}", "1.2.3")
    formats.to_payload(model_type, dict(body), model=f"mem_{model_type}", image="1.2.3")
    mutate(body)
    with pytest.raises(formats.FormatError):
        formats.to_payload(model_type, body, model=f"mem_{model_type}", image="1.2.3")
