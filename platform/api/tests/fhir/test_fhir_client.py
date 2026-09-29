import json

import httpx
import pytest

from app.fhir.client import FhirError, FhirUnavailable, HttpFhir, InMemoryFhir, fhir_from_env

MRN = "urn:ai-platform:mrn"


def patient(mrn, family="TSAI"):
    return {"resourceType": "Patient", "identifier": [{"system": MRN, "value": mrn}], "name": [{"family": family}],
            "gender": "male"}


def encounter(number, mrn):
    return {"resourceType": "Encounter", "identifier": [{"system": "urn:ai-platform:encounter", "value": number}],
            "status": "finished", "class": {"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
                                            "code": "IMP"},
            "subject": {"reference": f"Patient?identifier={MRN}|{mrn}"}}


def bundle(*resources):
    return {"resourceType": "Bundle", "type": "transaction", "entry": [
        {"resource": r, "request": {"method": "PUT", "url": (
            f"{r['resourceType']}?identifier={r['identifier'][0]['system']}|{r['identifier'][0]['value']}")}}
        for r in resources]}


@pytest.fixture
def fhir():
    f = InMemoryFhir()
    f.ensure_tenant(1)
    f.ensure_tenant(2)
    return f


def test_conditional_upsert_is_idempotent(fhir):
    first = fhir.transaction(1, bundle(patient("A"), patient("B")))
    assert [r["status"] for r in first] == ["201 Created", "201 Created"]
    again = fhir.transaction(1, bundle(patient("A", family="LIN")))
    assert again[0]["status"] == "200 OK" and again[0]["location"].endswith("/_history/2")
    assert fhir.count(1, "Patient") == 2
    assert fhir.search(1, "Patient", {"identifier": f"{MRN}|A"})[1][0]["name"] == [{"family": "LIN"}]


def test_conditional_reference_resolves_within_the_same_transaction(fhir):
    fhir.transaction(1, bundle(encounter("E1", "A"), patient("A")))
    [enc] = fhir.all(1, "Encounter")
    [pat] = fhir.all(1, "Patient")
    assert enc["subject"]["reference"] == f"Patient/{pat['id']}"
    total, rows = fhir.search(1, "Encounter", {"subject": f"Patient/{pat['id']}"})
    assert total == 1 and rows[0]["id"] == enc["id"]


def test_tc_c03_08_tenants_are_isolated(fhir):
    fhir.transaction(1, bundle(patient("A")))
    assert fhir.count(1, "Patient") == 1 and fhir.count(2, "Patient") == 0
    assert fhir.search(2, "Patient", {"identifier": f"{MRN}|A"}) == (0, [])
    with pytest.raises(FhirError) as exc:   # 參照不能跨租戶
        fhir.transaction(2, bundle(encounter("E1", "A")))
    assert exc.value.status == 404 and fhir.count(2, "Encounter") == 0
    with pytest.raises(FhirError):
        fhir.count(9, "Patient")


@pytest.mark.parametrize("cut", [0, 1, 2])
def test_tc_c03_07_interrupted_transaction_writes_nothing(fhir, cut):
    fhir.transaction(1, bundle(patient("A")))
    fhir.fail_after_entries = cut
    with pytest.raises(FhirUnavailable):
        fhir.transaction(1, bundle(patient("A", family="CHANGED"), patient("B"), encounter("E1", "B")))
    assert fhir.count(1, "Patient") == 1 and fhir.count(1, "Encounter") == 0
    assert fhir.all(1, "Patient")[0]["name"] == [{"family": "TSAI"}]
    fhir.transaction(1, bundle(patient("A", family="CHANGED"), patient("B"), encounter("E1", "B")))
    assert fhir.count(1, "Patient") == 2 and fhir.count(1, "Encounter") == 1


def test_tc_c03_07_invalid_entry_rolls_back_the_whole_bundle(fhir):
    bad = {**patient("C"), "gender": "Q"}
    with pytest.raises(FhirError) as exc:
        fhir.transaction(1, bundle(patient("A"), patient("B"), bad))
    assert exc.value.status == 422 and fhir.count(1, "Patient") == 0


def test_duplicate_condition_in_one_bundle_is_rejected(fhir):
    with pytest.raises(FhirError):
        fhir.transaction(1, bundle(patient("A"), patient("A")))
    assert fhir.count(1, "Patient") == 0


def test_offline(fhir):
    fhir.offline = True
    with pytest.raises(FhirUnavailable):
        fhir.count(1, "Patient")


# ---------- HttpFhir：以 MockTransport 驗證送出的請求與錯誤對應 ----------

def http_fhir(handler):
    return HttpFhir("http://hapi:8080/fhir", transport=httpx.MockTransport(handler))


def test_http_ensure_tenant_creates_partition_once_and_tolerates_existing():
    calls = []

    def handler(request):
        calls.append((request.method, request.url.path, json.loads(request.content)))
        if len(calls) == 2:
            return httpx.Response(400, json={"resourceType": "OperationOutcome", "issue": [
                {"severity": "error", "diagnostics": 'HAPI-1309: Partition name "2" is already defined'}]})
        return httpx.Response(200, json={"resourceType": "Parameters"})

    client = http_fhir(handler)
    client.ensure_tenant(1)
    client.ensure_tenant(1)
    client.ensure_tenant(2)
    assert [c[1] for c in calls] == ["/fhir/DEFAULT/$partition-management-create-partition"] * 2
    assert calls[0][2]["parameter"] == [{"name": "id", "valueInteger": 1}, {"name": "name", "valueCode": "1"}]


def test_http_transaction_posts_bundle_to_tenant_base():
    seen = {}

    def handler(request):
        seen["path"], seen["body"] = request.url.path, json.loads(request.content)
        return httpx.Response(200, json={"resourceType": "Bundle", "type": "transaction-response", "entry": [
            {"response": {"status": "201 Created", "location": "Patient/1/_history/1"}}]})

    result = http_fhir(handler).transaction(3, bundle(patient("A")))
    assert seen["path"] == "/fhir/3" and seen["body"]["type"] == "transaction"
    assert result == [{"status": "201 Created", "location": "Patient/1/_history/1"}]


def test_http_errors_are_mapped():
    def rejected(request):
        return httpx.Response(404, json={"resourceType": "OperationOutcome", "issue": [
            {"severity": "error", "diagnostics": "HAPI-1091: Invalid match URL"}]})

    with pytest.raises(FhirError) as exc:
        http_fhir(rejected).transaction(1, bundle(patient("A")))
    assert exc.value.status == 404 and "HAPI-1091" in exc.value.message and not isinstance(exc.value, FhirUnavailable)

    def broken(request):
        raise httpx.ConnectError("refused")

    def slow(request):
        raise httpx.ReadTimeout("slow")

    for handler in (broken, slow, lambda r: httpx.Response(503, text="down")):
        with pytest.raises(FhirUnavailable):
            http_fhir(handler).count(1, "Patient")


def test_http_search_count_and_validate():
    def handler(request):
        if request.url.path.endswith("$validate"):
            return httpx.Response(200, json={"resourceType": "OperationOutcome", "issue": [
                {"severity": "warning", "diagnostics": "dom-6"}, {"severity": "error", "diagnostics": "bad code"}]})
        assert request.headers["cache-control"] == "no-cache"
        if request.url.params.get("_summary") == "count":
            return httpx.Response(200, json={"resourceType": "Bundle", "total": 20})
        assert request.url.params["_count"] == "5" and request.url.params["_offset"] == "10"
        return httpx.Response(200, json={"resourceType": "Bundle", "total": 20, "entry": [
            {"resource": {"resourceType": "Patient", "id": "7"}},
            {"resource": {"resourceType": "OperationOutcome"}}]})

    client = http_fhir(handler)
    assert client.count(1, "Patient") == 20
    assert client.search(1, "Patient", count=5, offset=10) == (20, [{"resourceType": "Patient", "id": "7"}])
    assert client.validate(1, patient("A")) == ["bad code"]


def test_fhir_from_env():
    assert fhir_from_env({}) is None
    assert isinstance(fhir_from_env({"FHIR_URL": "http://hapi:8080/fhir"}), HttpFhir)
