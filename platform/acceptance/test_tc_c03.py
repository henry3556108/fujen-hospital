"""C-03 HL7 FHIR 醫療資料交換：經 Gateway 的驗收測試。

需要 compose 堆疊加上 compose.fhir.yaml（HAPI FHIR、排程 worker、Mailpit）與 seed 基線：
    cd platform/deploy/local && docker compose -f compose.yaml -f compose.fhir.yaml up -d --build
    docker compose exec -T api /app/.venv/bin/python -m app.seed
    cd platform/acceptance && COMPOSE_PROJECT=ai-platform uv run pytest test_tc_c03.py

環境變數：GATEWAY_URL、KEYCLOAK_URL（見 conftest）、COMPOSE_PROJECT 或 K8S_NAMESPACE（必填其一，用來載入模擬 HIS 資料庫、查稽核表、
模擬中斷與水平擴充）、MAILPIT_URL（預設 http://127.0.0.1:8025）、SYNTH_DIR（已產生的合成資料）。
FHIR_SKIP_SLOW=1 時略過排程（約 2.5 分鐘）與水平擴充（約 3 分鐘）。
"""
import json
import os
import re
import secrets
import socket
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx
import pytest

import fhir_support as fs
import platform_exec as pe
from conftest import GATEWAY, login

pytestmark = pytest.mark.skipif(not fs.AVAILABLE, reason="設定 COMPOSE_PROJECT 或 K8S_NAMESPACE 才能跑 FHIR 驗收")
SLOW = pytest.mark.skipif(os.environ.get("FHIR_SKIP_SLOW") == "1", reason="FHIR_SKIP_SLOW=1")
REPORTS = Path(__file__).parent / "reports" / datetime.now().strftime("%Y-%m-%d")


# ---------- fixtures ----------

@pytest.fixture(scope="module")
def http():
    with httpx.Client(base_url=GATEWAY, timeout=90) as client:
        yield client


@pytest.fixture(scope="module")
def tokens():
    cache: dict[str, tuple[float, str]] = {}

    def headers(username: str) -> dict:
        issued, token = cache.get(username, (0.0, ""))
        if time.monotonic() - issued > 120:            # token 5 分鐘到期，提早換新
            token = login(username)                     # OAuth2（Keycloak）
            cache[username] = (time.monotonic(), token)
        return {"Authorization": f"Bearer {token}"}
    return headers


@pytest.fixture(scope="module")
def synth_dir(tmp_path_factory) -> Path:
    if os.environ.get("SYNTH_DIR"):
        return Path(os.environ["SYNTH_DIR"])
    out = tmp_path_factory.mktemp("synth")
    fs.synth(out / "clinical", "clinical")
    fs.synth(out / "vitals", "vitals", "--count", "100")
    return out


@pytest.fixture(scope="module")
def tenants(http, tokens):
    """三個專案（＝三個租戶）：a 主要資料、b 別的租戶、c 自訂對應規則。md01 加入 a。測完刪除專案。"""
    admin = tokens("admin01")
    tag = secrets.token_hex(3)
    made = {}
    for key in ("a", "b", "c"):
        response = http.post("/api/admin/projects", headers=admin,
                             json={"name": f"c03-{key}-{tag}", "description": "TC-C03 驗收"})
        assert response.status_code == 201, response.text
        made[key] = response.json()["id"]
    users = {u["username"]: u["id"] for u in http.get("/api/admin/users", headers=admin).json()}
    added = http.put(f"/api/admin/projects/{made['a']}/members/{users['md01']}", headers=admin,
                     json={"role": "medical_doctor"})
    assert added.status_code in (200, 201), added.text

    def ready():
        response = http.get(f"/api/projects/{made['a']}/fhir/summary", headers=tokens("admin01"))
        if response.status_code == 503 and "FHIR_URL" in response.text:
            pytest.skip("堆疊沒有啟用 compose.fhir.yaml")
        return response.status_code == 200
    fs.wait_until(ready, timeout=300, interval=5, what="HAPI FHIR 就緒")
    yield made
    for project_id in made.values():
        http.delete(f"/api/admin/projects/{project_id}", headers=tokens("admin01"))


@pytest.fixture(scope="module")
def his_db(synth_dir):
    fs.psql("his", "DROP TABLE IF EXISTS patients;\n" + (synth_dir / "clinical" / "patients.sql").read_text("utf-8"))
    assert fs.psql("his", "SELECT count(*) FROM patients;").strip() == "20"


def base(project_id: int) -> str:
    return f"/api/projects/{project_id}/fhir"


def fhir(project_id: int) -> str:
    return f"/fhir/projects/{project_id}"


def make_source(http, headers, project_id, name, kind, **extra) -> dict:
    response = http.post(f"{base(project_id)}/sources", headers=headers, json={"name": name, "kind": kind, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def make_mapping(http, headers, project_id, **body) -> dict:
    response = http.post(f"{base(project_id)}/mappings", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def run_etl(http, headers, project_id, source, mapping):
    return http.post(f"{base(project_id)}/runs", headers=headers,
                     json={"source_id": source["id"], "mapping_id": mapping["id"]})


def counts(http, headers, project_id) -> dict:
    response = http.get(f"{base(project_id)}/summary", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["counts"]


def all_resources(http, headers, project_id, resource_type) -> list[dict]:
    """經 Gateway 的 FHIR 搜尋，逐頁取完。"""
    rows, offset = [], 0
    while True:
        response = http.get(f"{fhir(project_id)}/{resource_type}", headers=headers,
                            params={"_count": "100", "_offset": str(offset), "_sort": "_id"})
        assert response.status_code == 200, response.text
        page = [e["resource"] for e in response.json().get("entry", [])
                if e["resource"]["resourceType"] == resource_type]
        rows.extend(page)
        if len(page) < 100:
            return rows
        offset += 100


def by_identifier(rows: list[dict]) -> dict[str, dict]:
    return {r["identifier"][0]["value"]: r for r in rows}


@pytest.fixture(scope="module")
def loaded(http, tokens, tenants, synth_dir, his_db):
    """租戶 a：四種來源各一批，依序寫入；每批寫完就逐欄位比對。回傳執行結果與精確度統計。"""
    admin, pid, clinical = tokens("admin01"), tenants["a"], synth_dir / "clinical"
    accuracy = fs.Accuracy()
    runs = {}

    def run(kind, builtin, **extra):
        source = make_source(http, admin, pid, f"src-{kind}", kind, **extra)
        mapping = make_mapping(http, admin, pid, builtin=builtin)
        response = run_etl(http, admin, pid, source, mapping)
        assert response.status_code == 201, response.text
        runs[kind] = response.json()

    run("sql", "sql-patient", config={"dsn": fs.HIS_DSN, "query": "SELECT * FROM patients ORDER BY patient_id"})
    patients = by_identifier(all_resources(http, admin, pid, "Patient"))
    for row in fs.sql_rows(clinical):
        accuracy.add(fs.expected_sql_patient(row), patients.get(row["patient_id"]))
    refs = {mrn: f"Patient/{p['id']}" for mrn, p in patients.items()}

    run("csv", "csv-encounter", content=(clinical / "encounters.csv").read_text("utf-8"))
    encounters = by_identifier(all_resources(http, admin, pid, "Encounter"))
    for row in fs.csv_rows(clinical):
        accuracy.add(fs.expected_csv_encounter(row, refs.get(row["patient_id"])), encounters.get(row["encounter_id"]))

    run("json", "json-lab-observation", content=(clinical / "labs.json").read_text("utf-8"))
    observations = by_identifier(all_resources(http, admin, pid, "Observation"))
    for row in fs.lab_rows(clinical):
        accuracy.add(fs.expected_lab_observation(row, refs.get(row["patient_id"])), observations.get(row["id"]))
    snapshot = {"Patient": list(patients.values()), "Encounter": list(encounters.values()),
                "Observation": list(observations.values())}

    run("hl7v2", "hl7v2-adt", content=fs.hl7_text(clinical))
    patients = by_identifier(all_resources(http, admin, pid, "Patient"))
    encounters = by_identifier(all_resources(http, admin, pid, "Encounter"))
    for message in fs.hl7_text(clinical).split("MSH|")[1:]:
        mrn = re.search(r"\nPID\|1\|\|([^^|]*)", message).group(1)
        patient, encounter = fs.expected_hl7("MSH|" + message, refs.get(mrn))
        accuracy.add(patient, patients.get(mrn))
        accuracy.add(encounter, encounters.get(encounter["identifier"][0]["value"]))
    return {"runs": runs, "accuracy": accuracy, "snapshot": snapshot, "refs": refs}


# ---------- 案例 ----------

def test_tc_c03_04_four_sources_record_counts_match(http, tokens, tenants, loaded):
    runs = loaded["runs"]
    assert {k: (r["status"], r["records_read"]) for k, r in runs.items()} == {
        "sql": ("succeeded", 20), "csv": ("succeeded", 20), "json": ("succeeded", 20), "hl7v2": ("succeeded", 20)}
    assert [runs[k]["resources_written"] for k in ("sql", "csv", "json", "hl7v2")] == [
        {"Patient": 20}, {"Encounter": 20}, {"Observation": 20}, {"Patient": 20, "Encounter": 20}]
    # HL7 的 20 位病人與 SQL 的是同一批人（同病歷號），不重複建立
    assert counts(http, tokens("admin01"), tenants["a"]) == {"Patient": 20, "Encounter": 40, "Observation": 20}
    summary = loaded["accuracy"].summary()
    assert summary["mismatches"] == 0 and summary["resources"] == 100, summary["examples"]


def test_tc_c03_01_sixty_resources_pass_the_fhir_validator(http, tokens, tenants, loaded):
    admin, failed = tokens("admin01"), []
    for kind in ("Patient", "Encounter", "Observation"):
        rows = loaded["snapshot"][kind]
        assert len(rows) == 20
        for resource in rows:
            response = http.post(f"{fhir(tenants['a'])}/{kind}/$validate", headers=tokens("admin01"), json=resource)
            issues = [i for i in response.json().get("issue", []) if i["severity"] in ("error", "fatal")]
            if response.status_code != 200 or issues:
                failed.append((kind, resource["id"], response.status_code, issues))
    assert failed == []
    bad = http.post(f"{fhir(tenants['a'])}/Patient/$validate", headers=admin,
                    json={"resourceType": "Patient", "gender": "Q"})
    assert bad.status_code >= 400          # 驗證器真的會擋：不是一律放行


def test_tc_c03_02_through_gateway_20_times_and_bypass_10_times(http, tokens, tenants, loaded):
    pid, doctor = tenants["a"], tokens("md01")
    paths = ["/Patient?_count=5&_total=accurate", "/Encounter?_count=5", "/Observation?_count=5", "/metadata"] * 5
    responses = [http.get(fhir(pid) + p, headers=doctor) for p in paths]
    assert [r.status_code for r in responses] == [200] * 20
    body = responses[0].json()
    assert body["resourceType"] == "Bundle" and body["total"] == 20 and len(body["entry"]) == 5
    # 回應內的網址是對外路徑，不洩漏內部位址
    links = [urlparse(link["url"]) for link in body["link"]]
    assert all(u.path == f"/fhir/projects/{pid}" or u.path.startswith(f"/fhir/projects/{pid}/") for u in links), links
    assert all(u.netloc == urlparse(GATEWAY).netloc for u in links), links
    assert "hapi:8080" not in responses[0].text

    def fhir_success(response: httpx.Response) -> bool:
        try:
            return response.status_code < 400 and "resourceType" in response.json()
        except ValueError:
            return False

    attempts = []
    # 1–3：HAPI 沒有對主機開放的連接埠
    if fs.K8S_NAMESPACE:   # Kubernetes：選到 HAPI 的 Service 都不是 NodePort／LoadBalancer
        services = json.loads(pe.kubectl("get", "service", "-o", "json").stdout)["items"]
        published = [s["metadata"]["name"] for s in services if (s["spec"].get("selector") or {}).get("app") == "hapi"
                     and s["spec"].get("type") in ("NodePort", "LoadBalancer")]
    else:
        ports = fs.compose("ps", "--format", "json", "hapi").stdout
        published = [p for line in ports.splitlines() if line.strip()
                     for p in json.loads(line).get("Publishers") or [] if p.get("PublishedPort")]
    assert published == []
    for url in (f"http://127.0.0.1:8080/fhir/{pid}/Patient", f"http://localhost:8080/fhir/DEFAULT/metadata",
                f"http://127.0.0.1:8888/fhir/{pid}/Patient"):
        try:
            attempts.append(fhir_success(httpx.get(url, timeout=3)))
        except httpx.TransportError:
            attempts.append(False)
    # 4–6：從另一個 Docker 網路（Kubernetes：另一個命名空間）直接連 HAPI 的位址（模擬網路上的其他主機）
    if fs.K8S_NAMESPACE:
        address = pe.pod_addresses("hapi")[0]
        # 對照組：平台後端（NetworkPolicy 允許的用戶端）連得到，代表位址沒錯
        inside = pe.fetch_from_namespace(fs.K8S_NAMESPACE, f"http://{address}:8080/fhir/DEFAULT/metadata",
                                         timeout=20, labels={"platform/backend": "true"})
        outside = lambda url: pe.fetch_from_namespace("default", url, timeout=3)  # noqa: E731
    else:
        address = fs.container_address(fs.container_ids("hapi")[0])
        inside = fs.fetch_from_network(f"{fs.COMPOSE_PROJECT}_default", f"http://{address}:8080/fhir/DEFAULT/metadata")
        outside = lambda url: fs.fetch_from_network("bridge", url, timeout=3)  # noqa: E731
    assert "CapabilityStatement" in inside.stdout
    for path in (f"/fhir/{pid}/Patient", "/fhir/DEFAULT/metadata", f"/fhir/{pid}/Observation"):
        probe = outside(f"http://{address}:8080{path}")
        attempts.append(probe.returncode == 0 and "resourceType" in probe.stdout)
    # 7–10：經 Gateway 但不帶 token、帶錯的 token、或用 HAPI 的內部路徑
    attempts.append(fhir_success(http.get(f"{fhir(pid)}/Patient")))
    attempts.append(fhir_success(http.get(f"{fhir(pid)}/Patient", headers={"Authorization": "Bearer not-a-token"})))
    attempts.append(fhir_success(http.get(f"/fhir/{pid}/Patient", headers=doctor)))
    attempts.append(fhir_success(http.get("/fhir/DEFAULT/metadata", headers=tokens("admin01"))))
    assert len(attempts) == 10 and attempts == [False] * 10


def test_tc_ss_05_hapi_is_not_reachable_from_the_host():
    for _ in range(10):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(2)
            reachable = sock.connect_ex(("127.0.0.1", 8080)) == 0
        if reachable:    # 8080 被別的服務（例如共用環境的 Keycloak）用掉時，確認它不是 FHIR
            response = httpx.get("http://127.0.0.1:8080/fhir/DEFAULT/metadata", timeout=3)
            assert "CapabilityStatement" not in response.text


def test_tc_c03_05_three_mapping_rule_sets_convert_as_expected(http, tokens, tenants, his_db):
    admin, pid = tokens("admin01"), tenants["c"]
    patient_ref = f"Patient?identifier={fs.MRN}|{{patient_id}}"
    rule_sets = [
        ("patient-name-text", "sql",
         {"resources": [{"resourceType": "Patient", "key": {"system": fs.MRN, "from": "patient_id"}, "fields": [
             {"path": "name[0].text", "template": "{family_name} {given_name}"},
             {"path": "gender", "from": "sex", "map": {"M": "male", "F": "female"}},
             {"path": "birthDate", "from": "birth_date", "transform": "date"},
             {"path": "active", "const": True}]}]},
         {"config": {"dsn": fs.HIS_DSN,
                     "query": "SELECT * FROM patients WHERE patient_id IN ('SYN-42-0001', 'SYN-42-0002')"}},
         lambda refs: [{"resourceType": "Patient", "identifier": [{"system": fs.MRN, "value": r["patient_id"]}],
                        "name": [{"text": f"{r['family_name']} {r['given_name']}"}],
                        "gender": {"M": "male", "F": "female"}[r["sex"]], "birthDate": r["birth_date"],
                        "active": True} for r in ROWS["sql"]]),
        ("encounter-lowercase-class", "csv",
         {"resources": [{"resourceType": "Encounter",
                         "key": {"system": "urn:ai-platform:encounter", "template": "E-{encounter_id}"}, "fields": [
                             {"path": "status", "const": "finished"},
                             {"path": "class.system", "const": "urn:example:class"},
                             {"path": "class.code", "from": "class", "transform": "lower"},
                             {"path": "subject.reference", "template": patient_ref},
                             {"path": "period.start", "from": "start", "transform": "datetime"}]}]},
         {"content": "encounter_id,patient_id,class,start\nENC0001,SYN-42-0001,IMP,2024-09-12T11:08:00+08:00\n"
                     "ENC0002,SYN-42-0002,AMB,2024-01-05T10:32:00+08:00\n"},
         lambda refs: [{"resourceType": "Encounter",
                        "identifier": [{"system": "urn:ai-platform:encounter", "value": f"E-{eid}"}],
                        "status": "finished", "class": {"system": "urn:example:class", "code": code},
                        "subject": {"reference": refs[mrn]}, "period": {"start": start}}
                       for eid, mrn, code, start in [
                           ("ENC0001", "SYN-42-0001", "imp", "2024-09-12T11:08:00+08:00"),
                           ("ENC0002", "SYN-42-0002", "amb", "2024-01-05T10:32:00+08:00")]]),
        ("lab-as-text", "json",
         {"resources": [{"resourceType": "Observation", "key": {"system": "urn:ai-platform:lab", "from": "id"},
                         "fields": [{"path": "status", "const": "final"},
                                    {"path": "code.coding[0].system", "const": fs.LOINC},
                                    {"path": "code.coding[0].code", "from": "loinc"},
                                    {"path": "subject.reference", "template": patient_ref},
                                    {"path": "effectiveDateTime", "from": "effective", "transform": "datetime"},
                                    {"path": "valueString", "template": "{value} {unit}"}]}]},
         {"content": json.dumps([{"id": "LAB0001", "patient_id": "SYN-42-0001", "loinc": "2345-7", "value": 101.8,
                                  "unit": "mg/dL", "effective": "2024-09-12T13:08:00+08:00"}])},
         lambda refs: [{"resourceType": "Observation",
                        "identifier": [{"system": "urn:ai-platform:lab", "value": "LAB0001"}], "status": "final",
                        "code": {"coding": [{"system": fs.LOINC, "code": "2345-7"}]},
                        "subject": {"reference": refs["SYN-42-0001"]},
                        "effectiveDateTime": "2024-09-12T13:08:00+08:00", "valueString": "101.8 mg/dL"}]),
    ]
    ROWS = {"sql": [json.loads(line) for line in fs.psql(
        "his", "SELECT row_to_json(p) FROM patients p WHERE patient_id IN ('SYN-42-0001', 'SYN-42-0002') "
               "ORDER BY patient_id;").splitlines() if line.strip()]}
    accuracy, refs = fs.Accuracy(), {}
    for name, kind, rules, source_extra, expected in rule_sets:
        mapping = make_mapping(http, admin, pid, name=name, source_kind=kind, rules=rules)
        assert http.get(f"{base(pid)}/mappings/{mapping['id']}", headers=admin).json()["rules"] == rules
        source = make_source(http, admin, pid, f"src-{name}", kind, **source_extra)
        response = run_etl(http, admin, pid, source, mapping)
        assert response.status_code == 201, response.text
        stored = by_identifier(all_resources(http, admin, pid, rules["resources"][0]["resourceType"]))
        if kind == "sql":
            refs = {mrn: f"Patient/{p['id']}" for mrn, p in stored.items()}
        for resource in expected(refs):
            accuracy.add(resource, stored.get(resource["identifier"][0]["value"]))
    summary = accuracy.summary()
    assert summary["resources"] == 5 and summary["mismatches"] == 0, summary["examples"]
    assert len(http.get(f"{base(pid)}/mappings", headers=admin).json()) == 3


def test_tc_c03_08_oauth2_identity_and_other_tenant_is_denied(http, tokens, tenants, loaded):
    a, b, c = tenants["a"], tenants["b"], tenants["c"]
    doctor, outsider = tokens("md01"), tokens("user01")      # token 由 Keycloak 以 OAuth2 核發
    assert http.get(f"{fhir(a)}/Patient?_count=1", headers=doctor).status_code == 200
    attempts = [http.get(f"{fhir(b)}/Patient", headers=doctor),
                http.get(f"{fhir(c)}/Patient", headers=doctor),
                http.get(f"{fhir(c)}/Observation?_count=5", headers=doctor),
                http.post(f"{fhir(c)}/Patient/_search", headers=doctor, data={"_count": "5"}),
                http.get(f"{base(c)}/resources/Patient", headers=doctor),
                http.get(f"{base(c)}/graph", headers=doctor, params={"patient": "SYN-42-0001"}),
                http.get(f"{base(b)}/summary", headers=doctor),
                http.get(f"{fhir(a)}/Patient", headers=outsider),
                http.get(f"{base(a)}/resources/Patient", headers=outsider),
                http.get(f"{base(a)}/sources", headers=outsider)]
    assert [r.status_code for r in attempts] == [403] * 10
    assert all("SYN-42" not in r.text for r in attempts)
    # 資料真的分開存：租戶 a 有 20 位病人，租戶 c 只有 2 位，租戶 b 沒有
    admin = tokens("admin01")
    assert [counts(http, admin, t)["Patient"] for t in (a, b, c)] == [20, 0, 2]
    # 用租戶 a 的資源編號到別的租戶讀不到
    some_id = loaded["refs"]["SYN-42-0005"].split("/")[1]
    assert http.get(f"{fhir(a)}/Patient/{some_id}", headers=admin).status_code == 200
    assert http.get(f"{fhir(b)}/Patient/{some_id}", headers=admin).status_code in (404, 410)
    # 非 Admin 不能寫
    assert http.post(f"{fhir(a)}/Patient", headers=doctor,
                     json={"resourceType": "Patient", "gender": "male"}).status_code == 403


def test_tc_c03_13_invalid_hl7_is_rejected_with_reason_and_nothing_written(http, tokens, tenants, loaded,
                                                                          synth_dir):
    admin, pid = tokens("admin01"), tenants["a"]
    before = counts(http, admin, pid)
    manifest = json.loads((synth_dir / "clinical" / "manifest.json").read_text("utf-8"))
    expected = {"invalid/adt_a01_missing_pid3.hl7": "PID-3", "invalid/adt_a01_bad_sex_code.hl7": "PID-8"}
    assert {i["file"] for i in manifest["invalid"]} == set(expected)
    for name, field in expected.items():
        raw = (synth_dir / "clinical" / name).read_bytes()
        response = http.post(f"{base(pid)}/hl7v2", headers={**admin, "Content-Type": "text/plain"}, content=raw)
        assert response.status_code == 422, response.text
        run = response.json()["detail"]["run"]
        assert run["status"] == "rejected" and field in run["errors"][0]["reasons"][0]
        recorded = http.get(f"{base(pid)}/runs/{run['id']}", headers=admin).json()
        assert recorded["errors"] == run["errors"] and recorded["resources_written"] == {}
    # 經 Gateway 直接送不合格的 FHIR 資源（錯誤代碼、缺必填）也被 FHIR 伺服器拒絕
    for bad in ({"resourceType": "Patient", "gender": "Q"}, {"resourceType": "Observation", "code": {"text": "x"}}):
        assert http.post(f"{fhir(pid)}/{bad['resourceType']}", headers=admin, json=bad).status_code in (400, 422)
    # 整批來源裡混入不合格訊息：整批不寫
    mixed = fs.hl7_text(synth_dir / "clinical") + "\n" + raw.decode("ascii").replace("\r", "\n")
    source = make_source(http, admin, pid, "adt-mixed", "hl7v2", content=mixed)
    mapping = http.get(f"{base(pid)}/mappings", headers=admin).json()
    adt = next(m for m in mapping if m["name"] == "hl7v2-adt")
    rejected = run_etl(http, admin, pid, source, adt)
    assert rejected.status_code == 422
    assert [e["control_id"] for e in rejected.json()["detail"]["run"]["errors"]] == ["MSG42-INV2"]   # 最後一則是壞的
    assert counts(http, admin, pid) == before


def test_tc_c03_12_hundred_monitor_readings(http, tokens, tenants, loaded, synth_dir):
    admin, pid = tokens("admin01"), tenants["a"]
    readings = fs.vitals_rows(synth_dir / "vitals")
    assert len(readings) == 100
    before = counts(http, admin, pid)["Observation"]
    written = 0
    for reading in readings:                                   # 即時：一筆讀數一次請求
        response = http.post(f"{base(pid)}/vitals", headers=tokens("admin01"), json=reading)
        written += response.status_code == 201 and response.json()["resources_written"] == {"Observation": 3}
    assert written == 100
    assert counts(http, admin, pid)["Observation"] == before + 300
    stored = by_identifier(all_resources(http, tokens("admin01"), pid, "Observation"))
    accuracy = fs.Accuracy()
    for reading in readings:
        for metric in fs.VITALS:
            expected = fs.expected_vital(reading, metric, loaded["refs"][reading["patient_id"]])
            accuracy.add(expected, stored.get(expected["identifier"][0]["value"]))
    summary = accuracy.summary()
    assert summary["resources"] == 300 and summary["mismatches"] == 0, summary["examples"]
    loaded["accuracy"].resources += accuracy.resources
    loaded["accuracy"].fields += accuracy.fields


def test_tc_c03_09_twenty_audit_rows_are_complete(http, tokens, tenants, loaded):
    pid = tenants["a"]
    rows = [json.loads(line) for line in fs.psql(
        "platform", "SELECT row_to_json(a) FROM audit_log a WHERE category = 'data_exchange' "
                    f"AND target LIKE 'project:{pid}/%' ORDER BY random() LIMIT 20;").splitlines() if line.strip()]
    assert len(rows) == 20
    for row in rows:
        missing = [k for k in ("actor", "at", "category", "action", "target", "result", "source_ip") if not row.get(k)]
        assert missing == [], row
    actions = {line.strip() for line in fs.psql(
        "platform", "SELECT DISTINCT action FROM audit_log WHERE category = 'data_exchange' "
                    f"AND target LIKE 'project:{pid}/%';").splitlines() if line.strip()}
    assert {"fhir.source.create", "fhir.mapping.create", "fhir.etl.run", "fhir.hl7v2.receive",
            "fhir.vitals.receive", "fhir.gateway.access"} <= actions
    results = {line.strip() for line in fs.psql(
        "platform", "SELECT DISTINCT action || ':' || result FROM audit_log WHERE category = 'data_exchange';"
    ).splitlines()}
    assert {"fhir.hl7v2.receive:rejected", "fhir.gateway.access:denied", "fhir.gateway.access:success"} <= results


def test_tc_c03_03_route_change_takes_effect_at_the_gateway(http, tokens, tenants, loaded):
    admin, pid = tokens("admin01"), tenants["a"]
    routes = http.get("/api/admin/gateway/routes", headers=admin).json()
    assert {"fhir-rest", "/api/*", "/dicomweb/projects/*"} <= {r["id"] for r in routes}
    original = next(r for r in routes if r["id"] == "fhir-rest")
    assert original["managed"] and original["enabled"]
    assert "Basic " not in json.dumps(routes)                     # 不洩漏 Gateway 連上游的認證
    try:
        assert http.get(f"{fhir(pid)}/Patient?_count=1", headers=admin).status_code == 200
        changed = http.patch("/api/admin/gateway/routes/fhir-rest", headers=admin, json={"enabled": False})
        assert changed.status_code == 200 and changed.json()["enabled"] is False
        blocked = http.get(f"{fhir(pid)}/Patient?_count=1", headers=admin)
        assert blocked.status_code == 403
        assert next(r for r in http.get("/api/admin/gateway/routes", headers=admin).json()
                    if r["id"] == "fhir-rest")["enabled"] is False
        http.patch("/api/admin/gateway/routes/fhir-rest", headers=admin,
                   json={"enabled": True, "methods": ["GET", "HEAD"]})
        assert http.get(f"{fhir(pid)}/Patient?_count=1", headers=admin).status_code == 200
        assert http.post(f"{fhir(pid)}/Patient/_search", headers=admin, data={"_count": "1"}).status_code == 403
    finally:
        restored = http.patch("/api/admin/gateway/routes/fhir-rest", headers=tokens("admin01"),
                              json={"enabled": True, "methods": original["methods"]})
        assert restored.status_code == 200
    assert http.post(f"{fhir(pid)}/Patient/_search", headers=admin, data={"_count": "1"}).status_code == 200


def test_tc_c03_10_abnormal_traffic_sends_an_alert(http, tokens, tenants, loaded):
    admin, pid = tokens("admin01"), tenants["a"]
    original = next(r for r in http.get("/api/admin/gateway/routes", headers=admin).json()
                    if r["id"] == "fhir-rest")["alert_threshold_per_minute"]
    httpx.delete(f"{fs.MAILPIT}/api/v1/messages", timeout=10)
    try:
        http.patch("/api/admin/gateway/routes/fhir-rest", headers=admin, json={"alert_threshold_per_minute": 40})
        doctor = tokens("md01")
        statuses = [http.get(f"{fhir(pid)}/Patient?_count=1", headers=doctor).status_code for _ in range(90)]
        assert statuses == [200] * 90                           # 告警不阻擋存取
    finally:
        http.patch("/api/admin/gateway/routes/fhir-rest", headers=tokens("admin01"),
                   json={"alert_threshold_per_minute": original})

    def delivered():
        messages = httpx.get(f"{fs.MAILPIT}/api/v1/messages", timeout=10).json()["messages"]
        return [m for m in messages if "流量異常" in m["Subject"] and "md01" in m["Subject"]]
    mails = fs.wait_until(delivered, timeout=30, what="Mailpit 收到流量告警")
    alerts = [a for a in http.get(f"{base(pid)}/alerts", headers=admin).json() if a["actor"] == "md01"]
    assert 1 <= len(alerts) <= 2 and len(mails) == len(alerts)    # 每分鐘一封；跨分鐘邊界時最多兩封
    assert all(a["notified"] and a["threshold"] == 40 and a["request_count"] > 40 for a in alerts)
    assert mails[0]["To"][0]["Address"] == "ops@ai-platform.test"


def test_tc_c03_10_graph_matches_the_data(http, tokens, tenants, loaded):
    pid, doctor = tenants["a"], tokens("md01")
    graph = http.get(f"{base(pid)}/graph", headers=doctor, params={"patient": "SYN-42-0002"}).json()
    ref = loaded["refs"]["SYN-42-0002"]
    related = []
    for kind in ("Encounter", "Observation"):
        bundle = http.get(f"{fhir(pid)}/{kind}", headers=doctor, params={"subject": ref, "_count": "200"}).json()
        related += [f"{kind}/{e['resource']['id']}" for e in bundle.get("entry", [])]
    assert len(related) == 3                                   # CSV 就診、HL7 就診、檢驗
    assert {n["id"] for n in graph["nodes"]} == {ref, *related}
    assert sorted((e["from"], e["to"]) for e in graph["edges"]) == sorted((r, ref) for r in related)
    assert graph["truncated"] is False


def test_tc_c03_07_three_interruptions_are_all_or_nothing(http, tokens, tenants, loaded):
    admin, pid = tokens("admin01"), tenants["b"]
    # 租戶 b 先放一位病人當參照對象
    # 條件式寫入帶租戶標籤（見 app/fhir/etl.py 的 build_bundle）
    tag, tag_query = {"system": "urn:ai-platform:tenant", "code": str(pid)}, f"&_tag=urn:ai-platform:tenant|{pid}"
    seed = {"resourceType": "Bundle", "type": "transaction", "entry": [{
        "fullUrl": f"urn:uuid:{uuid.uuid4()}",
        "resource": {"resourceType": "Patient", "identifier": [{"system": fs.MRN, "value": "ATOMIC-P"}],
                     "gender": "unknown", "meta": {"tag": [tag]}},
        "request": {"method": "PUT", "url": f"Patient?identifier={fs.MRN}|ATOMIC-P{tag_query}"}}]}
    assert http.post(fhir(pid), headers=admin, json=seed).status_code == 200

    def bundle(label: str, size: int, broken_at: int | None = None) -> dict:
        entries = []
        for i in range(size):
            subject = "NOBODY" if i == broken_at else "ATOMIC-P"
            entries.append({
                "fullUrl": f"urn:uuid:{uuid.uuid4()}",
                "resource": {"resourceType": "Observation", "meta": {"tag": [tag]},
                             "identifier": [{"system": "urn:ai-platform:atomic", "value": f"{label}-{i:04d}"}],
                             "status": "final", "code": {"coding": [{"system": fs.LOINC, "code": "8867-4"}]},
                             "subject": {"reference": f"Patient?identifier={fs.MRN}|{subject}{tag_query}"},
                             "effectiveDateTime": "2024-06-01T10:00:00+08:00",
                             "valueQuantity": {"value": 60 + i % 40, "unit": "/min", "system": fs.UCUM,
                                               "code": "/min"}},
                "request": {"method": "PUT", "url": f"Observation?identifier=urn:ai-platform:atomic|{label}-{i:04d}"
                                                                 f"{tag_query}"}})
        return {"resourceType": "Bundle", "type": "transaction", "entry": entries}

    def stable_count() -> int:
        seen = []
        def settled():
            seen.append(counts(http, tokens("admin01"), pid)["Observation"])
            return len(seen) >= 3 and seen[-1] == seen[-2] == seen[-3]
        fs.wait_until(settled, timeout=240, interval=3, what="Observation 筆數不再變動")
        return seen[-1]

    outcomes = []
    # 第 1 次：整批 40 筆，第 21 筆的參照對不到 → 前 20 筆也不能留下
    before = stable_count()
    response = http.post(fhir(pid), headers=admin, json=bundle("bad", 40, broken_at=20))
    assert response.status_code >= 400
    outcomes.append(("壞資料在中間", stable_count() - before, 40))

    # 第 2 次：送到一半就斷線（Content-Length 宣告完整長度，只送出一半內容）
    before = stable_count()
    payload = json.dumps(bundle("cut", 40)).encode()
    target = urlparse(GATEWAY)
    with socket.create_connection((target.hostname, target.port or 80), timeout=10) as sock:
        head = (f"POST {fhir(pid)} HTTP/1.1\r\nHost: {target.netloc}\r\nContent-Type: application/fhir+json\r\n"
                f"Authorization: {tokens('admin01')['Authorization']}\r\nContent-Length: {len(payload)}\r\n\r\n")
        sock.sendall(head.encode() + payload[: len(payload) // 2])
        time.sleep(1)
    outcomes.append(("上傳途中斷線", stable_count() - before, 40))

    # 第 3 次：寫入進行中把 FHIR 伺服器強制關掉，再重新啟動
    before = stable_count()
    big = bundle("kill", 1500)
    started = time.monotonic()
    try:
        with httpx.Client(base_url=GATEWAY, timeout=httpx.Timeout(10, read=1.5)) as impatient:
            impatient.post(fhir(pid), headers=tokens("admin01"), json=big)
        finished_early = True
    except httpx.TransportError:
        finished_early = False
    pe.kill("hapi")
    killed_after = time.monotonic() - started
    if not fs.K8S_NAMESPACE:   # Kubernetes 由 Deployment 自動重建 Pod
        fs.compose("up", "-d", "--no-deps", "--no-recreate", "hapi")
    fs.wait_until(lambda: http.get(f"{fhir(pid)}/metadata", headers=tokens("admin01")).status_code == 200,
                  timeout=300, interval=5, what="HAPI 重新啟動")
    outcomes.append((f"寫入中強制關閉（送出後 {killed_after:.1f} 秒，寫入{'已' if finished_early else '未'}完成）",
                     stable_count() - before, 1500))

    for name, delta, size in outcomes:
        assert delta in (0, size), f"{name}：寫入 {delta} 筆，不是 0 也不是 {size}"
    assert outcomes[0][1] == 0 and outcomes[1][1] == 0
    out = REPORTS / "TC-C03-07"
    out.mkdir(parents=True, exist_ok=True)
    (out / "result.json").write_text(json.dumps(
        [{"case": n, "written": d, "batch_size": s} for n, d, s in outcomes], ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")


@SLOW
def test_tc_c03_06_three_schedules_run_on_time(http, tokens, tenants, loaded):
    admin, pid = tokens("admin01"), tenants["a"]
    sources = {s["name"]: s for s in http.get(f"{base(pid)}/sources", headers=admin).json()}
    mappings = {m["name"]: m for m in http.get(f"{base(pid)}/mappings", headers=admin).json()}
    pairs = [("src-sql", "sql-patient"), ("src-csv", "csv-encounter"), ("src-json", "json-lab-observation")]
    created = []
    for index, (source, mapping) in enumerate(pairs):
        response = http.post(f"{base(pid)}/schedules", headers=admin, json={
            "name": f"every-minute-{index}", "source_id": sources[source]["id"],
            "mapping_id": mappings[mapping]["id"], "interval_minutes": 1})
        assert response.status_code == 201, response.text
        created.append(response.json())
    try:
        def two_runs_each():
            runs = [http.get(f"{base(pid)}/runs", headers=tokens("admin01"),
                             params={"schedule_id": s["id"]}).json() for s in created]
            return runs if all(len(r) >= 2 for r in runs) else None
        runs = fs.wait_until(two_runs_each, timeout=200, interval=5, what="3 條排程各執行 2 次")
    finally:
        for schedule in created:
            http.delete(f"{base(pid)}/schedules/{schedule['id']}", headers=tokens("admin01"))
    report = []
    for schedule, history in zip(created, runs):
        first_planned = datetime.fromisoformat(schedule["next_run_at"])
        planned = sorted(datetime.fromisoformat(r["planned_at"]) for r in history)
        assert planned[0] == first_planned and (planned[1] - planned[0]).total_seconds() == 60
        for run in history:
            assert run["trigger"] == "schedule" and run["status"] == "succeeded", run
            assert 0 <= run["deviation_seconds"] < 300, run
            report.append({"schedule": schedule["name"], "planned_at": run["planned_at"],
                           "started_at": run["started_at"], "deviation_seconds": run["deviation_seconds"]})
    out = REPORTS / "TC-C03-06"
    out.mkdir(parents=True, exist_ok=True)
    (out / "result.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    assert counts(http, admin, pid)["Patient"] == 20             # 重跑不產生重複資料


@SLOW
def test_tc_c03_11_scale_to_two_replicas_and_load_test(http, tokens, tenants, loaded):
    from scripts import fhir_loadtest
    admin, pid = tokens("admin01"), tenants["a"]
    if fs.K8S_NAMESPACE:   # Kubernetes：Deployment 擴成 2 份，等兩份都 Ready（readinessProbe 打 /fhir/DEFAULT/metadata）
        pe.start("hapi", replicas=2)
    else:
        fs.compose("up", "-d", "--no-deps", "--no-recreate", "--scale", "hapi=2", "hapi", timeout=600)
    try:
        if fs.K8S_NAMESPACE:
            addresses = pe.pod_addresses("hapi")
            assert len(addresses) == 2
        else:
            containers = fs.container_ids("hapi")
            assert len(containers) == 2
            addresses = [fs.container_address(c) for c in containers]

            def both_ready():
                return all("CapabilityStatement" in fs.fetch_from_network(
                    f"{fs.COMPOSE_PROJECT}_default", f"http://{a}:8080/fhir/DEFAULT/metadata").stdout
                    for a in addresses)
            fs.wait_until(both_ready, timeout=420, interval=10, what="兩份 HAPI 都就緒")
        time.sleep(35)                                           # 等 Gateway 的 DNS 服務發現更新節點清單
        mark = datetime.now().astimezone().isoformat(timespec="seconds")
        load = fhir_loadtest.run(GATEWAY, login("admin01"), pid, requests=400, concurrency=8)
        logs = pe.logs_since("apisix", mark) if fs.K8S_NAMESPACE else subprocess.run(
            ["docker", "logs", "--since", mark, fs.container_ids("apisix")[0]], capture_output=True, text=True).stdout
        replicas = {a: len(re.findall(rf'"GET /fhir/projects/{pid}/[^"]*" 200 .*{re.escape(a)}:8080', logs))
                    for a in addresses}
    finally:
        if fs.K8S_NAMESPACE:
            pe.start("hapi", replicas=1)
        else:
            fs.compose("up", "-d", "--no-deps", "--no-recreate", "--scale", "hapi=1", "hapi", timeout=300)
    report = fhir_loadtest.write_report(REPORTS / "TC-C03-11", load, accuracy=loaded["accuracy"].summary(),
                                        replicas=replicas)
    assert report.is_file() and (report.parent / "report.json").is_file()
    assert load["failed"] == 0 and load["availability"] == 1.0, load["failures"]
    assert all(count > 0 for count in replicas.values()), replicas      # 兩份都有接到請求
    assert loaded["accuracy"].summary()["mismatches"] == 0
    fs.wait_until(lambda: http.get(f"{fhir(pid)}/metadata", headers=tokens("admin01")).status_code == 200,
                  timeout=120, interval=5, what="縮回 1 份後恢復服務")
