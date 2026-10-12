"""HTTP 介面：規格欄位、錯誤對應、序列快取；DICOMweb 用戶端（QIDO 與 multipart）。"""
import io
import threading
import time

import httpx
import nibabel as nib
import numpy as np
import pytest
from app.labeling import formats, payloads
from conftest import make_series
from fastapi.testclient import TestClient
from test_spec import MONAI_INFO

from autolabel_adapter.app import Settings, create_app
from autolabel_adapter.dicomweb import DicomwebClient, DicomwebUnavailable, NotFound, split_multipart
from autolabel_adapter.monai import MonaiUnavailable


class FakeMonai:
    """體素 HU > 104 標為脾臟（1）。"""

    def __init__(self):
        self.calls = 0
        self.down = False
        self.gate: threading.Event | None = None

    def info(self):
        if self.down:
            raise MonaiUnavailable("down")
        return MONAI_INFO

    def infer_volume(self, model, nifti):
        self.calls += 1
        if self.gate:
            self.gate.wait(5)
        if self.down:
            raise MonaiUnavailable("down")
        image = nib.Nifti1Image.from_bytes(nifti)
        data = (np.asanyarray(image.dataobj) > 104).astype(np.uint8)
        return nib.Nifti1Image(data, image.affine).to_bytes()


class FakeDicomweb:
    def __init__(self, datasets):
        self.datasets = datasets
        self.fetches = 0

    def locate(self, sop):
        if sop not in {ds.SOPInstanceUID for ds in self.datasets}:
            raise NotFound(sop)
        return "1.2.3", "1.2.3.4"

    def series(self, study, series):
        self.fetches += 1
        return self.datasets


@pytest.fixture
def world():
    datasets = make_series()
    monai, dicomweb = FakeMonai(), FakeDicomweb(datasets)
    app = create_app(Settings(min_slices=4, infer_wait_seconds=2), monai=monai, dicomweb=dicomweb)
    ordered = sorted(datasets, key=lambda ds: ds.ImagePositionPatient[2])
    return TestClient(app), monai, dicomweb, [ds.SOPInstanceUID for ds in ordered]


def test_info_is_the_spec_subset(world):
    client, *_ = world
    body = client.get("/info/").json()
    models = formats.validate_info(body)
    assert sorted(models) == ["segmentation", "segmentation_spleen"]
    assert set(body) == {name for name, _, _ in formats.INFO_FIELDS}


def test_infer_returns_the_requested_slice_and_caches_the_series(world):
    client, monai, dicomweb, uids = world
    for k in (0, 7, 3):
        r = client.post("/infer/segmentation_spleen", params={"image": uids[k]})
        assert r.status_code == 200, r.text
        body = r.json()
        payload = formats.to_payload("segmentation", body, model="segmentation_spleen", image=uids[k])
        mask = np.array(payloads.mask_from_rle(payload["rle"])).reshape(payload["shape"])
        expected = np.ones((6, 5), dtype=int) * (100 + k > 104)
        expected[0, 0] = 0                                   # 空氣
        assert np.array_equal(mask, expected)
    assert monai.calls == 1 and dicomweb.fetches == 1        # 同一序列只推論一次
    client.post("/infer/segmentation", params={"image": uids[0]})
    assert monai.calls == 2                                  # 不同模型另外推論


def test_unknown_model_or_image_is_404(world):
    client, *_ = world
    uids = world[3]
    assert client.post("/infer/nope", params={"image": uids[0]}).status_code == 404
    assert client.post("/infer/deepedit", params={"image": uids[0]}).status_code == 404   # 不是自動分割
    assert client.post("/infer/segmentation_spleen", params={"image": "9.9.9"}).status_code == 404
    assert client.post("/infer/segmentation_spleen").status_code == 422                   # 少了 image


def test_monai_down_is_503_and_nothing_is_cached(world):
    client, monai, _, uids = world
    client.get("/info/")
    monai.down = True
    assert client.get("/info/").status_code == 503
    assert client.post("/infer/segmentation_spleen", params={"image": uids[0]}).status_code == 503
    monai.down = False
    assert client.post("/infer/segmentation_spleen", params={"image": uids[0]}).status_code == 200


def test_slow_inference_answers_503_then_the_retry_uses_the_result(world):
    client, monai, _, uids = world
    monai.gate = threading.Event()
    r = client.post("/infer/segmentation_spleen", params={"image": uids[0]})
    assert r.status_code == 503 and "進行中" in r.json()["detail"]
    monai.gate.set()
    for _ in range(50):
        r = client.post("/infer/segmentation_spleen", params={"image": uids[0]})
        if r.status_code == 200:
            break
        time.sleep(0.1)
    assert r.status_code == 200 and monai.calls == 1


def test_series_too_short_for_3d_is_422():
    datasets = make_series(n=3)
    client = TestClient(create_app(Settings(min_slices=8), monai=FakeMonai(), dicomweb=FakeDicomweb(datasets)))
    r = client.post("/infer/segmentation_spleen", params={"image": datasets[0].SOPInstanceUID})
    assert r.status_code == 422 and "至少" in r.json()["detail"]


# ---------- DICOMweb ----------

def _multipart(parts: list[bytes], boundary: str = "b0undary") -> bytes:
    body = b""
    for p in parts:
        body += f"--{boundary}\r\nContent-Type: application/dicom\r\n\r\n".encode() + p + b"\r\n"
    return body + f"--{boundary}--\r\n".encode()


def _dicom_bytes(ds) -> bytes:
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def test_dicomweb_client_locates_and_fetches_a_series():
    datasets = make_series(n=3)
    for ds in datasets:
        ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
        ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    blobs = [_dicom_bytes(ds) for ds in datasets]
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.headers.get("accept"),
                     request.headers.get("authorization")))
        if request.url.path == "/dicom-web/instances":
            if request.url.params["SOPInstanceUID"] == "missing":
                return httpx.Response(200, json=[])
            return httpx.Response(200, json=[{"0020000D": {"vr": "UI", "Value": ["1.2.3"]},
                                              "0020000E": {"vr": "UI", "Value": ["1.2.3.4"]}}])
        if request.url.path == "/dicom-web/studies/1.2.3/series/1.2.3.4":
            return httpx.Response(200, content=_multipart(blobs),
                                  headers={"content-type": 'multipart/related; type="application/dicom"; boundary=b0undary'})
        return httpx.Response(500)

    client = DicomwebClient("http://orthanc/dicom-web", client=httpx.Client(
        base_url="http://orthanc/dicom-web", transport=httpx.MockTransport(handler), auth=httpx.BasicAuth("autolabel", "pw")))
    assert client.locate("x") == ("1.2.3", "1.2.3.4")
    with pytest.raises(NotFound):
        client.locate("missing")
    got = client.series("1.2.3", "1.2.3.4")
    assert [ds.SOPInstanceUID for ds in got] == [ds.SOPInstanceUID for ds in datasets]
    assert {method for method, *_ in seen} == {"GET"}                  # 唯讀帳號只會送 GET
    assert "transfer-syntax=1.2.840.10008.1.2.1" in seen[-1][2]
    assert seen[0][3].startswith("Basic ")


def test_dicomweb_down_or_unauthorised_is_unavailable():
    for status in (500, 401):
        c = DicomwebClient("http://o", client=httpx.Client(
            base_url="http://o", transport=httpx.MockTransport(lambda r, s=status: httpx.Response(s))))
        with pytest.raises(DicomwebUnavailable):
            c.locate("x")


def test_split_multipart_keeps_binary_content():
    parts = [b"\x00\r\n\x01binary", b"second"]
    assert split_multipart(_multipart(parts), 'multipart/related; boundary="b0undary"') == parts
