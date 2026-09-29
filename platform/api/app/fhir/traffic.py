"""Gateway 流量：每次 FHIR 存取寫一筆稽核，並以稽核筆數計算每分鐘流量；超過門檻建立告警並寄信。

以資料庫計數（不是程序內的計數器），所以平台 API 水平擴充成多份時結果一致。
"""
import logging
import os
import smtplib
from collections.abc import Mapping
from datetime import datetime, timedelta
from email.message import EmailMessage
from typing import Protocol

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.fhir.models import FhirTrafficAlert
from app.models import AuditLog, utcnow

log = logging.getLogger("fhir.traffic")
ACCESS_ACTION = "fhir.gateway.access"
WINDOW_SECONDS = 60


class Mailer(Protocol):
    def send(self, subject: str, body: str) -> None: ...


class InMemoryMailer:
    def __init__(self):
        self.sent: list[tuple[str, str]] = []
        self.fail = False

    def send(self, subject: str, body: str) -> None:
        if self.fail:
            raise OSError("SMTP 無法連線")
        self.sent.append((subject, body))


class SmtpMailer:
    def __init__(self, host: str, port: int, sender: str, recipients: list[str], timeout: float = 5.0):
        self.host, self.port, self.sender, self.recipients, self.timeout = host, port, sender, recipients, timeout

    def send(self, subject: str, body: str) -> None:
        message = EmailMessage()
        message["Subject"], message["From"], message["To"] = subject, self.sender, ", ".join(self.recipients)
        message.set_content(body)
        with smtplib.SMTP(self.host, self.port, timeout=self.timeout) as smtp:
            smtp.send_message(message)


def mailer_from_env(env: Mapping[str, str] = os.environ) -> Mailer | None:
    host = env.get("ALERT_SMTP_HOST", "").strip()
    recipients = [r.strip() for r in env.get("ALERT_EMAIL_TO", "").split(",") if r.strip()]
    if not host or not recipients:
        return None
    return SmtpMailer(host, int(env.get("ALERT_SMTP_PORT", "25")),
                      env.get("ALERT_EMAIL_FROM", "ai-platform@localhost"), recipients)


def record_access(session: Session, *, actor: str, project_id: int, method: str, path: str, allowed: bool,
                  reason: str | None, source_ip: str | None, threshold: int, mailer: Mailer | None,
                  now=utcnow) -> FhirTrafficAlert | None:
    """寫存取稽核並檢查流量。回傳這次新建立的告警（沒有就回 None）。呼叫端負責 commit。"""
    moment = now()
    prefix = f"project:{project_id}/"
    entry = record(session, actor=actor, category=AuditCategory.DATA_EXCHANGE, action=ACCESS_ACTION,
                   target=(prefix + path)[:128], result="success" if allowed else "denied", source_ip=source_ip,
                   detail={"method": method, "path": path[:512], **({"reason": reason} if reason else {})})
    entry.at = moment
    session.flush()
    count = session.scalar(
        select(func.count()).select_from(AuditLog).where(
            AuditLog.category == AuditCategory.DATA_EXCHANGE.value, AuditLog.action == ACCESS_ACTION,
            AuditLog.actor == actor, AuditLog.target.like(prefix + "%"),
            AuditLog.at > moment - timedelta(seconds=WINDOW_SECONDS)))
    if count <= threshold:
        return None
    window = moment.replace(second=0, microsecond=0)
    exists = session.scalar(select(FhirTrafficAlert.id).where(
        FhirTrafficAlert.project_id == project_id, FhirTrafficAlert.actor == actor,
        FhirTrafficAlert.window_start == window))
    if exists is not None:
        return None   # 同一分鐘已告警過：抑制重複
    alert = FhirTrafficAlert(project_id=project_id, actor=actor, window_start=window, request_count=count,
                             threshold=threshold, created_at=moment)
    try:
        with session.begin_nested():
            session.add(alert)
    except IntegrityError:
        return None   # 另一份 API 同時建立了同一筆告警
    alert.notified = _notify(mailer, alert, moment)
    return alert


def _notify(mailer: Mailer | None, alert: FhirTrafficAlert, moment: datetime) -> bool:
    if mailer is None:
        return False
    subject = f"[AI 平台] FHIR 流量異常：專案 {alert.project_id}、使用者 {alert.actor}"
    body = (f"時間：{moment.isoformat(timespec='seconds')}\n專案（租戶）：{alert.project_id}\n"
            f"使用者：{alert.actor}\n最近 {WINDOW_SECONDS} 秒請求數：{alert.request_count}\n"
            f"門檻：每分鐘 {alert.threshold} 次\n\n同一使用者在同一專案每分鐘只會通知一次。\n")
    try:
        mailer.send(subject, body)
        return True
    except Exception:   # 寄信失敗不能影響 Gateway 的授權判斷
        log.exception("流量告警寄信失敗")
        return False


def alert_out(a: FhirTrafficAlert) -> dict:
    return {"id": a.id, "project_id": a.project_id, "actor": a.actor, "window_start": a.window_start.isoformat(),
            "request_count": a.request_count, "threshold": a.threshold, "notified": a.notified,
            "created_at": a.created_at.isoformat()}
