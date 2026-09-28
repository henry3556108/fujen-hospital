"""/api/projects/{project_id}/imaging/*：影像匯入、查詢、Accession 清單、PACS 查詢取像。"""
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile

from app.deps import ProjectContext, client_ip, require_project_permission
from app.imaging import service
from app.imaging.orthanc import OrthancClient
from app.permissions import Permission

router = APIRouter(prefix="/api/projects/{project_id}/imaging", tags=["imaging"])

can_read = require_project_permission(Permission.PROJECT)
can_import = require_project_permission(Permission.LABELING)


def get_orthanc(request: Request) -> OrthancClient:
    orthanc = getattr(request.app.state, "orthanc", None)
    if orthanc is None:
        raise HTTPException(503, "影像節點未設定")
    return orthanc


def _read_all(files: list[UploadFile]) -> list[tuple[str, bytes]]:
    # 同步端點在 threadpool 執行，不會卡住事件迴圈
    return [(f.filename or "", f.file.read()) for f in files]


@router.post("/dicom", status_code=201)
def upload_dicom(request: Request, files: list[UploadFile] = File(...),
                 ctx: ProjectContext = Depends(can_import),
                 orthanc: OrthancClient = Depends(get_orthanc)) -> dict:
    items = _read_all(files)
    job = service.import_dicom(ctx.session, orthanc, project_id=ctx.project.id, actor=ctx.user.username,
                               files=items, source_ip=client_ip(request))
    return service.job_to_dict(job)


@router.post("/files", status_code=201)
def upload_files(request: Request, files: list[UploadFile] = File(...),
                 ctx: ProjectContext = Depends(can_import)) -> dict:
    """NIfTI（.nii/.nii.gz）、ITK（.mha）、makesense（COCO .json）；存物件儲存並配對。"""
    items = _read_all(files)
    job = service.import_files(ctx.session, request.app.state.store, project_id=ctx.project.id,
                               actor=ctx.user.username, files=items, source_ip=client_ip(request))
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


@router.get("/studies/{study_uid}")
def get_study(study_uid: str, ctx: ProjectContext = Depends(can_read)) -> dict:
    study = service.find_accessible_study(ctx.session, ctx.project.id, study_uid)
    if study is None:
        raise HTTPException(404, "找不到研究，或不在本專案的 Accession 清單內")
    return service.studies_to_dicts(ctx.session, [study])[0]
