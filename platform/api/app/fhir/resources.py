"""FHIR R4 資源驗證。結構與型別交給 fhir.resources（R4B，與 R4 的這三種資源相容），
代碼值域與平台要求的必要欄位在這裡補上。整合環境另以 HAPI 的 $validate 再驗一次（TC-C03-01）。
"""
from fhir.resources.R4B import get_fhir_model_class
from pydantic import ValidationError

SUPPORTED_TYPES = ("Patient", "Encounter", "Observation")

ADMINISTRATIVE_GENDER = {"male", "female", "other", "unknown"}
ENCOUNTER_STATUS = {"planned", "arrived", "triaged", "in-progress", "onleave", "finished", "cancelled",
                    "entered-in-error", "unknown"}
OBSERVATION_STATUS = {"registered", "preliminary", "final", "amended", "corrected", "cancelled",
                      "entered-in-error", "unknown"}
_VALUE_KEYS = ("valueQuantity", "valueCodeableConcept", "valueString", "valueBoolean", "valueInteger",
               "valueRange", "valueRatio", "valueSampledData", "valueTime", "valueDateTime", "valuePeriod")


def _has_identifier(resource: dict) -> bool:
    return any(i.get("system") and i.get("value") for i in resource.get("identifier") or [])


def _has_coding(concept: dict | None) -> bool:
    return any(c.get("system") and c.get("code") for c in (concept or {}).get("coding") or [])


def validate(resource: dict) -> list[str]:
    """回傳問題清單；空清單代表通過。"""
    kind = resource.get("resourceType") if isinstance(resource, dict) else None
    if kind not in SUPPORTED_TYPES:
        return [f"不支援的資源型別 {kind!r}（支援：{'、'.join(SUPPORTED_TYPES)}）"]
    issues: list[str] = []
    try:
        get_fhir_model_class(kind).model_validate(resource)
    except ValidationError as exc:
        for err in exc.errors():
            where = ".".join(str(p) for p in err["loc"]) or kind
            issues.append(f"{where}：{err['msg']}")

    if not _has_identifier(resource):
        issues.append("identifier：至少要有一組 system 與 value")
    if kind == "Patient":
        gender = resource.get("gender")
        if gender is not None and gender not in ADMINISTRATIVE_GENDER:
            issues.append(f"gender：{gender!r} 不在 administrative-gender 值域")
    elif kind == "Encounter":
        if resource.get("status") not in ENCOUNTER_STATUS:
            issues.append(f"status：{resource.get('status')!r} 不在 encounter-status 值域")
        cls = resource.get("class") or {}
        if not (cls.get("system") and cls.get("code")):
            issues.append("class：需要 system 與 code")
        if not (resource.get("subject") or {}).get("reference"):
            issues.append("subject.reference：必填")
    elif kind == "Observation":
        if resource.get("status") not in OBSERVATION_STATUS:
            issues.append(f"status：{resource.get('status')!r} 不在 observation-status 值域")
        if not _has_coding(resource.get("code")):
            issues.append("code.coding：至少要有一組 system 與 code")
        if not (resource.get("subject") or {}).get("reference"):
            issues.append("subject.reference：必填")
        if not (any(k in resource for k in _VALUE_KEYS) or resource.get("dataAbsentReason")
                or resource.get("component") or resource.get("hasMember")):
            issues.append("value[x]：需要觀測值或 dataAbsentReason")
        if not (resource.get("effectiveDateTime") or resource.get("effectivePeriod")):
            issues.append("effective[x]：必填")
    return issues
