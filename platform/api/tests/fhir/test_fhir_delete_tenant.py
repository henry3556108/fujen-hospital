"""刪專案時清掉 HAPI 租戶：刪除所有資源 → $expunge → 刪分割區。記憶體版與 HttpFhir（MockTransport 模擬 HAPI）。"""
import json
import re

import httpx
import pytest

from app.fhir.client import FhirError, FhirUnavailable, HttpFhir, InMemoryFhir
from test_fhir_client import bundle, encounter, patient


# ---------- InMemoryFhir ----------

def test_in_memory_delete_tenant_removes_only_that_tenant():
    fhir = InMemoryFhir()
    for tenant in (1, 2):
        fhir.ensure_tenant(tenant)
        fhir.transaction(tenant, bundle(encounter("E1", "A"), patient("A"), patient("B")))
    assert fhir.delete_tenant(1) == 3
    assert fhir.tenants() == [2] and fhir.count(2, "Patient") == 2
    assert fhir.delete_tenant(1) == 0            # 已經不存在：視為清空
    assert fhir.delete_tenant(99) == 0


def test_in_memory_delete_tenant_offline():
    fhir = InMemoryFhir()
    fhir.ensure_tenant(1)
    fhir.offline = True
    with pytest.raises(FhirUnavailable):
        fhir.delete_tenant(1)


# ---------- HttpFhir：以 MockTransport 模擬 HAPI 的分割區、參照檢查與 expunge ----------

class FakeHapi:
    TYPES = ["Condition", "Encounter", "Observation", "Patient"]

    def __init__(self):
        # {tenant: {"Type/id": {"refs": [...], "deleted": bool}}}
        self.partitions: dict[int, dict[str, dict]] = {}
        self.calls: list[tuple[str, str]] = []
        self.transactions = 0
        self.expunged: list[int] = []
        self.deleted_partitions: list[int] = []
        self.fail_expunge = False

    def add(self, tenant, key, refs=()):
        self.partitions.setdefault(tenant, {})[key] = {"refs": list(refs), "deleted": False}

    def live(self, tenant):
        return sorted(k for k, v in self.partitions.get(tenant, {}).items() if not v["deleted"])

    @staticmethod
    def outcome(status, text):
        return httpx.Response(status, json={"resourceType": "OperationOutcome",
                                            "issue": [{"severity": "error", "diagnostics": text}]})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/fhir/")
        self.calls.append((request.method, path))
        if path == "DEFAULT/$partition-management-delete-partition":
            tenant = json.loads(request.content)["parameter"][0]["valueInteger"]
            if tenant not in self.partitions:
                return self.outcome(400, f'HAPI-2264: Partition "{tenant}" does not exist')
            del self.partitions[tenant]
            self.deleted_partitions.append(tenant)
            return httpx.Response(200, json={"resourceType": "Parameters"})
        head, _, rest = path.partition("/")
        tenant = int(head)
        if rest == "metadata":           # HAPI 8.12：metadata 不檢查分割區是否存在
            return httpx.Response(200, json={"resourceType": "CapabilityStatement",
                                             "rest": [{"resource": [{"type": t} for t in self.TYPES]}]})
        if tenant not in self.partitions:
            return self.outcome(404, f'Partition name "{tenant}" is not valid')
        data = self.partitions[tenant]
        if rest == "$expunge":
            if self.fail_expunge:
                return httpx.Response(500, text="boom")
            removed = [k for k, v in data.items() if v["deleted"]]
            for key in removed:
                del data[key]
            self.expunged.append(tenant)
            return httpx.Response(200, json={"resourceType": "Parameters",
                                             "parameter": [{"name": "count", "valueInteger": len(removed)}]})
        if request.method == "GET" and re.fullmatch(r"[A-Z][A-Za-z]+", rest):
            keys = [k for k in self.live(tenant) if k.startswith(rest + "/")]
            if request.url.params.get("_summary") == "count":
                return httpx.Response(200, json={"resourceType": "Bundle", "total": len(keys)})
            count, offset = int(request.url.params["_count"]), int(request.url.params.get("_offset", "0"))
            page = keys[offset:offset + count]
            return httpx.Response(200, json={"resourceType": "Bundle", "total": len(keys), "entry": [
                {"resource": {"resourceType": rest, "id": k.split("/")[1]}} for k in page]})
        if request.method == "POST" and rest == "":
            body = json.loads(request.content)
            targets = [e["request"]["url"] for e in body["entry"]]
            assert all(e["request"]["method"] == "DELETE" for e in body["entry"])
            # HAPI 在 Transaction 結束時檢查參照：留下來的資源還指向被刪的，就整批 409
            for key, value in data.items():
                if value["deleted"] or key in targets:
                    continue
                blocked = [r for r in value["refs"] if r in targets]
                if blocked:
                    return self.outcome(409, f"Unable to delete {blocked[0]} because {key} refers to it")
            for key in targets:
                if key in data:
                    data[key]["deleted"] = True
            self.transactions += 1
            return httpx.Response(200, json={"resourceType": "Bundle", "type": "transaction-response",
                                             "entry": [{"response": {"status": "204 No Content"}} for _ in targets]})
        raise AssertionError(f"未預期的請求 {request.method} {request.url}")


def http_fhir(hapi, **kwargs):
    return HttpFhir("http://hapi:8080/fhir", transport=httpx.MockTransport(hapi), **kwargs)


def test_http_delete_tenant_deletes_expunges_and_drops_partition():
    hapi = FakeHapi()
    for tenant in (5, 6):
        hapi.add(tenant, "Patient/1")
        hapi.add(tenant, "Encounter/2", refs=["Patient/1"])
        hapi.add(tenant, "Observation/3", refs=["Patient/1", "Encounter/2"])
    client = http_fhir(hapi)
    assert client.delete_tenant(5) == 3
    assert 5 not in hapi.partitions and hapi.deleted_partitions == [5] and hapi.expunged == [5]
    assert hapi.live(6) == ["Encounter/2", "Observation/3", "Patient/1"]      # 其他租戶不受影響
    assert all(path.startswith(("5/", "5", "DEFAULT/")) for _, path in hapi.calls)
    assert hapi.transactions == 1                                              # 互相參照的資源同一批刪


def test_http_delete_tenant_batches_and_retries_references_across_batches():
    """每批 2 筆：被參照的型別排在後面；跨批仍被擋（409）的留到下一輪。"""
    hapi = FakeHapi()
    for i in range(3):
        hapi.add(7, f"Patient/{i}")
        hapi.add(7, f"Observation/{10 + i}", refs=[f"Patient/{i}"])
    hapi.add(7, "Patient/9", refs=["Patient/0"])                  # 同型別互相參照
    assert http_fhir(hapi, delete_batch=2).delete_tenant(7) == 7
    assert 7 not in hapi.partitions


def test_http_delete_tenant_missing_partition_is_already_clean():
    hapi = FakeHapi()
    assert http_fhir(hapi).delete_tenant(8) == 0
    assert hapi.calls == [("GET", "8/metadata"), ("GET", "8/Condition")]


def test_http_delete_tenant_failure_raises_so_the_task_is_retried():
    hapi = FakeHapi()
    hapi.add(5, "Patient/1")
    hapi.fail_expunge = True
    client = http_fhir(hapi)
    with pytest.raises(FhirUnavailable):
        client.delete_tenant(5)
    assert 5 in hapi.partitions                                    # 分割區還在，重試時再清
    hapi.fail_expunge = False
    assert client.delete_tenant(5) == 0 and 5 not in hapi.partitions


def test_http_delete_tenant_forgets_cached_tenant():
    """同一個程序之後又用到這個編號（SQLite 重用編號）時要重新建立分割區。"""
    hapi = FakeHapi()
    created = []

    def handler(request):
        if request.url.path.endswith("$partition-management-create-partition"):
            tenant = json.loads(request.content)["parameter"][0]["valueInteger"]
            hapi.partitions.setdefault(tenant, {})
            created.append(tenant)
            return httpx.Response(200, json={"resourceType": "Parameters"})
        return hapi(request)

    client = HttpFhir("http://hapi:8080/fhir", transport=httpx.MockTransport(handler))
    client.ensure_tenant(4)
    client.delete_tenant(4)
    client.ensure_tenant(4)
    assert created == [4, 4]


def test_http_delete_tenant_no_progress_is_an_error():
    hapi = FakeHapi()
    hapi.add(5, "Patient/1", refs=["Patient/1"])
    original = hapi.__call__

    def stuck(request):
        if request.method == "POST" and request.url.path == "/fhir/5":
            return FakeHapi.outcome(409, "Unable to delete Patient/1")
        return original(request)

    with pytest.raises(FhirError) as exc:
        HttpFhir("http://hapi:8080/fhir", transport=httpx.MockTransport(stuck)).delete_tenant(5)
    assert "Patient/1" in exc.value.message
