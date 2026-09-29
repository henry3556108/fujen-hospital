"""以病人為中心的 FHIR Resource 關聯圖：節點是資源，邊是資源之間的參照。"""
from app.fhir.client import FhirClient
from app.fhir.mapping import SYSTEM_MRN

MAX_PER_TYPE = 200


def _identifier(resource: dict) -> str:
    ids = resource.get("identifier") or [{}]
    return ids[0].get("value", "")


def _label(resource: dict) -> str:
    kind = resource["resourceType"]
    if kind == "Patient":
        name = (resource.get("name") or [{}])[0]
        full = " ".join(filter(None, [name.get("family"), *(name.get("given") or [])]))
        return f"{full}（{_identifier(resource)}）" if full else _identifier(resource)
    if kind == "Encounter":
        start = (resource.get("period") or {}).get("start", "")
        return f"{(resource.get('class') or {}).get('code', '')} {start[:10]}".strip() or _identifier(resource)
    coding = ((resource.get("code") or {}).get("coding") or [{}])[0]
    quantity = resource.get("valueQuantity") or {}
    value = f" {quantity.get('value')} {quantity.get('unit', '')}".rstrip() if "value" in quantity else ""
    return f"{coding.get('display') or coding.get('code', '')}{value}"


def _references(node, path="") -> list[tuple[str, str]]:
    found = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "reference" and isinstance(value, str):
                found.append((path.rstrip("."), value))
            else:
                found.extend(_references(value, f"{path}{key}."))
    elif isinstance(node, list):
        for item in node:
            found.extend(_references(item, path))
    return found


def patient_graph(client: FhirClient, tenant: int, mrn: str) -> dict | None:
    """找不到病人回 None。邊只保留兩端都在圖內的參照。"""
    _, patients = client.search(tenant, "Patient", {"identifier": f"{SYSTEM_MRN}|{mrn}"}, count=2)
    if not patients:
        return None
    patient = patients[0]
    resources = [patient]
    truncated = False
    for kind in ("Encounter", "Observation"):
        total, rows = client.search(tenant, kind, {"subject": f"Patient/{patient['id']}"}, count=MAX_PER_TYPE)
        truncated = truncated or total > len(rows)
        resources.extend(rows)
    nodes = [{"id": f"{r['resourceType']}/{r['id']}", "type": r["resourceType"], "label": _label(r),
              "identifier": _identifier(r)} for r in resources]
    known = {n["id"] for n in nodes}
    edges = [{"from": f"{r['resourceType']}/{r['id']}", "to": target, "relation": relation}
             for r in resources for relation, target in _references(r) if target in known]
    return {"patient": mrn, "nodes": nodes, "edges": edges, "truncated": truncated}
