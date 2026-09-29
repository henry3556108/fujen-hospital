"""WP5a OHIF 檢視器：經 Gateway 的 9081 埠提供；DICOMweb 與 OHIF 同源，Accession 清單照樣生效。
需要 compose.labeling.yaml 堆疊。OHIF_URL 預設 http://localhost:9081。"""
import os

import httpx
import pytest

from conftest import KEYCLOAK
from labeling_support import ensure_images, gateway, headers, p1_id

OHIF = os.environ.get("OHIF_URL", "http://localhost:9081")


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    with gateway() as c:
        pid = p1_id(c)
        studies = ensure_images(c, pid, tmp_path_factory.mktemp("synth"))
        with httpx.Client(base_url=OHIF, timeout=30) as o:
            yield o, pid, studies


def test_viewer_is_served_with_platform_config(env):
    o, _, _ = env
    assert o.get("/").status_code == 200
    assert o.get("/viewer?StudyInstanceUIDs=1.2.3&project=1").status_code == 200    # SPA 路由
    config = o.get("/app-config.js").text
    assert "/dicomweb/projects/" in config and "ai-platform-ohif" in config and "showStudyList: false" in config


def test_ohif_client_exists_in_keycloak():
    r = httpx.get(f"{KEYCLOAK}/realms/ai-platform/protocol/openid-connect/auth",
                  params={"client_id": "ai-platform-ohif", "response_type": "code", "scope": "openid",
                          "redirect_uri": f"{OHIF}/callback", "code_challenge": "x" * 43,
                          "code_challenge_method": "S256"})
    assert r.status_code == 200 and "kc-form-login" in r.text


def test_dicomweb_through_viewer_origin_and_bulkdata_rewritten(env):
    o, pid, studies = env
    ra = headers("ra01")
    s = studies[0]
    base = f"/dicomweb/projects/{pid}/studies/{s['study_instance_uid']}"
    # OHIF 送出的研究查詢形式
    q = o.get(f"/dicomweb/projects/{pid}/studies?limit=101&offset=0&fuzzymatching=false"
              f"&includefield=00081030%2C00080060&StudyInstanceUID={s['study_instance_uid']}", headers=ra)
    assert q.status_code == 200 and len(q.json()) == 1
    series = o.get(f"{base}/series?includefield=0008103E%2C00080021", headers=ra)
    assert series.status_code == 200
    series_uid = series.json()[0]["0020000E"]["Value"][0]
    meta = o.get(f"{base}/series/{series_uid}/metadata", headers=ra)
    assert meta.status_code == 200
    bulk = meta.json()[0]["7FE00010"]["BulkDataURI"]
    assert bulk.startswith(f"{OHIF}/dicomweb/projects/{pid}/studies/"), bulk     # 不外洩 Orthanc 內部位址
    assert o.get(bulk.removeprefix(OHIF), headers=ra).status_code == 200
    assert o.get(bulk.removeprefix(OHIF)).status_code == 401


def test_viewer_origin_does_not_bypass_allowlist_or_membership(env):
    o, pid, studies = env
    assert o.get(f"/dicomweb/projects/{pid}/studies/{studies[0]['study_instance_uid']}/series",
                 headers=headers("user01")).status_code == 403
    assert o.get(f"/dicomweb/projects/{pid}/studies?limit=101&offset=0&fuzzymatching=false",
                 headers=headers("ra01")).status_code == 403                  # 不可列出全部研究
    assert o.post(f"/dicomweb/projects/{pid}/studies", headers=headers("ra01")).status_code in (403, 404, 405)
    direct = o.get("/dicom-web/studies", headers=headers("ra01"))     # Orthanc 原生路徑：只會拿到 OHIF 的網頁
    assert "dicom+json" not in direct.headers.get("content-type", "")
