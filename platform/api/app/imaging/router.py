"""/api/projects/{project_id}/imaging/*：影像匯入、查詢、Accession 清單、PACS 查詢取像。"""
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel

from app import scanning
from app.deps import ProjectContext, client_ip, require_project_permission
from app.imaging import service
from app.imaging.orthanc import OrthancClient
from app.permissions import AccountType, Permission

router = APIRouter(prefix="/api/projects/{project_id}/imaging", tags=["imaging"])

can_read = require_project_permission(Permission.PROJECT)
can_import = require_project_permission(Permission.LABELING)


def get_orthanc(request: Request) -> OrthancClient:
    orthanc = getattr(request.app.state, "orthanc", None)
    if orthanc is None:
        raise HTTPException(503, "影像節點未設定")
    return orthanc


def _read_all(files: list[UploadFile], limit: int, request: Request) -> list[service.FileItem]:
    """同步端點在 threadpool 執行，不會卡住事件迴圈。超過單檔上限的檔案不讀進記憶體，只記成該檔失敗。"""
    items = []
    for f in files:
        data = f.file.read(limit + 1)
        blocked = None if len(data) > limit else scanning.blocked_reason(request, f.filename or "", data)
        items.append((f.filename or "", service.Oversize(limit) if len(data) > limit
                      else service.Rejected(blocked) if blocked else data))
    return items


@router.post("/dicom", status_code=201)
def upload_dicom(request: Request, files: list[UploadFile] = File(...),
                 ctx: ProjectContext = Depends(can_import),
                 orthanc: OrthancClient = Depends(get_orthanc)) -> dict:
    items = _read_all(files, service.upload_limits(request.app.state)[0], request)
    job = service.import_dicom(ctx.session, orthanc, project_id=ctx.project.id, actor=ctx.user.username,
                               files=items, source_ip=client_ip(request))
    return service.job_to_dict(job)


@router.post("/files", status_code=201)
def upload_files(request: Request, files: list[UploadFile] = File(...),
                 ctx: ProjectContext = Depends(can_import)) -> dict:
    """NIfTI（.nii/.nii.gz）、ITK（.mha）、makesense（COCO .json）；存物件儲存並配對。"""
    max_file, max_decompressed = service.upload_limits(request.app.state)
    items = _read_all(files, max_file, request)
    job = service.import_files(ctx.session, request.app.state.store, project_id=ctx.project.id,
                               actor=ctx.user.username, files=items, source_ip=client_ip(request),
                               max_decompressed=max_decompressed)
    return service.job_to_dict(job)


@router.get("/files")
def list_files(ctx: ProjectContext = Depends(can_read)) -> list[dict]:
    return service.list_files(ctx.session, ctx.project.id)


@router.get("/jobs")
def list_jobs(ctx: ProjectContext = Depends(can_read)) -> list[dict]:
    return [service.job_to_dict(j, with_files=False) for j in service.list_jobs(ctx.session, ctx.project.id)]


@router.get("/jobs/{job_id}")
def get_job(job_id: int, ctx: ProjectContext = Depends(can_read)) -> dict:
    return service.job_to_dict(service.get_job(ctx.session, ctx.project.id, job_id))


@router.get("/studies")
def list_studies(modality: str | None = None, patient_sex: str | None = None, study_description: str | None = None,
                 study_date: str | None = None, series_description: str | None = None,
                 ctx: ProjectContext = Depends(can_read)) -> list[dict]:
    studies = service.list_studies(ctx.session, ctx.project.id, modality=modality, patient_sex=patient_sex,
                                   study_description=study_description, study_date=study_date,
                                   series_description=series_description)
    return service.studies_to_dicts(ctx.session, studies)


class AllowlistBody(BaseModel):
    accession_numbers: list[str]


class RetrieveBody(BaseModel):
    study_instance_uid: str


@router.get("/accession-allowlist")
def get_allowlist(ctx: ProjectContext = Depends(can_read)) -> dict:
    return {"accession_numbers": sorted(service.allowlist(ctx.session, ctx.project.id))}


@router.put("/accession-allowlist")
def put_allowlist(body: AllowlistBody, request: Request, ctx: ProjectContext = Depends(can_read)) -> dict:
    if ctx.user.account_type != AccountType.ADMIN:
        raise HTTPException(403, "需要 Admin 權限才能設定 Accession 清單")
    accessions = service.set_allowlist(ctx.session, project_id=ctx.project.id, actor=ctx.user.username,
                                       accessions=body.accession_numbers, source_ip=client_ip(request))
    return {"accession_numbers": accessions}


@router.post("/pacs/query")
def pacs_query(query: dict[str, str], ctx: ProjectContext = Depends(can_import),
               orthanc: OrthancClient = Depends(get_orthanc)) -> list[dict]:
    return service.pacs_query(ctx.session, orthanc, project_id=ctx.project.id, query=query)


@router.post("/pacs/retrieve", status_code=201)
def pacs_retrieve(body: RetrieveBody, request: Request, ctx: ProjectContext = Depends(can_import),
                  orthanc: OrthancClient = Depends(get_orthanc)) -> dict:
    job = service.pacs_retrieve(ctx.session, orthanc, project_id=ctx.project.id, actor=ctx.user.username,
                                study_uid=body.study_instance_uid, source_ip=client_ip(request))
    return service.job_to_dict(job)


@router.get("/studies/{study_uid}")
def get_study(study_uid: str, ctx: ProjectContext = Depends(can_read)) -> dict:
    study = service.find_accessible_study(ctx.session, ctx.project.id, study_uid)
    if study is None:
        raise HTTPException(404, "找不到研究，或不在本專案的 Accession 清單內")
    return service.studies_to_dicts(ctx.session, [study])[0]
