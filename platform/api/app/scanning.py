"""上傳檔案掃毒（D-01、TC-D01-06）。

- Scanner 是介面：ClamdScanner 連 ClamAV 的 clamd（INSTREAM 協定），FakeScanner 給單元測試，NoScanner 表示未設定。
- 掃毒服務連不上時拒絕上傳（fail closed），不會在沒掃過的情況下收檔。
- install(app)：設定 app.state.scanner、把物件儲存包一層（所有寫入都會掃）、註冊錯誤回應。
"""
import logging
import os
import socket
import struct
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Protocol

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.audit import AuditCategory, record
from app.storage import ObjectStore

log = logging.getLogger(__name__)
CHUNK = 1 << 20


@dataclass(frozen=True)
class ScanResult:
    clean: bool
    signature: str | None = None


class MalwareDetected(Exception):
    def __init__(self, name: str, signature: str):
        super().__init__(f"檔案 {name} 未通過掃毒（{signature}），已拒絕")
        self.name, self.signature = name, signature


class ScannerUnavailable(Exception):
    """掃毒服務連不上或回報錯誤。上傳一律拒絕。"""


class Scanner(Protocol):
    enabled: bool

    def scan(self, name: str, data: bytes) -> ScanResult: ...


class NoScanner:
    """未設定掃毒服務：不掃描。正式環境必須設定 CLAMAV_HOST。"""
    enabled = False

    def scan(self, name: str, data: bytes) -> ScanResult:
        return ScanResult(clean=True)


def eicar() -> bytes:
    """EICAR 標準測試字串（無害）。分段組合，避免原始碼本身被防毒軟體攔下。"""
    head = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$"
    tail = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
    return (head + tail).encode("ascii")


@dataclass
class FakeScanner:
    """記憶體版：內容含 EICAR 測試字串或指定的特徵就視為惡意。offline=True 模擬服務中斷。"""
    signatures: dict[bytes, str] = field(default_factory=dict)
    offline: bool = False
    enabled: bool = True
    scanned: list[str] = field(default_factory=list)

    def scan(self, name: str, data: bytes) -> ScanResult:
        if self.offline:
            raise ScannerUnavailable("掃毒服務無法連線")
        self.scanned.append(name)
        for pattern, signature in {eicar(): "Eicar-Signature", **self.signatures}.items():
            if pattern in data:
                return ScanResult(clean=False, signature=signature)
        return ScanResult(clean=True)


@dataclass
class ClamdScanner:
    host: str
    port: int = 3310
    timeout: float = 60.0
    enabled: bool = True

    def scan(self, name: str, data: bytes) -> ScanResult:
        try:
            with socket.create_connection((self.host, self.port), timeout=self.timeout) as sock:
                sock.sendall(b"zINSTREAM\0")
                for start in range(0, len(data), CHUNK):
                    chunk = data[start:start + CHUNK]
                    sock.sendall(struct.pack("!I", len(chunk)) + chunk)
                sock.sendall(struct.pack("!I", 0))
                reply = b""
                while not reply.endswith(b"\0"):
                    part = sock.recv(4096)
                    if not part:
                        break
                    reply += part
        except OSError as exc:
            raise ScannerUnavailable(f"掃毒服務無法連線（{type(exc).__name__}）") from exc
        text = reply.rstrip(b"\0").decode("utf-8", "replace").strip()
        if text.endswith("OK"):
            return ScanResult(clean=True)
        if text.endswith("FOUND"):
            return ScanResult(clean=False, signature=text.removeprefix("stream:").removesuffix("FOUND").strip())
        raise ScannerUnavailable(f"掃毒服務回報錯誤：{text or '沒有回應'}")


def scanner_from_env(env: Mapping[str, str]) -> Scanner:
    host = env.get("CLAMAV_HOST", "").strip()
    if not host:
        return NoScanner()
    return ClamdScanner(host=host, port=int(env.get("CLAMAV_PORT", 3310)),
                        timeout=float(env.get("CLAMAV_TIMEOUT_SECONDS", 60)))


def check(scanner: Scanner, name: str, data: bytes) -> None:
    result = scanner.scan(name, data)
    if not result.clean:
        raise MalwareDetected(name, result.signature or "unknown")


def ensure_clean(request: Request, name: str, data: bytes) -> None:
    """上傳端點用：不乾淨就丟 MalwareDetected（422），掃毒服務中斷丟 ScannerUnavailable（503）。"""
    check(request.app.state.scanner, name, data)


def blocked_reason(request: Request, name: str, data: bytes) -> str | None:
    """批次上傳用：回傳這個檔案被擋下的原因，乾淨則回 None。單檔被擋不影響同批其他檔。"""
    try:
        check(request.app.state.scanner, name, data)
    except MalwareDetected as exc:
        log.warning("掃毒攔截 %s：%s", name, exc.signature)
        return f"掃毒攔截：{exc.signature}"
    except ScannerUnavailable as exc:
        return f"未能掃毒，已拒絕：{exc}"
    return None


class ScanningObjectStore:
    """物件儲存外面包一層：寫入前先掃毒，其餘操作原樣轉交。"""

    def __init__(self, inner: ObjectStore, scanner: Callable[[], Scanner]):
        self.inner, self._scanner = inner, scanner

    def put(self, key: str, data: bytes) -> None:
        check(self._scanner(), key, data)
        self.inner.put(key, data)

    def __getattr__(self, name: str):
        return getattr(self.inner, name)


def _audit_block(request: Request, exc: MalwareDetected) -> None:
    actor = "unknown"
    auth = request.headers.get("authorization", "")
    try:
        actor = request.app.state.verifier.verify(auth[7:]).username
    except Exception:  # 身分無法確認也要留下紀錄
        pass
    forwarded = request.headers.get("x-forwarded-for")
    ip = forwarded.split(",")[-1].strip() if forwarded else (request.client.host if request.client else None)
    try:
        with request.app.state.sessionmaker() as session:
            record(session, actor=actor, category=AuditCategory.DATASET, action="malware_blocked",
                   target=exc.name[:128], result="rejected", source_ip=ip,
                   detail={"signature": exc.signature, "path": request.url.path})
            session.commit()
    except Exception:
        log.exception("掃毒攔截的稽核寫入失敗")


def install(app: FastAPI) -> None:
    app.state.scanner = scanner_from_env(os.environ)
    if not app.state.scanner.enabled:
        log.warning("未設定 CLAMAV_HOST：上傳檔案不會掃毒")
    if app.state.store is not None:
        app.state.store = ScanningObjectStore(app.state.store, lambda: app.state.scanner)

    @app.exception_handler(MalwareDetected)
    def _malware(request: Request, exc: MalwareDetected):
        _audit_block(request, exc)
        return JSONResponse(status_code=422, content={"detail": {
            "code": "malware_detected", "signature": exc.signature,
            "message": "檔案未通過掃毒，已拒絕上傳"}})

    @app.exception_handler(ScannerUnavailable)
    def _unavailable(request: Request, exc: ScannerUnavailable):
        return JSONResponse(status_code=503, content={"detail": f"掃毒服務暫時無法使用，為安全起見已拒絕上傳（{exc}）"})
