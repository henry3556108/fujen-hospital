from compliance.discover import discover
from compliance.sources import Policy, Running, check_declared, check_running
from compliance.vulns import exceeds, report_md, summarise
from tests.conftest import write

POLICY = Policy(approved=["docker.io/library/*", "quay.io/keycloak/*", "docker.io/kindest/node"],
                bundled_namespaces={"kube-system"})


def inventory(tmp_path, compose):
    write(tmp_path / "compose.yaml", compose)
    write(tmp_path / "api/Dockerfile", "FROM python:3.12-slim\n")
    return discover(tmp_path)


def test_tc_d01_07_unapproved_source_is_flagged(tmp_path):
    inv = inventory(tmp_path, 'services:\n  a: {image: "postgres:16"}\n  b: {image: "evil.example/x/y:1"}\n'
                              '  c: {image: "someone/postgres:16"}\n')
    report = check_declared(inv, POLICY)
    assert [u.split("（")[0] for u in report.unapproved] == ["docker.io/someone/postgres:16", "evil.example/x/y:1"]
    assert not report.ok and report.checked == 4


def test_tc_d01_07_all_approved_passes_and_unpinned_is_warning_only(tmp_path):
    inv = inventory(tmp_path, 'services:\n  a: {image: "postgres:latest"}\n  k: {image: "quay.io/keycloak/keycloak:26.0"}\n')
    report = check_declared(inv, POLICY)
    assert report.ok and report.unapproved == []
    assert [u.split("（")[0] for u in report.unpinned] == ["docker.io/library/postgres:latest"]


def test_tc_d01_07_running_software_outside_the_project_is_flagged(tmp_path):
    inv = inventory(tmp_path, 'services:\n  db: {image: "postgres:16"}\n  api:\n    build: {context: ., dockerfile: api/Dockerfile}\n')
    running = [
        Running("postgres:16", "compose:p/db", compose_service="db"),
        Running("p-api", "compose:p/api", compose_service="api"),                       # 自建映像
        Running("registry.k8s.io/etcd:3.6", "pod:kube-system/etcd", namespace="kube-system"),  # 節點內建
        Running("docker.io/library/postgres:16", "pod:x/db", namespace="x"),            # 同一映像的完整寫法
        Running("postgres:15", "compose:p/old", compose_service="old"),                 # 版本不同
        Running("miner/xmrig:latest", "pod:default/m", namespace="default"),
        Running("anchore/syft@sha256:1", "compose:p/tool", compose_service="tool"),
    ]
    report = check_running(inv, POLICY, running, check_declared(inv, POLICY), tool_images=["anchore/syft@sha256:1"])
    assert report.undeclared == ["miner/xmrig:latest（pod:default/m）", "postgres:15（compose:p/old）"]
    assert not report.ok and report.running_checked == 7


TRIVY = {"Results": [
    {"Target": "os", "Vulnerabilities": [
        {"VulnerabilityID": "CVE-1", "PkgName": "openssl", "InstalledVersion": "3.0", "FixedVersion": "3.1", "Severity": "CRITICAL"},
        {"VulnerabilityID": "CVE-1", "PkgName": "openssl", "InstalledVersion": "3.0", "FixedVersion": "3.1", "Severity": "CRITICAL"},
        {"VulnerabilityID": "CVE-2", "PkgName": "zlib", "InstalledVersion": "1.2", "Severity": "HIGH"},
        {"VulnerabilityID": "CVE-3", "PkgName": "zlib", "InstalledVersion": "1.2", "Severity": "LOW"},
        {"VulnerabilityID": "CVE-4", "PkgName": "x", "InstalledVersion": "1", "Severity": "WEIRD"}]},
    {"Target": "app", "Vulnerabilities": None},
]}


def test_tc_d01_07_vulnerability_summary_counts_unique_findings():
    s = summarise("img", TRIVY)
    assert dict(s.counts) == {"CRITICAL": 1, "HIGH": 1, "LOW": 1, "UNKNOWN": 1}
    assert dict(s.fixable) == {"CRITICAL": 1}
    assert [t["id"] for t in s.top] == ["CVE-1", "CVE-2"]
    assert summarise("clean", {"Results": None}).total == 0


def test_tc_d01_07_fail_on_threshold():
    s = [summarise("img", TRIVY), summarise("clean", {})]
    assert exceeds(s, None) == []
    assert exceeds(s, "CRITICAL") == ["img：CRITICAL 1"]
    assert exceeds(s, "HIGH") == ["img：CRITICAL 1、HIGH 1"]


def test_vulnerability_report_lists_details():
    md = report_md([summarise("img", TRIVY)], {"version": "0.1", "image": "t"}, "2026-09-29")
    assert "| `img` | 1 | 1 | 0 | 1 | 1 | 4 | 1 |" in md
    assert "| HIGH | CVE-2 | zlib | 1.2 | 尚無 |" in md
