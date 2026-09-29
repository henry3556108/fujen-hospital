"""FHIR 伺服器介面。平台只經由這個介面讀寫 FHIR 資料。

- InMemoryFhir：記憶體版，語意與 HAPI 相同的部分——租戶隔離、條件式 upsert、條件式參照、
  Transaction 整批成功或整批不寫；可注入中斷（fail_after_entries、offline）供原子性測試。
- HttpFhir：HAPI FHIR JPA Server（URL 式多租戶：/fhir/{tenant}/...，tenant＝專案編號）。
"""
import copy
import os
import re
from collections.abc import Mapping
from typing import Protocol

import httpx

from app.fhir.resources import validate as validate_resource

_CONDITION = re.compile(r"^(?P<type>[A-Za-z]+)\?identifier=(?P<system>[^|&]+)\|(?P<value>[^&]+)$")


class FhirError(Exception):
    """FHIR 伺服器拒絕請求（資料問題）。"""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.message = message
        self.status = status


class FhirUnavailable(FhirError):
    """連不上、逾時或連線中斷。寫入結果未知時也用這個：呼叫端要以查詢確認。"""


class FhirClient(Protocol):
    def ensure_tenant(self, tenant: int) -> None: ...
    def transaction(self, tenant: int, bundle: dict) -> list[dict]: ...
    def search(self, tenant: int, resource_type: str, params: Mapping[str, str] | None = None, *,
               count: int = 50, offset: int = 0) -> tuple[int, list[dict]]: ...
    def count(self, tenant: int, resource_type: str) -> int: ...
    def validate(self, tenant: int, resource: dict) -> list[str]: ...


def parse_condition(url: str) -> tuple[str, str, str] | None:
    m = _CONDITION.match(url)
    return (m["type"], m["system"], m["value"]) if m else None


def _matches_identifier(resource: dict, system: str, value: str) -> bool:
    return any(i.get("system") == system and i.get("value") == value for i in resource.get("identifier") or [])


def _walk_references(node, visit) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "reference" and isinstance(value, str):
                node[key] = visit(value)
            else:
                _walk_references(value, visit)
    elif isinstance(node, list):
        for item in node:
            _walk_references(item, visit)


class InMemoryFhir:
    def __init__(self):
        self._tenants: dict[int, dict[str, dict[str, dict]]] = {}
        self._next_id = 1000
        self.offline = False
        self.fail_after_entries: int | None = None   # 處理到第 n 個 entry 後模擬連線中斷（只生效一次）
        self.transactions = 0

    # --- 測試用 ---
    def tenants(self) -> list[int]:
        return sorted(self._tenants)

    def all(self, tenant: int, resource_type: str) -> list[dict]:
        return list(self._tenants.get(tenant, {}).get(resource_type, {}).values())

    # --- FhirClient ---
    def _check_online(self) -> None:
        if self.offline:
            raise FhirUnavailable("FHIR 服務無法連線")

    def ensure_tenant(self, tenant: int) -> None:
        self._check_online()
        self._tenants.setdefault(tenant, {})

    def _store(self, tenant: int) -> dict[str, dict[str, dict]]:
        if tenant not in self._tenants:
            raise FhirError(f"租戶 {tenant} 不存在", 404)
        return self._tenants[tenant]

    def transaction(self, tenant: int, bundle: dict) -> list[dict]:
        self._check_online()
        if bundle.get("resourceType") != "Bundle" or bundle.get("type") != "transaction":
            raise FhirError("只接受 Bundle(type=transaction)", 400)
        work = copy.deepcopy(self._store(tenant))   # 全部成功才換回去
        next_id = self._next_id
        results: list[dict] = []
        touched: list[dict] = []
        seen: set[str] = set()
        for index, entry in enumerate(bundle.get("entry") or []):
            if self.fail_after_entries is not None and index >= self.fail_after_entries:
                self.fail_after_entries = None
                raise FhirUnavailable("連線在寫入中途中斷")
            resource = copy.deepcopy(entry.get("resource") or {})
            request = entry.get("request") or {}
            condition = parse_condition(request.get("url", ""))
            if request.get("method") != "PUT" or condition is None or condition[0] != resource.get("resourceType"):
                raise FhirError(f"entry[{index}] 只支援條件式 PUT {{type}}?identifier=system|value", 400)
            if request["url"] in seen:
                raise FhirError(f"entry[{index}] 與同一個 Transaction 內的其他 entry 條件相同", 400)
            seen.add(request["url"])
            issues = validate_resource(resource)
            if issues:
                raise FhirError(f"entry[{index}] 驗證不通過：{'；'.join(issues)}", 422)
            kind, system, value = condition
            bucket = work.setdefault(kind, {})
            matches = [rid for rid, r in bucket.items() if _matches_identifier(r, system, value)]
            if len(matches) > 1:
                raise FhirError(f"entry[{index}] 條件符合多筆資源", 412)
            if matches:
                rid, status = matches[0], "200 OK"
                version = int(bucket[rid]["meta"]["versionId"]) + 1
            else:
                rid, status, version = str(next_id), "201 Created", 1
                next_id += 1
            resource["id"] = rid
            resource["meta"] = {"versionId": str(version)}
            bucket[rid] = resource
            touched.append(resource)
            results.append({"status": status, "location": f"{kind}/{rid}/_history/{version}"})

        def resolve(reference: str) -> str:
            condition = parse_condition(reference)
            if condition is None:
                return reference
            kind, system, value = condition
            found = [rid for rid, r in work.get(kind, {}).items() if _matches_identifier(r, system, value)]
            if len(found) != 1:
                raise FhirError(f"條件式參照 {reference} 找不到唯一的資源", 404)
            return f"{kind}/{found[0]}"

        for resource in touched:
            _walk_references(resource, resolve)
        self._tenants[tenant] = work
        self._next_id = next_id
        self.transactions += 1
        return results

    def search(self, tenant, resource_type, params=None, *, count=50, offset=0):
        self._check_online()
        rows = list(self._store(tenant).get(resource_type, {}).values())
        for key, value in (params or {}).items():
            if key == "identifier":
                system, _, ident = value.partition("|")
                rows = [r for r in rows if _matches_identifier(r, system, ident)]
            elif key in ("subject", "patient"):
                target = value if "/" in value else f"Patient/{value}"
                rows = [r for r in rows if (r.get("subject") or {}).get("reference") == target]
            elif key == "_id":
                rows = [r for r in rows if r["id"] == value]
            else:
                raise FhirError(f"不支援的查詢參數 {key}", 400)
        rows.sort(key=lambda r: int(r["id"]))
        return len(rows), copy.deepcopy(rows[offset:offset + count])

    def count(self, tenant, resource_type):
        self._check_online()
        return len(self._store(tenant).get(resource_type, {}))

    def validate(self, tenant, resource):
        self._check_online()
        self._store(tenant)
        return validate_resource(resource)


def _outcome_errors(body) -> list[str]:
    if not isinstance(body, dict):
        return []
    return [i.get("diagnostics") or (i.get("details") or {}).get("text") or i.get("code", "")
            for i in body.get("issue") or [] if i.get("severity") in ("error", "fatal")]


class HttpFhir:
    def __init__(self, base_url: str, *, timeout: float = 30.0, transport: httpx.BaseTransport | None = None):
        self._http = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport,
                                  headers={"Accept": "application/fhir+json",
                                           "Cache-Control": "no-cache"})   # 不用 HAPI 的搜尋結果快取
        self._tenants: set[int] = set()

    def _send(self, method: str, url: str, **kwargs) -> httpx.Response:
        try:
            return self._http.request(method, url, **kwargs)
        except httpx.TimeoutException:
            raise FhirUnavailable("FHIR 服務回應逾時")
        except httpx.TransportError:
            raise FhirUnavailable("FHIR 服務無法連線")

    @staticmethod
    def _json(response: httpx.Response):
        try:
            return response.json()
        except ValueError:
            return None

    def _fail(self, response: httpx.Response) -> FhirError:
        if response.status_code >= 500:
            return FhirUnavailable(f"FHIR 服務錯誤（HTTP {response.status_code}）", response.status_code)
        errors = _outcome_errors(self._json(response))
        return FhirError("；".join(errors) or f"FHIR 服務拒絕請求（HTTP {response.status_code}）",
                         response.status_code)

    def ensure_tenant(self, tenant: int) -> None:
        if tenant in self._tenants:
            return
        body = {"resourceType": "Parameters", "parameter": [
            {"name": "id", "valueInteger": tenant}, {"name": "name", "valueCode": str(tenant)}]}
        response = self._send("POST", "/DEFAULT/$partition-management-create-partition", json=body,
                              headers={"Content-Type": "application/fhir+json"})
        if response.status_code >= 300:
            errors = " ".join(_outcome_errors(self._json(response)))
            if "already defined" not in errors and "already exists" not in errors and "HAPI-1309" not in errors:
                raise self._fail(response)
        self._tenants.add(tenant)

    def transaction(self, tenant: int, bundle: dict) -> list[dict]:
        response = self._send("POST", f"/{tenant}", json=bundle, headers={"Content-Type": "application/fhir+json"})
        if response.status_code >= 300:
            raise self._fail(response)
        body = self._json(response) or {}
        return [{"status": e.get("response", {}).get("status", ""),
                 "location": e.get("response", {}).get("location", "")} for e in body.get("entry") or []]

    def search(self, tenant, resource_type, params=None, *, count=50, offset=0):
        query = {**(params or {}), "_count": str(count), "_offset": str(offset), "_total": "accurate",
                 "_sort": "_id"}
        response = self._send("GET", f"/{tenant}/{resource_type}", params=query)
        if response.status_code >= 300:
            raise self._fail(response)
        body = self._json(response) or {}
        rows = [e["resource"] for e in body.get("entry") or []
                if e.get("resource", {}).get("resourceType") == resource_type]
        return int(body.get("total", len(rows))), rows

    def count(self, tenant, resource_type):
        response = self._send("GET", f"/{tenant}/{resource_type}", params={"_summary": "count"})
        if response.status_code >= 300:
            raise self._fail(response)
        return int((self._json(response) or {}).get("total", 0))

    def validate(self, tenant, resource):
        response = self._send("POST", f"/{tenant}/{resource.get('resourceType')}/$validate", json=resource,
                              headers={"Content-Type": "application/fhir+json"})
        if response.status_code >= 500:
            raise self._fail(response)
        errors = _outcome_errors(self._json(response))
        if response.status_code >= 400 and not errors:
            errors = [f"FHIR 服務拒絕請求（HTTP {response.status_code}）"]
        return errors


def fhir_from_env(env: Mapping[str, str] = os.environ) -> FhirClient | None:
    """FHIR_URL 未設定時回 None（FHIR 端點回 503）。"""
    url = env.get("FHIR_URL", "").strip()
    if not url:
        return None
    return HttpFhir(url, timeout=float(env.get("FHIR_TIMEOUT_SECONDS", "30")))
