"""WP6 HL7 FHIR 醫療資料交換（C-03）。租戶＝平台專案；FHIR 伺服器只經 FhirClient 介面操作。"""
from app.fhir.router import router

__all__ = ["router"]
