from pathlib import Path

import pytest

from compliance.tools import FakeToolRunner


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def sbom(*artifacts, digest="sha256:aaa", distro=("Alpine Linux", "3.24.2")) -> dict:
    return {
        "artifacts": [{"name": n, "version": v, "type": t,
                       "licenses": [{"value": lic, "spdxExpression": lic}] if lic else []}
                      for n, v, t, lic in artifacts],
        "source": {"metadata": {"repoDigests": [f"x@{digest}"], "architecture": "amd64"}},
        "distro": {"name": distro[0], "versionID": distro[1]},
    }


TOOLS = {"syft": {"version": "1.0", "image": "anchore/syft@sha256:1", "source": "s", "licence": "Apache-2.0"},
         "trivy": {"version": "0.1", "image": "aquasec/trivy@sha256:2", "source": "t", "licence": "Apache-2.0"}}


@pytest.fixture
def platform(tmp_path):
    """一個小的 platform/ 目錄：一個外部映像、一個自建映像、一組 Python 套件、一組 Node 套件。"""
    root = tmp_path / "platform"
    write(root / "deploy/local/compose.yaml",
          'services:\n  db: {image: "postgres:16-alpine"}\n  api:\n    build: {context: ../.., dockerfile: api/Dockerfile}\n')
    write(root / "api/Dockerfile", "FROM python:3.12-slim\n")
    write(root / "api/uv.lock", 'version = 1\n[[package]]\nname = "fastapi"\nversion = "0.115.0"\n'
                                '[[package]]\nname = "colorama"\nversion = "0.4.6"\n')
    write(root / "web/package-lock.json",
          '{"packages": {"": {"name": "web"}, "node_modules/react": {"version": "19.3.0", "license": "MIT"}}}')
    site = tmp_path / "site-packages"
    write(site / "fastapi-0.115.0.dist-info/METADATA", "Name: fastapi\nVersion: 0.115.0\nLicense-Expression: MIT\n")
    return root, site


@pytest.fixture
def runner(platform):
    _, site = platform
    return FakeToolRunner(
        sboms={
            "docker.io/library/postgres:16-alpine": sbom(("musl", "1.2.5", "apk", "MIT"), ("busybox", "1.37", "apk", "GPL-2.0-only")),
            "docker.io/library/python:3.12-slim": sbom(("libc6", "2.41", "deb", "LGPL-2.1")),
            "compliance-scan/api:latest": sbom(("fastapi", "0.115.0", "python", "MIT"), ("libc6", "2.41", "deb", ""),
                                               distro=("Debian GNU/Linux", "13")),
        },
        site_packages={"api": site},
    )
