"""模型白名單、下載申請／審核／執行／刪除、遠端程式碼核准、載入設定（B-07、D-01）。"""
import hashlib
import shutil
import threading
import time
from datetime import timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.llm.errors import Conflict, Forbidden, Invalid, LlmServiceError, NotFound, Unavailable
from app.llm.models import InstalledModel, ModelDownload, ModelLoadConfig, ModelWhitelist, RemoteCodeApproval
from app.llm.runtime import LoadRequest, ModelRuntime, RuntimeLoadError, digests_path, write_digests
from app.llm.sources import (HF_SOURCE_HOST, ModelSource, SourceAuthError, SourceError, SourceIntegrityError, SourceListing,
                             SourceNotFound, SourceUnreachable)
from app.models import utcnow
from app.llm.util import iso

QUANTIZATIONS = ("none", "4bit", "8bit")
GPU_TYPES = ("gpu-exclusive", "gpu-shared", "cpu")
HEARTBEAT_SECONDS = 5.0                 # 背景下載多久寫一次進度
STALE_AFTER = timedelta(minutes=2)      # 進度超過這麼久沒更新＝下載程序已中斷（例：API 重啟）
_ACTIVE: set[int] = set()               # 這個程序內正在下載的申請編號


def token_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:12]


def whitelist_out(w: ModelWhitelist, installed: InstalledModel | None = None,
                  approval: RemoteCodeApproval | None = None) -> dict:
    return {"name": w.name, "source": w.source, "repo": w.repo, "revision": w.revision, "sha256": w.sha256,
            "license": w.license, "requires_token": w.requires_token, "has_remote_code": w.has_remote_code,
            "files": list(w.files or []), "note": w.note, "reviewed_by": w.reviewed_by,
            "created_at": iso(w.created_at),
            "installed": installed is not None, "loaded": bool(installed and installed.loaded),
            "remote_code_approved": bool(approval and approval.commit == w.revision)}


def download_out(d: ModelDownload) -> dict:
    return {"id": d.id, "project_id": d.project_id, "name": d.name, "source": d.source, "repo": d.repo,
            "status": d.status, "user": d.requested_by, "requested_at": iso(d.requested_at),
            "reviewer": d.reviewer, "reviewed_at": iso(d.reviewed_at), "commit": d.commit, "hash": d.sha256,
            "mode": d.mode, "token_usage": d.token_usage, "time": iso(d.downloaded_at), "message": d.message,
            "progress": d.progress}


def load_config_out(c: ModelLoadConfig) -> dict:
    return {"name": c.name, "quantization": c.quantization, "cpu": c.cpu, "memory_gb": c.memory_gb,
            "gpu_type": c.gpu_type, "gpu_count": c.gpu_count, "updated_by": c.updated_by,
            "updated_at": iso(c.updated_at)}


# ---------------------------------------------------------------- 白名單（Admin）

def list_catalog(session: Session) -> list[dict]:
    installed = {m.name: m for m in session.scalars(select(InstalledModel))}
    approvals = {a.name: a for a in session.scalars(select(RemoteCodeApproval))}
    return [whitelist_out(w, installed.get(w.name), approvals.get(w.name))
            for w in session.scalars(select(ModelWhitelist).order_by(ModelWhitelist.name))]


def add_whitelist(session: Session, *, actor: str, source_ip: str | None, name: str, source: str, repo: str,
                  revision: str, sha256: str, license: str = "", requires_token: bool = False,
                  has_remote_code: bool = False, note: str = "", files: list[str] | None = None) -> ModelWhitelist:
    if session.scalar(select(ModelWhitelist).where(ModelWhitelist.name == name)):
        raise Conflict(f"白名單已有模型 {name}")
    entry = ModelWhitelist(name=name, source=source, repo=repo, revision=revision, sha256=sha256.lower(),
                           license=license, requires_token=requires_token, has_remote_code=has_remote_code,
                           note=note, files=list(files or []), reviewed_by=actor)
    session.add(entry)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="llm.whitelist.add", target=f"model:{name}",
           source_ip=source_ip, detail={"source": source, "repo": repo, "revision": revision, "sha256": sha256,
                                        "files": list(files or [])})
    session.commit()
    return entry


def remove_whitelist(session: Session, *, actor: str, source_ip: str | None, name: str) -> None:
    entry = _whitelisted(session, name)
    if session.scalar(select(InstalledModel).where(InstalledModel.name == name)):
        raise Conflict(f"模型 {name} 仍在平台上，請先刪除模型再移出白名單")
    session.delete(entry)
    for approval in session.scalars(select(RemoteCodeApproval).where(RemoteCodeApproval.name == name)):
        session.delete(approval)
    record(session, actor=actor, category=AuditCategory.PROJECT, action="llm.whitelist.remove",
           target=f"model:{name}", source_ip=source_ip)
    session.commit()


def _source_errors(exc: SourceError) -> LlmServiceError:
    if isinstance(exc, SourceAuthError):
        return Forbidden(str(exc), code="token_rejected")
    if isinstance(exc, SourceNotFound):
        return NotFound(str(exc))
    if isinstance(exc, SourceIntegrityError):
        return Conflict(str(exc))
    return Unavailable(str(exc) or "無法連到模型來源")


def inspect_source(sources: dict[str, ModelSource], *, repo: str, source: str = "", revision: str = "",
                   token: str | None = None, files: list[str] | None = None) -> dict:
    """審核時查看來源上的內容（commit、hash、是否夾帶程式碼、檔案大小），供管理者填白名單。只讀中繼資料，不下載大檔。"""
    # 網頁只填模型名稱：來源取平台設定的（優先 Hugging Face），版本取目前最新的 commit
    source = source or (HF_SOURCE_HOST if HF_SOURCE_HOST in sources else next(iter(sources), ""))
    client = sources.get(source)
    if client is None:
        raise Unavailable(f"平台沒有設定模型來源 {source}")
    try:
        listing = client.inspect(repo, revision or client.latest_commit(repo, token), token, files or [])
    except SourceError as exc:
        raise _source_errors(exc)
    return {"source": source, "repo": repo, "commit": listing.commit, "sha256": listing.sha256,
            "has_remote_code": listing.has_remote_code, "gated": listing.gated, "files": sorted(listing.digests),
            "sizes": dict(listing.sizes), "total_bytes": listing.total_bytes}


def _whitelisted(session: Session, name: str) -> ModelWhitelist:
    entry = session.scalar(select(ModelWhitelist).where(ModelWhitelist.name == name))
    if entry is None:
        raise NotFound(f"白名單沒有模型 {name}")
    return entry


# ---------------------------------------------------------------- 下載

def request_download(session: Session, *, actor: str, source_ip: str | None, project_id: int | None,
                     name: str | None = None, source: str | None = None, repo: str | None = None) -> ModelDownload:
    query = select(ModelWhitelist)
    if name:
        query = query.where(ModelWhitelist.name == name)
    elif source and repo:
        query = query.where(ModelWhitelist.source == source, ModelWhitelist.repo == repo)
    else:
        raise Invalid("請指定模型名稱，或來源與 repo")
    entry = session.scalar(query)
    requested = name or f"{source}/{repo}"
    if entry is None:
        # 白名單外的下載一律拒絕，並留下稽核
        record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.download.request",
               target=f"model:{requested}"[:128], result="denied", source_ip=source_ip,
               detail={"reason": "not_whitelisted", "source": source, "repo": repo})
        session.commit()
        raise Forbidden(f"{requested} 不在模型白名單內，不可下載", code="not_whitelisted")
    if session.scalar(select(InstalledModel).where(InstalledModel.name == entry.name)):
        raise Conflict(f"模型 {entry.name} 已在平台上")
    open_request = session.scalar(select(ModelDownload).where(
        ModelDownload.name == entry.name, ModelDownload.status.in_(("pending", "approved", "downloading"))))
    if open_request:
        raise Conflict(f"模型 {entry.name} 已有進行中的下載申請（編號 {open_request.id}）")
    download = ModelDownload(project_id=project_id, name=entry.name, source=entry.source, repo=entry.repo,
                             status="pending", requested_by=actor)
    session.add(download)
    session.flush()
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.download.request",
           target=f"model:{entry.name}", source_ip=source_ip, detail={"download_id": download.id})
    session.commit()
    return download


def _download(session: Session, download_id: int) -> ModelDownload:
    download = session.get(ModelDownload, download_id)
    if download is None:
        raise NotFound(f"找不到下載申請 {download_id}")
    return download


def review_download(session: Session, *, actor: str, source_ip: str | None, download_id: int, approve: bool,
                    reason: str = "") -> ModelDownload:
    download = _download(session, download_id)
    if download.status != "pending":
        raise Conflict(f"下載申請 {download_id} 目前是 {download.status}，不能再審核")
    _whitelisted(session, download.name)
    download.status = "approved" if approve else "rejected"
    download.reviewer, download.reviewed_at, download.message = actor, utcnow(), reason
    record(session, actor=actor, category=AuditCategory.INFERENCE,
           action="llm.model.download.approve" if approve else "llm.model.download.reject",
           target=f"model:{download.name}", source_ip=source_ip,
           detail={"download_id": download.id, "requested_by": download.requested_by, "reason": reason})
    session.commit()
    return download


def _stale(download: ModelDownload) -> bool:
    if download.status != "downloading" or download.id in _ACTIVE:
        return False
    updated = (download.progress or {}).get("updated_at")
    if not updated:
        return True
    from datetime import datetime
    return utcnow() - datetime.fromisoformat(updated) > STALE_AFTER


class _Transfer:
    """下載的慢的部分（網路、寫檔、核對 hash），不碰資料庫；收尾（安裝、寫紀錄）由 finish 做。
    請求執行緒等不到完成時改成 detach：由背景執行緒自己開連線收尾，並定期寫進度。"""

    def __init__(self, *, services, entry: ModelWhitelist, download_id: int, token: str | None):
        self.services, self.download_id, self.token = services, download_id, token
        self.name, self.source, self.repo = entry.name, entry.source, entry.repo
        self.revision, self.sha256, self.files = entry.revision, entry.sha256, list(entry.files or [])
        self.staging = Path(services.model_dir) / ".staging" / str(download_id)
        self.listing: SourceListing | None = None
        self.mode = "online"
        self.error: Exception | None = None
        self.progress = {"done": 0, "total": None}
        self._lock = threading.Lock()
        self._done = False
        self._detached = False
        self._last_beat = time.monotonic()

    # ---- 背景執行緒
    def run(self) -> None:
        _ACTIVE.add(self.download_id)
        try:
            self._transfer()
        except Exception as exc:  # noqa: BLE001  所有錯誤都要回報給申請人
            self.error = exc
            shutil.rmtree(self.staging, ignore_errors=True)
        with self._lock:
            self._done = True
            detached = self._detached
        if detached:
            self._finish_detached()
        _ACTIVE.discard(self.download_id)

    def _on_progress(self, done: int, total: int) -> None:
        self.progress = {"done": done, "total": total}
        if self._detached and time.monotonic() - self._last_beat >= HEARTBEAT_SECONDS:
            self._last_beat = time.monotonic()
            with self.services.session_factory() as session:
                download = session.get(ModelDownload, self.download_id)
                download.progress = {**self.progress, "updated_at": utcnow().isoformat()}
                session.commit()

    def _transfer(self) -> None:
        shutil.rmtree(self.staging, ignore_errors=True)
        self.staging.mkdir(parents=True)
        client = self.services.sources.get(self.source)
        listing = None
        if client is not None:
            try:
                listing = client.download(self.repo, self.revision, self.token, self.staging, self.files,
                                          progress=self._on_progress)
            except SourceUnreachable:
                listing = None
            except SourceError as exc:
                raise _source_errors(exc)
        if listing is None:
            # 無對外網路：改用離線預載目錄，Token 不會送出
            self.mode = "offline"
            offline = self.services.offline
            located = offline.locate(self.name, self.files) if offline else None
            if located is None:
                raise Unavailable(f"無法連到模型來源，離線預載目錄也沒有 {self.name}")
            listing, folder = located
            self._verify(listing)
            offline.copy(listing, folder, self.staging)
        self._verify(listing)
        self.listing = listing

    def _verify(self, listing: SourceListing) -> None:
        if listing.commit != self.revision or listing.repo != self.repo:
            raise Conflict(f"取得的版本 {listing.repo}@{listing.commit} 與白名單登記的不同")
        if listing.sha256 != self.sha256:
            raise Conflict("模型內容的 hash 與白名單登記的不同，已拒絕")

    def _finish_detached(self) -> None:
        with self.services.session_factory() as session:
            try:
                self.finish(session)
            except LlmServiceError:
                pass        # 失敗已寫進下載紀錄與稽核

    # ---- 請求執行緒
    def wait(self, thread: threading.Thread, timeout: float | None) -> bool:
        """回傳 True＝已完成，由呼叫端收尾；False＝改由背景收尾。"""
        thread.join(timeout)
        with self._lock:
            if self._done:
                return True
            self._detached = True
            return False

    def finish(self, session: Session) -> ModelDownload:
        download = _download(session, self.download_id)
        usage = dict(download.token_usage or {})
        if self.mode == "offline" and usage.get("used"):
            usage.update(result="not_sent_offline")
        if self.error is not None:
            if isinstance(self.error, Forbidden):
                usage.update(result="rejected")
            _fail(session, download, self._actor or download.requested_by, self._source_ip, usage, str(self.error))
            if isinstance(self.error, LlmServiceError):
                raise self.error
            raise Unavailable(f"下載失敗：{self.error}")
        listing = self.listing
        target = Path(self.services.model_dir) / self.name
        if target.exists():
            shutil.rmtree(target)
        self.staging.replace(target)
        write_digests(target, listing.digests)
        entry = _whitelisted(session, self.name)
        download.status, download.mode = "completed", self.mode
        download.commit, download.sha256 = listing.commit, listing.sha256
        download.token_usage, download.downloaded_at, download.message = usage, utcnow(), ""
        download.progress = {"done": listing.total_bytes, "total": listing.total_bytes,
                             "updated_at": utcnow().isoformat()}
        session.add(InstalledModel(name=self.name, download_id=download.id, commit=listing.commit,
                                   sha256=listing.sha256, location=str(target),
                                   has_remote_code=listing.has_remote_code or entry.has_remote_code,
                                   installed_by=download.requested_by))
        record(session, actor=self._actor, category=AuditCategory.INFERENCE, action="llm.model.download",
               target=f"model:{self.name}", source_ip=self._source_ip,
               detail={"download_id": download.id, "commit": listing.commit, "sha256": listing.sha256,
                       "mode": self.mode, "reviewer": download.reviewer, "files": sorted(listing.digests),
                       "bytes": listing.total_bytes, "token_fingerprint": usage.get("fingerprint")})
        session.commit()
        return download

    _actor = ""
    _source_ip: str | None = None


def execute_download(session: Session, *, services, actor: str, is_admin: bool, source_ip: str | None,
                     download_id: int, token: str | None) -> ModelDownload:
    download = _download(session, download_id)
    if download.requested_by != actor and not is_admin:
        raise Forbidden("只有申請人或管理者可以執行這筆下載")
    if download.status == "downloading" and not _stale(download):
        raise Conflict(f"下載申請 {download_id} 正在下載中")
    if download.status not in ("approved", "downloading"):
        raise Conflict(f"下載申請 {download_id} 目前是 {download.status}，需先經管理者核准")
    entry = _whitelisted(session, download.name)
    if entry.requires_token and not token:
        raise Invalid("這個模型需要 Token")

    usage = {"used": False, "fingerprint": None, "purpose": "download", "source": entry.source,
             "used_at": None, "result": "not_required"}
    if token:
        usage.update(used=True, fingerprint=token_fingerprint(token), used_at=utcnow().isoformat(), result="accepted")
    download.status, download.token_usage, download.message = "downloading", usage, ""
    download.progress = {"done": 0, "total": None, "updated_at": utcnow().isoformat()}
    session.commit()

    transfer = _Transfer(services=services, entry=entry, download_id=download.id, token=token)
    transfer._actor, transfer._source_ip = actor, source_ip
    thread = threading.Thread(target=transfer.run, name=f"llm-download-{download.id}", daemon=True)
    thread.start()
    wait = services.download_wait if services.session_factory is not None else None
    if transfer.wait(thread, wait):
        return transfer.finish(session)
    session.refresh(download)
    return download


def _fail(session: Session, download: ModelDownload, actor: str, source_ip: str | None, usage: dict,
          message: str) -> None:
    """下載失敗：申請回到 approved 可再試一次，另外留下稽核。"""
    download.status = "approved"
    download.token_usage, download.message = usage, message[:512]
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.download",
           target=f"model:{download.name}", result="failed", source_ip=source_ip,
           detail={"download_id": download.id, "reason": message[:200], "token_fingerprint": usage.get("fingerprint")})
    session.commit()


def list_downloads(session: Session, *, project_id: int | None = None) -> list[ModelDownload]:
    query = select(ModelDownload).order_by(ModelDownload.id)
    if project_id is not None:
        query = query.where(ModelDownload.project_id == project_id)
    downloads = list(session.scalars(query))
    stale = [d for d in downloads if _stale(d)]
    for download in stale:
        download.status, download.message = "approved", "下載中斷（服務重新啟動），請重新執行下載"
    if stale:
        session.commit()
    return downloads


def _installed(session: Session, name: str) -> InstalledModel:
    model = session.scalar(select(InstalledModel).where(InstalledModel.name == name))
    if model is None:
        raise NotFound(f"平台上沒有模型 {name}")
    return model


def delete_model(session: Session, *, runtime: ModelRuntime, actor: str, is_admin: bool, source_ip: str | None,
                 name: str) -> None:
    model = _installed(session, name)
    if model.installed_by != actor and not is_admin:
        raise Forbidden("只有下載這個模型的人或管理者可以刪除")
    _runtime(lambda: runtime.unload(name))
    shutil.rmtree(model.location, ignore_errors=True)
    digests_path(Path(model.location)).unlink(missing_ok=True)
    session.delete(model)
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.delete",
           target=f"model:{name}", source_ip=source_ip, detail={"commit": model.commit, "sha256": model.sha256})
    session.commit()


# ---------------------------------------------------------------- 遠端程式碼核准、載入設定、載入

def approve_remote_code(session: Session, *, actor: str, source_ip: str | None, name: str) -> RemoteCodeApproval:
    entry = _whitelisted(session, name)
    approval = session.scalar(select(RemoteCodeApproval).where(RemoteCodeApproval.name == name))
    if approval is None:
        approval = RemoteCodeApproval(name=name, commit=entry.revision, approved_by=actor)
        session.add(approval)
    else:
        approval.commit, approval.approved_by, approval.approved_at = entry.revision, actor, utcnow()
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.remote_code.approve",
           target=f"model:{name}", source_ip=source_ip, detail={"commit": entry.revision})
    session.commit()
    return approval


def revoke_remote_code(session: Session, *, actor: str, source_ip: str | None, name: str) -> None:
    approval = session.scalar(select(RemoteCodeApproval).where(RemoteCodeApproval.name == name))
    if approval is None:
        raise NotFound(f"模型 {name} 沒有遠端程式碼核准紀錄")
    session.delete(approval)
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.remote_code.revoke",
           target=f"model:{name}", source_ip=source_ip)
    session.commit()


def get_load_config(session: Session, name: str, *, actor: str = "") -> ModelLoadConfig:
    _whitelisted(session, name)
    config = session.scalar(select(ModelLoadConfig).where(ModelLoadConfig.name == name))
    return config or ModelLoadConfig(name=name, quantization="none", cpu=4, memory_gb=16,
                                     gpu_type="gpu-exclusive", gpu_count=1, updated_by=actor, updated_at=None)


def put_load_config(session: Session, *, actor: str, source_ip: str | None, name: str, quantization: str, cpu: int,
                    memory_gb: int, gpu_type: str, gpu_count: int) -> ModelLoadConfig:
    _whitelisted(session, name)
    if quantization not in QUANTIZATIONS:
        raise Invalid(f"量化方式只能是 {'、'.join(QUANTIZATIONS)}")
    if gpu_type not in GPU_TYPES:
        raise Invalid(f"GPU 類型只能是 {'、'.join(GPU_TYPES)}")
    if gpu_type == "cpu" and gpu_count:
        raise Invalid("GPU 類型為 cpu 時 GPU 張數必須是 0")
    if gpu_type != "cpu" and gpu_count < 1:
        raise Invalid("使用 GPU 時至少需要 1 張")
    config = session.scalar(select(ModelLoadConfig).where(ModelLoadConfig.name == name))
    if config is None:
        config = ModelLoadConfig(name=name, updated_by=actor)
        session.add(config)
    config.quantization, config.cpu, config.memory_gb = quantization, cpu, memory_gb
    config.gpu_type, config.gpu_count = gpu_type, gpu_count
    config.updated_by, config.updated_at = actor, utcnow()
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.load_config",
           target=f"model:{name}", source_ip=source_ip,
           detail={"quantization": quantization, "cpu": cpu, "memory_gb": memory_gb, "gpu_type": gpu_type,
                   "gpu_count": gpu_count})
    session.commit()
    return config


def _runtime(action):
    try:
        return action()
    except RuntimeLoadError as exc:
        raise (Invalid(str(exc)) if exc.invalid else Unavailable(str(exc)))


def load_model(session: Session, *, runtime: ModelRuntime, actor: str, source_ip: str | None, name: str) -> dict:
    model = _installed(session, name)
    entry = _whitelisted(session, name)
    trust = False
    if model.has_remote_code:
        approval = session.scalar(select(RemoteCodeApproval).where(RemoteCodeApproval.name == name))
        if approval is None or approval.commit != model.commit:
            # 預設不執行模型夾帶的程式碼
            record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.load",
                   target=f"model:{name}", result="denied", source_ip=source_ip,
                   detail={"reason": "remote_code_not_approved", "commit": model.commit})
            session.commit()
            raise Forbidden(f"模型 {name} 夾帶程式碼，需管理者核准後才能載入", code="remote_code_not_approved")
        trust = True
    config = get_load_config(session, name, actor=actor)
    request = LoadRequest(name=name, location=model.location, quantization=config.quantization, cpu=config.cpu,
                          memory_gb=config.memory_gb, gpu_type=config.gpu_type, gpu_count=config.gpu_count,
                          trust_remote_code=trust)
    try:
        _runtime(lambda: runtime.load(request))
    except LlmServiceError as exc:
        record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.load",
               target=f"model:{name}", result="failed", source_ip=source_ip,
               detail={"reason": str(exc)[:200], "quantization": config.quantization})
        session.commit()
        raise
    model.loaded = True
    actual = _runtime(lambda: runtime.describe(name))
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.load", target=f"model:{name}",
           source_ip=source_ip, detail={"commit": model.commit, "quantization": config.quantization,
                                        "trust_remote_code": trust, "revision": entry.revision,
                                        "runtime": actual})
    session.commit()
    return {"name": name, "loaded": True, "trust_remote_code": trust, "config": load_config_out(config),
            "runtime": actual}


def describe_model(session: Session, *, runtime: ModelRuntime, name: str) -> dict:
    """平台記錄的載入設定與模型服務實際狀態並列，供核對「配置值與設定一致」。"""
    model = _installed(session, name)
    config = get_load_config(session, name)
    return {"name": name, "loaded": model.loaded, "config": load_config_out(config),
            "runtime": _runtime(lambda: runtime.describe(name)) if model.loaded else None}


def unload_model(session: Session, *, runtime: ModelRuntime, actor: str, source_ip: str | None, name: str) -> dict:
    model = _installed(session, name)
    _runtime(lambda: runtime.unload(name))
    model.loaded = False
    record(session, actor=actor, category=AuditCategory.INFERENCE, action="llm.model.unload",
           target=f"model:{name}", source_ip=source_ip)
    session.commit()
    return {"name": name, "loaded": False}
