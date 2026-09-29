"""平台 DICOM 節點（Orthanc）的介面。

`OrthancClient` 只有平台需要的 5 個動作；`InMemoryOrthanc` 給單元測試（內含一個模擬 PACS），
`HttpOrthanc` 走 Orthanc REST（/instances、/modalities/{pacs}/query|move、/tools/find）。
PACS 查詢都在 Study 層級。查詢鍵：StudyInstanceUID、AccessionNumber、PatientID、PatientSex、
StudyDate（YYYYMMDD 或 YYYYMMDD-YYYYMMDD）、StudyDescription、Modality。
"""
import fnmatch
from collections.abc import Mapping
from typing import Protocol

import httpx

from app.imaging.dicom import InvalidDicom, parse_dicom


class OrthancError(RuntimeError):
    pass


_RETURN_KEYS = ["StudyInstanceUID", "AccessionNumber", "PatientID", "PatientSex", "StudyDate",
                "StudyDescription", "ModalitiesInStudy", "NumberOfStudyRelatedSeries",
                "NumberOfStudyRelatedInstances"]
QUERY_KEYS = {"StudyInstanceUID", "AccessionNumber", "PatientID", "PatientSex", "StudyDate",
              "StudyDescription", "Modality"}


class OrthancClient(Protocol):
    def store(self, data: bytes) -> str: ...
    def pacs_find(self, query: Mapping[str, str]) -> list[dict]: ...
    def pacs_move(self, study_uid: str) -> None: ...
    def study_instances(self, study_uid: str) -> list[bytes]: ...
    def delete(self, sop_instance_uid: str) -> None: ...


def _matches(value: str, pattern: str, key: str) -> bool:
    if not pattern:
        return True
    if key == "StudyDate" and "-" in pattern:
        lo, hi = pattern.split("-", 1)
        return (not lo or value >= lo) and (not hi or value <= hi)
    if key == "Modality":
        return pattern.upper() in value.upper().split("\\")
    return fnmatch.fnmatchcase(value.upper(), pattern.upper())


class InMemoryOrthanc:
    def __init__(self, pacs: list[bytes] | None = None):
        self.instances: dict[str, bytes] = {}     # SOP Instance UID -> 檔案（平台節點）
        self.pacs: dict[str, bytes] = {parse_dicom(d).sop_instance_uid: d for d in pacs or []}

    def store(self, data: bytes) -> str:
        try:
            sop = parse_dicom(data).sop_instance_uid
        except InvalidDicom as exc:
            raise OrthancError(f"影像節點拒收：{exc}") from exc
        self.instances[sop] = data
        return f"orthanc-{sop}"

    def pacs_find(self, query: Mapping[str, str]) -> list[dict]:
        studies: dict[str, dict] = {}
        for data in self.pacs.values():
            info = parse_dicom(data)
            s = studies.setdefault(info.study_instance_uid, {
                "StudyInstanceUID": info.study_instance_uid, "AccessionNumber": info.accession_number,
                "PatientID": info.patient_id, "PatientSex": info.patient_sex, "StudyDate": info.study_date,
                "StudyDescription": info.study_description, "_mods": set(), "_series": set(), "_n": 0})
            s["_mods"].add(info.modality)
            s["_series"].add(info.series_instance_uid)
            s["_n"] += 1
        answers = []
        for s in studies.values():
            answer = {k: v for k, v in s.items() if not k.startswith("_")}
            answer["ModalitiesInStudy"] = "\\".join(sorted(s["_mods"]))
            answer["Modality"] = answer["ModalitiesInStudy"]
            answer["NumberOfStudyRelatedSeries"] = str(len(s["_series"]))
            answer["NumberOfStudyRelatedInstances"] = str(s["_n"])
            if all(_matches(answer.get(k, ""), v, k) for k, v in query.items()):
                answers.append(answer)
        return sorted(answers, key=lambda a: a["StudyInstanceUID"])

    def pacs_move(self, study_uid: str) -> None:
        moved = [d for d in self.pacs.values() if parse_dicom(d).study_instance_uid == study_uid]
        if not moved:
            raise OrthancError(f"PACS 找不到研究 {study_uid}")
        for data in moved:
            self.store(data)

    def study_instances(self, study_uid: str) -> list[bytes]:
        return [d for d in self.instances.values() if parse_dicom(d).study_instance_uid == study_uid]

    def delete(self, sop_instance_uid: str) -> None:
        self.instances.pop(sop_instance_uid, None)


class HttpOrthanc:
    def __init__(self, base_url: str, *, username: str | None = None, password: str | None = None,
                 pacs_modality: str = "pacs", timeout: float = 30.0, transport: httpx.BaseTransport | None = None):
        self.pacs_modality = pacs_modality
        auth = (username, password) if username else None
        self._http = httpx.Client(base_url=base_url, auth=auth, timeout=timeout, transport=transport)

    def _call(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            response = self._http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise OrthancError(f"無法連線影像節點：{type(exc).__name__}") from exc
        if response.status_code >= 400:
            try:
                message = response.json().get("Message") or response.text
            except ValueError:
                message = response.text
            raise OrthancError(f"影像節點回應 {response.status_code}：{message[:200]}")
        return response

    def store(self, data: bytes) -> str:
        return self._call("POST", "/instances", content=data,
                          headers={"Content-Type": "application/dicom"}).json()["ID"]

    def pacs_find(self, query: Mapping[str, str]) -> list[dict]:
        q = {k: "" for k in _RETURN_KEYS}
        for k, v in query.items():
            q["ModalitiesInStudy" if k == "Modality" else k] = v
        qid = self._call("POST", f"/modalities/{self.pacs_modality}/query",
                         json={"Level": "Study", "Query": q}).json()["ID"]
        answers = []
        for index in self._call("GET", f"/queries/{qid}/answers").json():
            content = self._call("GET", f"/queries/{qid}/answers/{index}/content", params={"simplify": ""}).json()
            content["Modality"] = content.get("ModalitiesInStudy", "")
            answers.append(content)
        return answers

    def pacs_move(self, study_uid: str) -> None:
        self._call("POST", f"/modalities/{self.pacs_modality}/move",
                   json={"Level": "Study", "Resources": [{"StudyInstanceUID": study_uid}], "Synchronous": True})

    def study_instances(self, study_uid: str) -> list[bytes]:
        ids = self._call("POST", "/tools/find",
                         json={"Level": "Instance", "Query": {"StudyInstanceUID": study_uid}}).json()
        return [self._call("GET", f"/instances/{i}/file").content for i in ids]

    def delete(self, sop_instance_uid: str) -> None:
        """從平台節點刪除一張影像；找不到視為已刪除。"""
        ids = self._call("POST", "/tools/find",
                         json={"Level": "Instance", "Query": {"SOPInstanceUID": sop_instance_uid}}).json()
        for i in ids:
            self._call("DELETE", f"/instances/{i}")


def orthanc_from_env(env: Mapping[str, str]) -> OrthancClient | None:
    """ORTHANC_URL 未設定時回 None（影像端點回 503）。"""
    if not env.get("ORTHANC_URL"):
        return None
    return HttpOrthanc(env["ORTHANC_URL"], username=env.get("ORTHANC_USERNAME"),
                       password=env.get("ORTHANC_PASSWORD"),
                       pacs_modality=env.get("ORTHANC_PACS_MODALITY", "pacs"))
