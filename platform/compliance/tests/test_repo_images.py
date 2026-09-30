"""TC-D01-07 對本 repo 實際的部署檔：來源全部核准，而且每個映像都釘住版本（tag 或 digest），沒有「未釘版本」警告。

離線探索（不下載遠端部署檔）：只看 repo 內的 compose、manifest、Dockerfile 與程式預設值。
"""
from pathlib import Path

from compliance.discover import discover
from compliance.sources import Policy, check_declared

PLATFORM = Path(__file__).resolve().parents[2]


def test_deploy_images_are_all_pinned_and_approved():
    report = check_declared(discover(PLATFORM), Policy.load())
    assert report.unapproved == []
    assert report.unpinned == []


def test_minio_is_pinned_by_digest():
    inv = discover(PLATFORM)
    [minio] = [i for i in inv.images.values() if i.ref.name == "cgr.dev/chainguard/minio"]
    assert minio.ref.digest and minio.ref.digest.startswith("sha256:") and len(minio.ref.digest) == 71
