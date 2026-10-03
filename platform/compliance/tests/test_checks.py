import base64
import json
from pathlib import Path

from compliance import audit_coverage as audit
from compliance import monitoring_coverage as mon
from compliance import report as rep
from compliance import secrets_scan as sec
from tests.conftest import write


def row(i, cat, **over):
    base = {"id": i, "actor": "admin01", "at": "2026-09-29T00:00:00Z", "category": cat, "action": "x",
            "target": "t", "result": "success", "source_ip": "10.0.0.1"}
    return {**base, **over}


def full_samples():
    return [row(i * 10 + n, c) for i, c in enumerate(audit.CATEGORIES) for n in range(3)]


def test_tc_d01_05_all_eight_categories_with_complete_fields_pass():
    r = audit.evaluate(full_samples(), {c: 5 for c in audit.CATEGORIES})
    assert r.sample_ok and r.daily_ok and r.sampled == 24


def test_tc_d01_05_missing_field_fails():
    samples = full_samples()
    samples[0]["source_ip"] = None
    samples[5]["target"] = "  "
    r = audit.evaluate(samples, {c: 5 for c in audit.CATEGORIES})
    assert not r.sample_ok
    assert r.missing_fields == ["帳號 #0 缺 source_ip", "角色 #12 缺 target"]


def test_tc_daily_01_category_without_producer_fails_honestly():
    samples = [s for s in full_samples() if s["category"] not in ("inference", "data_exchange")]
    counts = {c: 5 for c in audit.CATEGORIES if c not in ("inference", "data_exchange")}
    r = audit.evaluate(samples, counts)
    assert not r.daily_ok and not r.sample_ok
    assert r.counts["inference"] == 0 and r.short == {"inference": 0, "data_exchange": 0}


def test_tc_d01_05_fewer_than_three_rows_fails_and_unknown_category_is_flagged():
    samples = full_samples()[:-1] + [row(999, "mystery")]
    r = audit.evaluate(samples, {**{c: 5 for c in audit.CATEGORIES}, "mystery": 1})
    assert r.short == {"data_exchange": 2} and r.unknown == {"mystery": 1}
    assert not r.sample_ok and not r.daily_ok


POLICY = mon.Policy({"kube-system"}, {"monitoring/mailpit"}, ["kubelet", "cadvisor"])


def targets(*extra):
    base = [mon.Target(job, "up", node=n) for job in ("kubelet", "cadvisor") for n in ("n1", "n2")]
    return base + list(extra)


def test_tc_daily_02_every_workload_covered_passes():
    ws = [mon.Workload("monitoring", "prometheus", ["p-1"]), mon.Workload("monitoring", "mailpit", ["m-1"]),
          mon.Workload("kube-system", "coredns", ["c-1"])]
    r = mon.evaluate(ws, targets(mon.Target("prometheus", "up")), ["n1", "n2"], {"m-1"}, POLICY)
    assert r.ok and r.covered_by_target == ["monitoring/prometheus"] and r.covered_by_container == ["monitoring/mailpit"]
    assert r.total == 2


def test_tc_daily_02_new_service_without_target_fails():
    ws = [mon.Workload("fhir", "hapi-fhir", ["h-1"])]
    r = mon.evaluate(ws, targets(), ["n1", "n2"], {"h-1"}, POLICY)
    assert not r.ok and r.uncovered == ["fhir/hapi-fhir：沒有抓取目標，也不在「只以容器指標覆蓋」政策內"]


def test_tc_daily_02_down_target_missing_container_metrics_and_node_gap_fail():
    ws = [mon.Workload("monitoring", "mailpit", ["m-1"])]
    r = mon.evaluate(ws, targets(mon.Target("grafana", "down", "g:3000", error="refused")), ["n1", "n2", "n3"], set(), POLICY)
    assert r.down == ["grafana g:3000：refused"]
    assert r.uncovered == ["monitoring/mailpit：沒有容器指標（m-1）"]
    assert r.node_gaps == ["節點 n3 沒有 kubelet 抓取目標", "節點 n3 沒有 cadvisor 抓取目標"]


def test_tc_daily_02_discovered_targets_only_cover_their_own_namespace():
    # 平台的抓取目標來自 Pod 探索，帶 namespace；同名服務在別的命名空間不算被覆蓋
    ws = [mon.Workload("ai-platform", "api", ["a-1"]), mon.Workload("other", "api", ["o-1"])]
    r = mon.evaluate(ws, targets(mon.Target("api", "up", "10.0.0.1:8000", namespace="ai-platform")), ["n1", "n2"],
                     {"a-1", "o-1"}, POLICY)
    assert r.covered_by_target == ["ai-platform/api"]
    assert r.uncovered == ["other/api：沒有抓取目標，也不在「只以容器指標覆蓋」政策內"]


def test_tc_daily_02_compose_services_are_reported_uncovered():
    r = mon.evaluate([], targets(), ["n1", "n2"], set(), POLICY, ["api", "postgres"])
    assert not r.ok and len(r.compose_uncovered) == 2


JUNIT = """<testsuites><testsuite name="pytest">
<testcase classname="test_tc_ss" name="test_tc_ss_02_no_token_ten_times"/>
<testcase classname="test_tc_ss" name="test_tc_ss_03_forged"><failure message="got 200">trace</failure></testcase>
<testcase classname="test_tc_b04" name="test_tc_b04_07_stats"><failure message="coef differs"/></testcase>
<testcase classname="tests.test_x" name="test_helper"><failure message="boom"/></testcase>
<testcase classname="test_tc_c01" name="test_tc_c01_05_order"><error message="cluster gone"/></testcase>
<testcase classname="test_tc_c02" name="test_tc_c02_01_targets"><skipped message="kind 叢集不存在"/></testcase>
</testsuite></testsuites>"""


def test_tc_daily_03_report_grades_defects(tmp_path):
    junit = write(tmp_path / "junit.xml", JUNIT)
    checks = write(tmp_path / "checks.log", "PASS  TC-D01-01     ok\nFAIL  TC-D01-05     8 類稽核缺 2 類\nWARN  discover  x\nnoise\n")
    write(tmp_path / "broken.xml", "<not closed")
    r = rep.build([("acceptance", junit), ("broken", tmp_path / "broken.xml")], [checks])
    grades = {c.name.split()[0]: c.grade for c in r.defects}
    assert grades == {"test_tc_ss_03_forged": "阻斷", "test_tc_b04_07_stats": "嚴重", "test_helper": "一般",
                      "test_tc_c01_05_order": "阻斷", "TC-D01-05": "阻斷"}
    assert (r.count("passed"), r.count("skipped")) == (3, 1)
    assert len(r.unreadable) == 1
    out = rep.write(r, tmp_path / "reports/2026-09-29", "測試報告")
    text = out.read_text(encoding="utf-8")
    assert "### 阻斷（3）" in text and "### 嚴重（1）" in text and "### 一般（1）" in text
    assert "kind 叢集不存在" in text and "無法讀取的結果檔" in text
    assert len(json.loads((out.parent / "report.json").read_text())) == 9


def test_tc_id_extraction():
    assert rep.tc_id("test_tc_a02_05_exclusive") == "TC-A02-05"
    assert rep.tc_id("TC-DAILY-01 x") == "TC-DAILY-01"
    assert rep.tc_id("test_helper") is None


def test_tc_ss_04_secret_discovery_from_compose_and_realm(tmp_path):
    write(tmp_path / "deploy/local/compose.yaml", """
services:
  db: {environment: {POSTGRES_PASSWORD: platform-dev, POSTGRES_USER: platform}}
  api: {environment: [S3_SECRET_KEY=minio-dev-secret, KEYCLOAK_CLIENT_SECRET=api-secret-dev, S3_ENDPOINT=minio:9000, SHORT_PASSWORD=abc]}
""")
    write(tmp_path / "deploy/local/compose.extra.yaml", 'services:\n  x: {environment: {TOKEN_FILE: /run/secret, API_TOKEN: "${TOKEN}"}}\n')
    write(tmp_path / "deploy/local/keycloak/realm-x.json", json.dumps({"clients": [{"clientId": "web"}, {"clientId": "api", "secret": "api-secret-dev"}, {"clientId": "cli", "secret": "cli-secret-1"}]}))
    names = [s.name for s in sec.discover_secrets(tmp_path)]
    assert names == ["compose.yaml#api:KEYCLOAK_CLIENT_SECRET", "compose.yaml#api:S3_SECRET_KEY",
                     "compose.yaml#db:POSTGRES_PASSWORD", "realm-x.json:client cli secret"]


def test_tc_ss_04_detects_raw_urlencoded_and_base64_forms(tmp_path):
    secrets = [sec.Secret("db", "platform-dev"), sec.Secret("s3", "minio/dev+secret")]
    assert [l.form for l in sec.scan_text("pw=platform-dev", "a", secrets)] == ["原文"]
    assert [l.form for l in sec.scan_text("k=minio%2Fdev%2Bsecret", "a", secrets)] == ["URL 編碼"]
    assert [l.form for l in sec.scan_text(base64.b64encode(b"platform-dev").decode(), "a", secrets)] == ["base64"]
    assert sec.scan_text("nothing here", "a", secrets) == []
    write(tmp_path / "dist/assets/app.js", "const x='ok';")
    write(tmp_path / "dist/index.html", "<script>var s='platform-dev'</script>")
    files, leaks = sec.scan_dir(tmp_path / "dist", secrets)
    assert files == 2 and [(l.where, l.secret) for l in leaks] == [("index.html", "db")]


def test_tc_d01_06_clamscan_output_parsing_and_probe():
    from compliance import malware
    out = "/scan/_probe/eicar-probe.txt: Eicar-Signature FOUND\n/scan/volumes/v/x.dcm: Win.Test.EICAR_HDB-1 FOUND\n"
    r = malware.evaluate(out, 1, "eicar-probe.txt", 10, ["a"])
    assert r.probe_detected and r.infected == [("/scan/volumes/v/x.dcm", "Win.Test.EICAR_HDB-1")] and not r.ok
    clean = malware.evaluate("/scan/_probe/eicar-probe.txt: Eicar-Signature FOUND\n", 1, "eicar-probe.txt", 10, ["a"])
    assert clean.ok
    blind = malware.evaluate("", 0, "eicar-probe.txt", 10, ["a"])
    assert not blind.ok and not blind.probe_detected       # 掃毒沒攔下測試檔就不能算通過
    broken = malware.evaluate("", 2, "eicar-probe.txt", 10, ["a"])
    assert broken.errors == ["clamscan 結束碼 2"]
