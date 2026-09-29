from compliance import licences, packages
from compliance.discover import discover
from compliance.sbom import NOT_INSTALLED, licence_from_metadata, scan_all
from tests.conftest import TOOLS, sbom


def generated(platform, runner, tmp_path):
    root, _ = platform
    subjects = scan_all(runner, discover(root))
    docs = tmp_path / "docs"
    licences.write(docs, licences.render(subjects, TOOLS))
    return root, docs


def fresh(root, runner):
    return licences.render(scan_all(runner, discover(root)), TOOLS)


def test_tc_d01_01_generate_covers_images_builds_and_package_sets(platform, runner, tmp_path):
    _, docs = generated(platform, runner, tmp_path)
    names = sorted(p.name for p in (docs / "licence-list").glob("*.csv"))
    assert names == ["build-api.csv", "image-docker.io_library_postgres_16-alpine.csv",
                     "image-docker.io_library_python_3.12-slim.csv", "node-web.csv", "python-api.csv"]
    assert licences.read_rows(docs / "licence-list/python-api.csv") == [
        ("colorama", "0.4.6", "python", NOT_INSTALLED), ("fastapi", "0.115.0", "python", "MIT")]
    assert licences.read_rows(docs / "licence-list/node-web.csv") == [("react", "19.3.0", "npm", "MIT")]
    summary = (docs / licences.SUMMARY).read_text(encoding="utf-8")
    assert "docker.io/library/postgres:16-alpine" in summary and "Alpine Linux 3.24.2" in summary
    assert "| GPL-2.0-only | 1 |" in summary
    assert ("build", "api") in runner.calls


def test_tc_d01_01_check_passes_when_nothing_changed(platform, runner, tmp_path):
    root, docs = generated(platform, runner, tmp_path)
    assert licences.compare(docs, fresh(root, runner)) == []


def test_tc_d01_01_extra_component_fails(platform, runner, tmp_path):
    root, docs = generated(platform, runner, tmp_path)
    runner.sboms["docker.io/library/postgres:16-alpine"] = sbom(
        ("musl", "1.2.5", "apk", "MIT"), ("busybox", "1.37", "apk", "GPL-2.0-only"), ("curl", "8.0", "apk", "curl"))
    diffs = [str(d) for d in licences.compare(docs, fresh(root, runner))]
    assert diffs == ["licence-list/image-docker.io_library_postgres_16-alpine.csv：多出元件 curl 8.0"]


def test_tc_d01_01_missing_component_fails(platform, runner, tmp_path):
    root, docs = generated(platform, runner, tmp_path)
    runner.sboms["docker.io/library/postgres:16-alpine"] = sbom(("musl", "1.2.5", "apk", "MIT"))
    assert [d.kind for d in licences.compare(docs, fresh(root, runner))] == ["缺少元件"]


def test_tc_d01_01_version_change_fails(platform, runner, tmp_path):
    root, docs = generated(platform, runner, tmp_path)
    runner.sboms["docker.io/library/postgres:16-alpine"] = sbom(
        ("musl", "1.2.6", "apk", "MIT"), ("busybox", "1.37", "apk", "GPL-2.0-only"))
    diffs = licences.compare(docs, fresh(root, runner))
    assert [d.kind for d in diffs] == ["版本或授權不同"]
    assert "文件 1.2.5［MIT］，實際 1.2.6［MIT］" in diffs[0].detail


def test_tc_d01_01_licence_change_fails(platform, runner, tmp_path):
    root, docs = generated(platform, runner, tmp_path)
    runner.sboms["docker.io/library/postgres:16-alpine"] = sbom(
        ("musl", "1.2.5", "apk", "Apache-2.0"), ("busybox", "1.37", "apk", "GPL-2.0-only"))
    assert [d.kind for d in licences.compare(docs, fresh(root, runner))] == ["版本或授權不同"]


def test_tc_d01_01_new_image_in_an_overlay_fails_until_regenerated(platform, runner, tmp_path):
    root, docs = generated(platform, runner, tmp_path)
    (root / "deploy/local/compose.fhir.yaml").write_text('services:\n  fhir: {image: "hapiproject/hapi:v8"}\n')
    runner.sboms["docker.io/hapiproject/hapi:v8"] = sbom(("hapi", "8", "java-archive", "Apache-2.0"))
    diffs = licences.compare(docs, fresh(root, runner))
    assert [(d.kind, d.subject) for d in diffs] == [("多出對象", "licence-list/image-docker.io_hapiproject_hapi_v8.csv")]


def test_tc_d01_01_removed_image_fails(platform, runner, tmp_path):
    root, docs = generated(platform, runner, tmp_path)
    (root / "deploy/local/compose.yaml").write_text(
        'services:\n  api:\n    build: {context: ../.., dockerfile: api/Dockerfile}\n')
    assert [d.kind for d in licences.compare(docs, fresh(root, runner))] == ["缺少對象"]


def test_tc_d01_01_digest_change_alone_fails(platform, runner, tmp_path):
    root, docs = generated(platform, runner, tmp_path)
    runner.sboms["docker.io/library/postgres:16-alpine"] = sbom(
        ("musl", "1.2.5", "apk", "MIT"), ("busybox", "1.37", "apk", "GPL-2.0-only"), digest="sha256:bbb")
    diffs = licences.compare(docs, fresh(root, runner))
    assert [d.kind for d in diffs] == ["摘要不同"]
    assert "repo_digests：文件 ['x@sha256:aaa']，實際 ['x@sha256:bbb']" in diffs[0].detail


def test_tc_d01_01_hand_edited_summary_fails(platform, runner, tmp_path):
    root, docs = generated(platform, runner, tmp_path)
    path = docs / licences.SUMMARY
    path.write_text(path.read_text(encoding="utf-8").replace("GPL-2.0-only", "MIT"), encoding="utf-8")
    assert [d.kind for d in licences.compare(docs, fresh(root, runner))] == ["摘要不同"]


def test_tc_d01_01_unscannable_image_is_reported_not_dropped(platform, runner, tmp_path):
    root, docs = generated(platform, runner, tmp_path)
    runner.fail.add("docker.io/library/postgres:16-alpine")
    subjects = scan_all(runner, discover(root))
    assert [s.name for s in subjects if s.error] == ["docker.io/library/postgres:16-alpine"]
    assert [d.kind for d in licences.compare(docs, licences.render(subjects, TOOLS))][0] == "缺少對象"


def test_check_without_document_fails(platform, runner, tmp_path):
    root, _ = platform
    diffs = licences.compare(tmp_path / "empty", fresh(root, runner))
    assert {d.kind for d in diffs} == {"多出對象", "缺少對象"}


def test_licence_from_metadata_prefers_expression_then_classifier_then_field():
    assert licence_from_metadata("Name: a\nLicense-Expression: MIT\nLicense: whatever\n") == "MIT"
    assert licence_from_metadata("Name: a\nClassifier: License :: OSI Approved :: BSD License\n") == "BSD License"
    assert licence_from_metadata("Name: a\nLicense: Apache 2.0\n        long text\n") == "Apache 2.0"
    assert licence_from_metadata("Name: a\n") == ""


def test_tc_a01_04_python_package_list_per_image(platform, runner, tmp_path):
    root, _ = platform
    subjects = scan_all(runner, discover(root))
    files = packages.render(subjects)
    assert files == {"python-packages/build-api.txt": "fastapi==0.115.0\n"}
    packages.write(tmp_path, files)
    assert packages.compare(tmp_path, files) == []
    runner.sboms["compliance-scan/api:latest"] = sbom(("fastapi", "0.116.0", "python", "MIT"), ("uvicorn", "0.30", "python", "BSD"))
    diffs = packages.compare(tmp_path, packages.render(scan_all(runner, discover(root))))
    assert diffs == ["python-packages/build-api.txt：實際多出 fastapi==0.116.0",
                     "python-packages/build-api.txt：實際多出 uvicorn==0.30",
                     "python-packages/build-api.txt：實際缺少 fastapi==0.115.0"]


def test_tc_a01_04_missing_confirmed_list_fails(platform, runner, tmp_path):
    root, _ = platform
    files = packages.render(scan_all(runner, discover(root)))
    assert packages.compare(tmp_path, files) == ["python-packages/build-api.txt：映像內有 Python 套件，但沒有已確認清單"]
