"""影像匯入與查詢的業務邏輯（路由、DICOMweb 授權共用）。"""
import hashlib
import os
import posixpath
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from app.audit import AuditCategory, record
from app.authz import DicomwebTarget
from app.imaging.dicom import DicomInfo, InvalidDicom, parse_dicom
from app.imaging.formats import InvalidFile, parse_file
from app.imaging.models import (AccessionAllowlist, ImagingFile, ImagingInstance, ImagingInstanceSource,
                                ImagingSeries, ImagingStudy, ImportFileResult, ImportJob)
from app.imaging.orthanc import QUERY_KEYS, OrthancClient, OrthancError
from app.storage import ObjectStore

DICOM_EXTENSIONS = ("", ".dcm", ".dicom", ".ima")
DEFAULT_MAX_FILE_MB = 512
DEFAULT_MAX_DECOMPRESSED_MB = 2048


@dataclass(frozen=True)
class Oversize:
    """上傳時就超過單檔上限的檔案：內容沒有讀進來，只在匯入結果記成失敗。"""
    limit: int

    @property
    def reason(self) -> str:
        return f"檔案超過上限 {self.limit / 1024 / 1024:g} MB"


@dataclass(frozen=True)
class Rejected:
    """上傳時就被擋下的檔案（例如掃毒攔截）：只在匯入結果記成失敗。"""
    reason: str


FileItem = tuple[str, bytes | Oversize | Rejected]


def upload_limits(state) -> tuple[int, int]:
    """（單檔上限, 解壓後上限）位元組。app.state.imaging_max_*_bytes > 環境變數 IMAGING_MAX_*_MB > 預設 512／2048 MB。"""
    def one(attr: str, env: str, default_mb: int) -> int:
        configured = getattr(state, attr, None)
        if configured:
            return int(configured)
        return int(float(os.environ.get(env, default_mb)) * 1024 * 1024)
    return (one("imaging_max_file_bytes", "IMAGING_MAX_FILE_MB", DEFAULT_MAX_FILE_MB),
            one("imaging_max_decompressed_bytes", "IMAGING_MAX_DECOMPRESSED_MB", DEFAULT_MAX_DECOMPRESSED_MB))


# ---------- 共用 ----------

def clean_name(name: str | None) -> str:
    """上傳檔名只當顯示與配對用：去掉開頭斜線、反斜線改斜線、限制長度。"""
    name = (name or "").replace("\\", "/").lstrip("/")
    return name[-512:] or "(未命名)"


def allowlist(session: Session, project_id: int) -> set[str]:
    return set(session.scalars(select(AccessionAllowlist.accession_number)
                               .where(AccessionAllowlist.project_id == project_id)))


def _finish_job(session: Session, job: ImportJob, results: list[ImportFileResult], *, actor: str,
                source_ip: str | None, extra: dict | None = None) -> ImportJob:
    counts = {"imported": 0, "duplicate": 0, "failed": 0}
    for r in results:
        counts[r.status] += 1
    job.counts = counts
    job.files = results
    if counts["failed"] == 0:
        job.status = "succeeded"
    elif counts["imported"] + counts["duplicate"] == 0:
        job.status = "failed"
    else:
        job.status = "partial"
    session.flush()
    record(session, actor=actor, category=AuditCategory.DATASET, action=f"imaging.import_{job.kind}",
           target=f"project:{job.project_id}", result="success" if job.status == "succeeded" else job.status,
           source_ip=source_ip, detail={"job_id": job.id, "counts": counts, **(extra or {})})
    session.commit()
    return job


def job_to_dict(job: ImportJob, *, with_files: bool = True) -> dict:
    out = {"id": job.id, "kind": job.kind, "status": job.status, "created_by": job.created_by,
           "created_at": job.created_at.isoformat(), "counts": job.counts}
    if with_files:
        out["files"] = [{"filename": f.filename, "status": f.status, "reason": f.reason} for f in job.files]
    return out


def get_job(session: Session, project_id: int, job_id: int) -> ImportJob:
    job = session.get(ImportJob, job_id)
    if job is None or job.project_id != project_id:
        raise HTTPException(404, f"找不到匯入工作 {job_id}")
    return job


def list_jobs(session: Session, project_id: int) -> list[ImportJob]:
    return list(session.scalars(select(ImportJob).where(ImportJob.project_id == project_id)
                                .order_by(ImportJob.id.desc())))


# ---------- DICOM ----------

def _index(session: Session, project_id: int, info: DicomInfo, *, source_path: str, orthanc_id: str) -> None:
    study = session.scalar(select(ImagingStudy).where(ImagingStudy.project_id == project_id,
                                                      ImagingStudy.study_instance_uid == info.study_instance_uid))
    if study is None:
        study = ImagingStudy(project_id=project_id, study_instance_uid=info.study_instance_uid,
                             accession_number=info.accession_number, patient_id=info.patient_id,
                             patient_sex=info.patient_sex, study_date=info.study_date,
                             study_description=info.study_description)
        session.add(study)
        session.flush()
    series = session.scalar(select(ImagingSeries).where(ImagingSeries.study_id == study.id,
                                                        ImagingSeries.series_instance_uid == info.series_instance_uid))
    if series is None:
        series = ImagingSeries(study_id=study.id, series_instance_uid=info.series_instance_uid,
                               modality=info.modality, series_description=info.series_description)
        session.add(series)
        session.flush()
    session.add(ImagingInstance(project_id=project_id, series_id=series.id, sop_instance_uid=info.sop_instance_uid,
                                source_path=source_path, orthanc_id=orthanc_id))
    session.flush()


def _find_instance(session: Session, project_id: int, sop_uid: str) -> ImagingInstance | None:
    return session.scalar(select(ImagingInstance).where(ImagingInstance.project_id == project_id,
                                                        ImagingInstance.sop_instance_uid == sop_uid))


def _remember_path(session: Session, instance: ImagingInstance, path: str) -> bool:
    """重複影像的這次來源路徑若是新的就補記；回傳是否有新增。"""
    if path == instance.source_path or session.scalar(select(ImagingInstanceSource.id).where(
            ImagingInstanceSource.instance_id == instance.id, ImagingInstanceSource.source_path == path)) is not None:
        return False
    session.add(ImagingInstanceSource(project_id=instance.project_id, instance_id=instance.id, source_path=path))
    session.flush()
    return True


def _import_one_dicom(session: Session, orthanc: OrthancClient, project_id: int, name: str, data: bytes,
                      *, store_in_orthanc: bool = True) -> ImportFileResult:
    if isinstance(data, (Oversize, Rejected)):
        return ImportFileResult(filename=name, status="failed", reason=data.reason)
    ext = posixpath.splitext(name.lower())[1]
    if ext not in DICOM_EXTENSIONS:
        return ImportFileResult(filename=name, status="failed", reason=f"副檔名 {ext} 不是 DICOM（可用 .dcm 或無副檔名）")
    try:
        info = parse_dicom(data)
    except InvalidDicom as exc:
        return ImportFileResult(filename=name, status="failed", reason=str(exc))
    existing = _find_instance(session, project_id, info.sop_instance_uid)
    if existing is not None:
        # 不重送 Orthanc、不新增影像列（TC-B01-06）。上傳的檔案才有可供配對的路徑；PACS 取回的名稱是平台自己編的
        noted = store_in_orthanc and _remember_path(session, existing, name)
        return ImportFileResult(filename=name, status="duplicate",
                                reason=f"SOP Instance UID {info.sop_instance_uid} 已匯入"
                                       + ("；已補記來源路徑" if noted else ""))
    orthanc_id = ""
    if store_in_orthanc:
        try:
            orthanc_id = orthanc.store(data)
        except OrthancError as exc:
            return ImportFileResult(filename=name, status="failed", reason=str(exc))
    _index(session, project_id, info, source_path=name, orthanc_id=orthanc_id)
    return ImportFileResult(filename=name, status="imported")


def import_dicom(session: Session, orthanc: OrthancClient, *, project_id: int, actor: str,
                 files: Sequence[FileItem], source_ip: str | None = None) -> ImportJob:
    job = ImportJob(project_id=project_id, kind="dicom", status="running", created_by=actor)
    session.add(job)
    results = [_import_one_dicom(session, orthanc, project_id, clean_name(n), d) for n, d in files]
    resolve_pairings(session, project_id)
    return _finish_job(session, job, results, actor=actor, source_ip=source_ip)


# ---------- Accession 清單 ----------

ACCESSION = re.compile(r"^[A-Za-z0-9._\-]{1,16}$")   # DICOM SH：最多 16 字元；不允許萬用字元與反斜線
UID = re.compile(r"^[0-9]+(\.[0-9]+)*$")


def set_allowlist(session: Session, *, project_id: int, actor: str, accessions: Sequence[str],
                  source_ip: str | None = None) -> list[str]:
    wanted = sorted(set(accessions))
    bad = [a for a in wanted if not ACCESSION.match(a)]
    if bad:
        raise HTTPException(422, f"Accession 格式錯誤：{', '.join(bad[:5])}")
    session.execute(delete(AccessionAllowlist).where(AccessionAllowlist.project_id == project_id))
    session.add_all(AccessionAllowlist(project_id=project_id, accession_number=a) for a in wanted)
    record(session, actor=actor, category=AuditCategory.DATASET, action="imaging.set_allowlist",
           target=f"project:{project_id}", source_ip=source_ip, detail={"count": len(wanted)})
    session.commit()
    return wanted


# ---------- PACS 查詢取像 ----------

def pacs_query(session: Session, orthanc: OrthancClient, *, project_id: int, query: dict[str, str]) -> list[dict]:
    unknown = sorted(set(query) - QUERY_KEYS)
    if unknown:
        raise HTTPException(422, f"不支援的查詢欄位：{', '.join(unknown)}（可用 {', '.join(sorted(QUERY_KEYS))}）")
    try:
        answers = orthanc.pacs_find(query)
    except OrthancError as exc:
        raise HTTPException(502, f"PACS 查詢失敗：{exc}")
    allowed = allowlist(session, project_id)
    if allowed:
        answers = [a for a in answers if a.get("AccessionNumber") in allowed]
    return answers


def pacs_retrieve(session: Session, orthanc: OrthancClient, *, project_id: int, actor: str, study_uid: str,
                  source_ip: str | None = None) -> ImportJob:
    if not UID.match(study_uid) or len(study_uid) > 64:
        raise HTTPException(422, "Study Instance UID 格式錯誤")
    try:
        found = orthanc.pacs_find({"StudyInstanceUID": study_uid})
    except OrthancError as exc:
        raise HTTPException(502, f"PACS 查詢失敗：{exc}")
    if not found:
        raise HTTPException(404, f"PACS 找不到研究 {study_uid}")
    allowed = allowlist(session, project_id)
    if allowed and found[0].get("AccessionNumber") not in allowed:
        raise HTTPException(403, "此研究的 Accession 不在本專案清單內")
    try:
        orthanc.pacs_move(study_uid)
        instances = orthanc.study_instances(study_uid)
    except OrthancError as exc:
        raise HTTPException(502, f"PACS 取像失敗：{exc}")
    job = ImportJob(project_id=project_id, kind="pacs", status="running", created_by=actor)
    session.add(job)
    results = [_import_one_dicom(session, orthanc, project_id, f"pacs/{study_uid}/{i + 1}", data,
                                 store_in_orthanc=False) for i, data in enumerate(instances)]
    if not results:
        results = [ImportFileResult(filename=f"pacs/{study_uid}", status="failed", reason="取像後平台節點沒有影像")]
    resolve_pairings(session, project_id)
    return _finish_job(session, job, results, actor=actor, source_ip=source_ip,
                       extra={"study_instance_uid": study_uid})


# ---------- 研究查詢（5 欄位篩選、Accession 清單） ----------

_DATE = re.compile(r"^(\d{8})$|^(\d{8})?-(\d{8})?$")


def _like(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def list_studies(session: Session, project_id: int, *, modality: str | None = None, patient_sex: str | None = None,
                 study_description: str | None = None, study_date: str | None = None,
                 series_description: str | None = None) -> list[ImagingStudy]:
    q = (select(ImagingStudy).where(ImagingStudy.project_id == project_id)
         .options(selectinload(ImagingStudy.series)).order_by(ImagingStudy.study_date, ImagingStudy.id))
    allowed = allowlist(session, project_id)
    if allowed:
        q = q.where(ImagingStudy.accession_number.in_(allowed))
    if modality:
        q = q.where(ImagingStudy.series.any(func.upper(ImagingSeries.modality) == modality.strip().upper()))
    if patient_sex:
        q = q.where(func.upper(ImagingStudy.patient_sex) == patient_sex.strip().upper())
    if study_description:
        q = q.where(ImagingStudy.study_description.ilike(_like(study_description.strip()), escape="\\"))
    if series_description:
        q = q.where(ImagingStudy.series.any(
            ImagingSeries.series_description.ilike(_like(series_description.strip()), escape="\\")))
    if study_date:
        m = _DATE.match(study_date.strip())
        if not m:
            raise HTTPException(422, "study_date 格式需為 YYYYMMDD 或 YYYYMMDD-YYYYMMDD")
        if m.group(1):
            q = q.where(ImagingStudy.study_date == m.group(1))
        else:
            if m.group(2):
                q = q.where(ImagingStudy.study_date >= m.group(2))
            if m.group(3):
                q = q.where(ImagingStudy.study_date <= m.group(3))
    return list(session.scalars(q))


def find_accessible_study(session: Session, project_id: int, study_uid: str) -> ImagingStudy | None:
    """專案內且（若有清單）Accession 在清單內的研究；否則 None。網頁、API、DICOMweb 共用這一個判斷。"""
    study = session.scalar(select(ImagingStudy).where(ImagingStudy.project_id == project_id,
                                                      ImagingStudy.study_instance_uid == study_uid))
    if study is None:
        return None
    allowed = allowlist(session, project_id)
    if allowed and study.accession_number not in allowed:
        return None
    return study


def dicomweb_allowed(session: Session, target: DicomwebTarget) -> bool:
    study = find_accessible_study(session, target.project_id, target.study_uid)
    if study is None:
        return False
    if target.series_uid is None:
        return True
    series = session.scalar(select(ImagingSeries).where(ImagingSeries.study_id == study.id,
                                                        ImagingSeries.series_instance_uid == target.series_uid))
    if series is None:
        return False
    if target.instance_uid is None:
        return True
    return session.scalar(select(ImagingInstance.id).where(
        ImagingInstance.series_id == series.id, ImagingInstance.sop_instance_uid == target.instance_uid)) is not None


def _instance_counts(session: Session, series_ids: Iterable[int]) -> dict[int, int]:
    ids = list(series_ids)
    if not ids:
        return {}
    rows = session.execute(select(ImagingInstance.series_id, func.count()).where(ImagingInstance.series_id.in_(ids))
                           .group_by(ImagingInstance.series_id))
    return dict(rows.all())


def studies_to_dicts(session: Session, studies: Sequence[ImagingStudy]) -> list[dict]:
    counts = _instance_counts(session, (s.id for st in studies for s in st.series))
    out = []
    for st in studies:
        series = [{"series_instance_uid": s.series_instance_uid, "modality": s.modality,
                   "series_description": s.series_description, "instances": counts.get(s.id, 0)}
                  for s in st.series]
        out.append({
            "study_instance_uid": st.study_instance_uid, "accession_number": st.accession_number,
            "patient_id": st.patient_id, "patient_sex": st.patient_sex, "study_date": st.study_date,
            "study_description": st.study_description,
            "modalities": sorted({s["modality"] for s in series if s["modality"]}),
            "series": series, "instances": sum(s["instances"] for s in series),
        })
    return out


# ---------- 非 DICOM 檔案與配對 ----------

def _safe_basename(name: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]", "_", posixpath.basename(name)) or "file"
    return base.lstrip(".") or "file"


def _import_one_file(session: Session, store: ObjectStore, project_id: int, name: str, data: bytes | Oversize,
                     max_decompressed: int | None = None) -> ImportFileResult:
    if isinstance(data, (Oversize, Rejected)):
        return ImportFileResult(filename=name, status="failed", reason=data.reason)
    try:
        parsed = parse_file(name, data, max_decompressed=max_decompressed)
    except InvalidFile as exc:
        return ImportFileResult(filename=name, status="failed", reason=str(exc))
    digest = hashlib.sha256(data).hexdigest()
    existing = session.scalar(select(ImagingFile).where(ImagingFile.project_id == project_id,
                                                        ImagingFile.filename == name))
    if existing is not None:
        if existing.sha256 == digest:
            return ImportFileResult(filename=name, status="duplicate", reason="同名同內容的檔案已匯入")
        return ImportFileResult(filename=name, status="failed", reason="同名檔案已存在但內容不同，請改名後再匯入")
    f = ImagingFile(project_id=project_id, filename=name, format=parsed.format, role=parsed.role,
                    case=parsed.case, sha256=digest, meta=parsed.meta,
                    pairing="n/a" if parsed.role == "image" else "unpaired")
    session.add(f)
    session.flush()
    f.object_key = f"projects/{project_id}/imaging/files/{f.id}/{_safe_basename(name)}"
    try:
        store.put(f.object_key, data)
    except Exception as exc:  # 儲存失敗只影響這個檔
        session.delete(f)
        session.flush()
        return ImportFileResult(filename=name, status="failed", reason=f"物件儲存失敗：{type(exc).__name__}")
    return ImportFileResult(filename=name, status="imported")


def import_files(session: Session, store: ObjectStore, *, project_id: int, actor: str,
                 files: Sequence[FileItem], source_ip: str | None = None,
                 max_decompressed: int | None = None) -> ImportJob:
    job = ImportJob(project_id=project_id, kind="files", status="running", created_by=actor)
    session.add(job)
    results = [_import_one_file(session, store, project_id, clean_name(n), d, max_decompressed) for n, d in files]
    resolve_pairings(session, project_id)
    return _finish_job(session, job, results, actor=actor, source_ip=source_ip)


def _match_sop(sources: list[tuple[str, str]], file_name: str) -> list[str]:
    target = file_name.replace("\\", "/").lstrip("/")
    return sorted({sop for path, sop in sources if path == target or path.endswith("/" + target)})


def resolve_pairings(session: Session, project_id: int) -> None:
    """重新配對專案內所有未配對的標註；只看同一專案。先後順序不影響結果。"""
    labels = session.scalars(select(ImagingFile).where(ImagingFile.project_id == project_id,
                                                       ImagingFile.role == "label",
                                                       ImagingFile.pairing != "paired")).all()
    if not labels:
        return
    sources = None
    for label in labels:
        if label.format == "makesense":
            if sources is None:
                sources = list(session.execute(select(ImagingInstance.source_path, ImagingInstance.sop_instance_uid)
                                               .where(ImagingInstance.project_id == project_id)).all())
                sources += list(session.execute(
                    select(ImagingInstanceSource.source_path, ImagingInstance.sop_instance_uid)
                    .join(ImagingInstance, ImagingInstance.id == ImagingInstanceSource.instance_id)
                    .where(ImagingInstanceSource.project_id == project_id)).all())
            matched, missing, ambiguous = [], [], []
            for file_name in label.meta.get("file_names", []):
                sops = _match_sop(sources, file_name)
                if len(sops) == 1:
                    matched.append(sops[0])
                else:
                    (ambiguous if sops else missing).append(file_name)
            if not missing and not ambiguous:
                label.paired_sops, label.pairing, label.pairing_note = matched, "paired", ""
            else:
                label.paired_sops = matched
                label.pairing_note = (f"找不到 {len(missing)} 張影像" if missing else "") + \
                                     (f"；{len(ambiguous)} 張影像路徑不唯一" if ambiguous else "")
        else:
            images = session.scalars(select(ImagingFile).where(
                ImagingFile.project_id == project_id, ImagingFile.role == "image",
                ImagingFile.format == label.format, ImagingFile.case == label.case)).all()
            if len(images) == 1:
                label.paired_file_id, label.pairing, label.pairing_note = images[0].id, "paired", ""
            else:
                label.pairing_note = "尚未匯入對應影像" if not images else "對應影像不唯一"
    session.flush()


def list_files(session: Session, project_id: int) -> list[dict]:
    files = session.scalars(select(ImagingFile).where(ImagingFile.project_id == project_id)
                            .order_by(ImagingFile.id)).all()
    names = {f.id: f.filename for f in files}
    return [{"id": f.id, "filename": f.filename, "format": f.format, "role": f.role, "case": f.case,
             "meta": f.meta, "pairing": f.pairing, "pairing_note": f.pairing_note,
             "paired_image": names.get(f.paired_file_id) if f.paired_file_id else None,
             "paired_sop_instance_uids": f.paired_sops} for f in files]
