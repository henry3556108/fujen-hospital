import json
from pathlib import Path

from compliance.discover import (dockerfile_bases, discover, manifest_images, node_packages, parse_image,
                                 python_packages)


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_parse_image_forms():
    assert str(parse_image("postgres:16-alpine")) == "docker.io/library/postgres:16-alpine"
    assert str(parse_image("grafana/grafana:13.2.2")) == "docker.io/grafana/grafana:13.2.2"
    assert str(parse_image("quay.io/keycloak/keycloak:26.0")) == "quay.io/keycloak/keycloak:26.0"
    assert parse_image("busybox").tag == "latest"
    ref = parse_image("kindest/node:v1.37.0@sha256:abc")
    assert (ref.registry, ref.repository, ref.tag, ref.digest) == ("docker.io", "kindest/node", "v1.37.0", "sha256:abc")
    assert parse_image("localhost:5000/x/y:1").registry == "localhost:5000"


def test_unpinned_tags_are_flagged():
    assert not parse_image("cgr.dev/chainguard/minio:latest").pinned
    assert not parse_image("busybox").pinned
    assert parse_image("busybox:1.36").pinned
    assert parse_image("x/y@sha256:abc").pinned


def test_compose_images_builds_overlays_and_image_env(tmp_path):
    write(tmp_path / "api/Dockerfile", "# Build context 是 platform/\nFROM ghcr.io/astral-sh/uv:python3.12 AS build\n"
                                       "FROM build\nFROM scratch\n")
    write(tmp_path / "deploy/local/compose.yaml", """
services:
  postgres: {image: "postgres:16-alpine"}
  api:
    build: {context: ../.., dockerfile: api/Dockerfile}
  init:
    build: {context: ../.., dockerfile: api/Dockerfile}
  orthanc: {image: "jodogne/orthanc-plugins:1.13.0", platform: linux/amd64}
""")
    write(tmp_path / "deploy/local/compose.extra.yaml", """
services:
  api:
    environment: {JOB_IMAGE: "busybox:1.36", OTHER: "not-an-image"}
  fhir: {image: "hapiproject/hapi:v8.0.0"}
  listenv:
    image: "x/y:1"
    environment: ["TRAIN_IMAGE=a/b:2", "FOO=bar"]
""")
    inv = discover(tmp_path)
    assert set(inv.images) == {
        "docker.io/library/postgres:16-alpine", "docker.io/jodogne/orthanc-plugins:1.13.0",
        "docker.io/library/busybox:1.36", "docker.io/hapiproject/hapi:v8.0.0", "docker.io/x/y:1",
        "docker.io/a/b:2", "ghcr.io/astral-sh/uv:python3.12",
    }
    assert inv.images["docker.io/jodogne/orthanc-plugins:1.13.0"].platforms == {"linux/amd64"}
    assert list(inv.builds) == ["api/Dockerfile"]
    build = inv.builds["api/Dockerfile"]
    assert build.name == "api" and build.context == tmp_path.resolve()
    assert build.used_by == {"compose:deploy/local/compose.yaml#api", "compose:deploy/local/compose.yaml#init"}
    assert [str(b) for b in build.base_images] == ["ghcr.io/astral-sh/uv:python3.12"]


def test_kubernetes_manifests_any_depth(tmp_path):
    write(tmp_path / "deploy/kind/monitoring/prom.yaml", """
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      initContainers: [{name: i, image: "busybox:1.36"}]
      containers: [{name: p, image: "quay.io/prometheus/prometheus:v3.15.0"}]
---
kind: Cluster
nodes:
  - {role: worker, image: "kindest/node:v1.37.0@sha256:abc"}
""")
    inv = discover(tmp_path)
    assert set(inv.images) == {"docker.io/library/busybox:1.36", "quay.io/prometheus/prometheus:v3.15.0",
                               "docker.io/kindest/node:v1.37.0@sha256:abc"}


def test_remote_manifest_in_script_is_fetched_with_default_variables(tmp_path):
    write(tmp_path / "deploy/kind/up.sh", '''#!/usr/bin/env bash
KUEUE_VERSION="${KUEUE_VERSION:-v0.19.6}"
kubectl apply -f "https://example.test/kueue/$KUEUE_VERSION/manifests.yaml" >/dev/null
''')
    seen = []

    def fetch(url):
        seen.append(url)
        return "spec:\n  containers:\n    - image: registry.k8s.io/kueue/kueue:v0.19.6\n"

    inv = discover(tmp_path, fetch=fetch)
    assert seen == ["https://example.test/kueue/v0.19.6/manifests.yaml"]
    assert "registry.k8s.io/kueue/kueue:v0.19.6" in inv.images
    assert inv.warnings == []


def test_remote_manifest_offline_or_failed_is_a_warning_not_silence(tmp_path):
    write(tmp_path / "up.sh", 'kubectl apply -f https://example.test/m.yaml\n')
    assert "未下載遠端部署檔" in discover(tmp_path).warnings[0]

    def boom(url):
        raise OSError("no network")
    assert "下載遠端部署檔失敗" in discover(tmp_path, fetch=boom).warnings[0]


def test_default_image_in_code(tmp_path):
    write(tmp_path / "api/app/kube.py", 'image=os.environ.get("JOB_IMAGE", "busybox:1.36")\n')
    write(tmp_path / "api/tests/test_x.py", 'os.environ.get("JOB_IMAGE", "evil/test:1")\n')
    assert set(discover(tmp_path).images) == {"docker.io/library/busybox:1.36"}


def test_unexpanded_variable_is_a_warning(tmp_path):
    write(tmp_path / "compose.yaml", 'services:\n  a: {image: "${REG}/x:1"}\n')
    inv = discover(tmp_path)
    assert inv.images == {} and "未展開的變數" in inv.warnings[0]


def test_standalone_dockerfile_is_listed(tmp_path):
    write(tmp_path / "fakes/Dockerfile", "FROM python:3.12-slim\n")
    write(tmp_path / "fakes/Dockerfile.dockerignore", ".venv\n")
    inv = discover(tmp_path)
    assert list(inv.builds) == ["fakes/Dockerfile"]
    assert inv.builds["fakes/Dockerfile"].context == (tmp_path / "fakes")


def test_package_sets_skip_vendored_dirs(tmp_path):
    write(tmp_path / "api/uv.lock", 'version = 1\n[[package]]\nname = "fastapi"\nversion = "0.115.0"\n')
    write(tmp_path / "api/.venv/lib/uv.lock", "version = 1\n")
    write(tmp_path / "web/package-lock.json", json.dumps({"packages": {
        "": {"name": "web"}, "node_modules/react": {"version": "19.3.0", "license": "MIT"},
        "node_modules/a/node_modules/b": {"version": "1.0.0"}}}))
    write(tmp_path / "web/node_modules/x/package-lock.json", "{}")
    inv = discover(tmp_path)
    assert [(p.kind, p.name) for p in inv.package_sets] == [("python", "api"), ("node", "web")]
    assert python_packages(tmp_path / "api/uv.lock") == [("fastapi", "0.115.0")]
    assert node_packages(tmp_path / "web/package-lock.json") == [("b", "1.0.0", ""), ("react", "19.3.0", "MIT")]


def test_dockerfile_stage_alias_is_not_an_image(tmp_path):
    f = write(tmp_path / "Dockerfile", "FROM --platform=linux/amd64 node:22 AS build\nFROM nginx:1.27\nCOPY --from=build /a /b\n")
    assert [str(b) for b in dockerfile_bases(f)] == ["docker.io/library/node:22", "docker.io/library/nginx:1.27"]


def test_manifest_images_tolerates_bad_yaml():
    assert manifest_images("a: [unclosed") == []
