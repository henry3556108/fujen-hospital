"""向平台 DICOM 節點（Orthanc DICOMweb）取像。只用標準 QIDO-RS／WADO-RS 的 GET，換成其他 DICOMweb 伺服器也適用。

規格 §1：服務以自己的服務帳號向平台 DICOM 節點取像，不使用使用者的 token。
帳號在 Orthanc 端只允許 GET /dicom-web/（platform/deploy/local/orthanc/platform/autolabel-readonly.lua）。
"""
from __future__ import annotations

import io
import re

import httpx
import pydicom
from pydicom.dataset import Dataset

# 要求伺服器轉成未壓縮的 Explicit VR Little Endian：轉接服務只用 pydicom 解碼，不帶 JPEG 等編碼器
ACCEPT_SERIES = 'multipart/related; type="application/dicom"; transfer-syntax=1.2.840.10008.1.2.1'
STUDY_UID, SERIES_UID = "0020000D", "0020000E"


class DicomwebUnavailable(Exception):
    """連不到 DICOM 節點、逾時或回 5xx（對平台回 503）。"""


class NotFound(Exception):
    """找不到這張影像（對平台回 404）。"""


class DicomwebClient:
    def __init__(self, base_url: str, *, username: str = "", password: str = "", timeout: float = 20.0,
                 client: httpx.Client | None = None):
        auth = httpx.BasicAuth(username, password) if username else None
        self._client = client or httpx.Client(base_url=base_url.rstrip("/"), auth=auth, timeout=timeout)

    def _get(self, path: str, **kwargs) -> httpx.Response:
        try:
            response = self._client.get(path, **kwargs)
        except httpx.HTTPError as exc:
            raise DicomwebUnavailable(f"DICOM 節點無法連線：{type(exc).__name__}") from exc
        if response.status_code >= 500 or response.status_code in (401, 403):
            raise DicomwebUnavailable(f"DICOM 節點回應 HTTP {response.status_code}")
        return response

    def locate(self, sop_uid: str) -> tuple[str, str]:
        """SOP Instance UID → (StudyInstanceUID, SeriesInstanceUID)。"""
        response = self._get("/instances", params={"SOPInstanceUID": sop_uid},
                             headers={"Accept": "application/dicom+json"})
        if response.status_code == 404 or response.status_code == 204 or not response.content.strip():
            raise NotFound(sop_uid)
        if response.status_code >= 400:
            raise DicomwebUnavailable(f"DICOM 節點回應 HTTP {response.status_code}")
        rows = response.json()
        if not rows:
            raise NotFound(sop_uid)
        try:
            row = rows[0]
            return row[STUDY_UID]["Value"][0], row[SERIES_UID]["Value"][0]
        except (KeyError, IndexError, TypeError) as exc:
            raise DicomwebUnavailable("DICOM 節點的查詢結果缺少 Study／Series UID") from exc

    def series(self, study_uid: str, series_uid: str) -> list[Dataset]:
        """WADO-RS 取回整個序列（multipart/related）。"""
        response = self._get(f"/studies/{study_uid}/series/{series_uid}", headers={"Accept": ACCEPT_SERIES})
        if response.status_code == 404:
            raise NotFound(series_uid)
        if response.status_code >= 400:
            raise DicomwebUnavailable(f"DICOM 節點回應 HTTP {response.status_code}")
        return [pydicom.dcmread(io.BytesIO(part)) for part in split_multipart(
            response.content, response.headers.get("content-type", ""))]


def split_multipart(body: bytes, content_type: str) -> list[bytes]:
    """multipart/related 的各段內容（去掉每段的標頭）。"""
    match = re.search(r'boundary="?([^";]+)"?', content_type, re.I)
    if not match:
        raise DicomwebUnavailable("DICOM 節點的回應不是 multipart")
    delimiter = b"--" + match.group(1).encode()
    parts = []
    for chunk in body.split(delimiter)[1:]:
        if chunk.startswith(b"--"):            # 結尾的 --boundary--
            break
        head, sep, content = chunk.partition(b"\r\n\r\n")
        if not sep:
            continue
        if content.endswith(b"\r\n"):
            content = content[:-2]
        parts.append(content)
    return parts
