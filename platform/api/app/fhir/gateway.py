"""FHIR REST 經 Gateway 的授權（forward-auth）與受管路由政策。

對外路徑 /fhir/projects/{pid}/{FHIR 路徑} → HAPI /fhir/{pid}/{FHIR 路徑}。pid 只能是數字，
所以到不了 HAPI 的 DEFAULT 分割區（分割區管理等系統層級操作都在那裡）。
只開放固定形式的 FHIR 互動與兩個操作（$validate、$everything）；其他一律拒絕。
"""
import os
import re
from dataclasses import dataclass
from pathlib import Path

import yaml
from fastapi import HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.authz import _canonical, effective_permissions
from app.deps import client_ip
from app.fhir import traffic
from app.fhir.models import GatewayRoutePolicy
from app.fhir.resources import SUPPORTED_TYPES
from app.models import Project, User, utcnow
from app.permissions import AccountType, Permission

FHIR_ROUTE = "fhir-rest"
ALL_METHODS = ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE")
DEFAULT_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE"]
_READ_METHODS = {"GET", "HEAD"}

_TYPE = "(?:" + "|".join(SUPPORTED_TYPES) + ")"
_ID = r"[A-Za-z0-9\-.]{1,64}"
_FHIR = re.compile(
    rf"^/fhir/projects/(?P<pid>\d+)(?:/(?P<rest>"
    rf"metadata"
    rf"|(?P<type>{_TYPE})(?:/(?P<op1>_search|\$validate)"
    rf"|/(?P<id>{_ID})(?:/(?P<op2>_history(?:/{_ID})?|\$everything|\$validate))?)?"
    rf"))?$")


@dataclass(frozen=True)
class FhirTarget:
    project_id: int
    path: str            # 專案之後的 FHIR 路徑；空字串＝租戶根（Transaction）
    interaction: str     # read | write

    @property
    def is_write(self) -> bool:
        return self.interaction == "write"


def match_fhir(uri: str, method: str) -> FhirTarget | None:
    """原始 URI 與方法 → 目標；不是允許的形式回 None（呼叫端預設拒絕）。"""
    path, _, query = uri.partition("?")
    normalized = _canonical(path)
    if normalized is None or any(c in query for c in ("\x00", "#", ";", "\\")):
        return None
    m = _FHIR.match(normalized)
    method = method.upper()
    if not m or method not in ALL_METHODS:
        return None
    rest, operation = m["rest"] or "", m["op1"] or m["op2"] or ""
    if rest == "metadata":
        return FhirTarget(int(m["pid"]), rest, "read") if method in _READ_METHODS else None
    if rest == "":   # 租戶根只接受 POST（Transaction／Batch）
        return FhirTarget(int(m["pid"]), rest, "write") if method == "POST" else None
    if operation == "$everything" and m["type"] != "Patient":
        return None
    if operation in ("_search", "$validate"):
        return FhirTarget(int(m["pid"]), rest, "read") if method == "POST" else None
    if operation:    # _history、$everything 只能讀
        return FhirTarget(int(m["pid"]), rest, "read") if method in _READ_METHODS else None
    if method in _READ_METHODS:
        return FhirTarget(int(m["pid"]), rest, "read")
    if m["id"] is None and method != "POST":   # 型別層級只能搜尋或建立
        return None
    if m["id"] is not None and method == "POST":
        return None
    return FhirTarget(int(m["pid"]), rest, "write")


# ---------- 受管路由政策 ----------

def ensure_policy(session: Session) -> GatewayRoutePolicy:
    policy = session.scalar(select(GatewayRoutePolicy).where(GatewayRoutePolicy.route_id == FHIR_ROUTE))
    if policy is None:
        policy = GatewayRoutePolicy(
            route_id=FHIR_ROUTE, description="FHIR REST（外部系統存取各專案租戶的 FHIR 資料）",
            uri="/fhir/projects/*", upstream="hapi:8080", enabled=True, methods=list(DEFAULT_METHODS),
            alert_threshold_per_minute=int(os.environ.get("FHIR_ALERT_THRESHOLD", "120")))
        session.add(policy)
        session.commit()
    return policy


def policy_out(p: GatewayRoutePolicy) -> dict:
    return {"id": p.route_id, "managed": True, "description": p.description, "uri": p.uri,
            "upstream": [p.upstream], "enabled": p.enabled, "methods": list(p.methods),
            "alert_threshold_per_minute": p.alert_threshold_per_minute, "plugins": ["forward-auth"],
            "updated_by": p.updated_by, "updated_at": p.updated_at.isoformat() if p.updated_at else None}


def _static_route_ids(path: str | None = None) -> set[str]:
    return {r["_config_id"] for r in _read_static(path)}


def static_routes(path: str | None = None) -> list[dict]:
    """部署設定檔（APISIX standalone 的 apisix.yaml）裡的路由，唯讀。只回傳路由的形狀，
    不回傳外掛設定：裡面有 Gateway 連上游用的認證。

    靜態路由以路徑當識別（id＝uri），不回傳設定檔裡的路由名稱：名稱是自由文字，可能剛好等於某個帳號或金鑰
    （本機環境 MinIO 的存取帳號就叫 platform-api，與 /api/* 路由同名），TC-SS-04 的外洩掃描會把它當成外洩。"""
    return [{k: v for k, v in r.items() if k != "_config_id"} for r in _read_static(path)]


def _read_static(path: str | None = None) -> list[dict]:
    path = path or os.environ.get("GATEWAY_ROUTES_FILE", "")
    if not path or not Path(path).is_file():
        return []
    try:
        text = Path(path).read_text(encoding="utf-8").replace("\n#END", "\n")
        routes = (yaml.safe_load(text) or {}).get("routes") or []
    except (OSError, yaml.YAMLError):
        return []
    out = []
    for route in routes:
        if not isinstance(route, dict):
            continue
        upstream = route.get("upstream") or {}
        nodes = upstream.get("nodes") or {}
        targets = sorted(nodes) if isinstance(nodes, dict) else []
        if upstream.get("service_name"):
            targets.append(str(upstream["service_name"]))
        uri = route.get("uri") or ", ".join(route.get("uris") or [])
        out.append({"_config_id": str(route.get("id", "")), "id": uri, "managed": False, "description": "",
                    "uri": uri, "upstream": targets,
                    "enabled": True, "methods": route.get("methods") or list(ALL_METHODS),
                    "alert_threshold_per_minute": None, "plugins": sorted(route.get("plugins") or {}),
                    "updated_by": None, "updated_at": None})
    return out


def list_routes(session: Session) -> list[dict]:
    managed = policy_out(ensure_policy(session))
    static = [r for r in _read_static() if r["_config_id"] != FHIR_ROUTE]
    static = [{k: v for k, v in r.items() if k != "_config_id"} for r in static]
    return [managed] + static


class RouteError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code, self.message = status_code, message


def update_route(session: Session, route_id: str, *, actor: str, source_ip: str | None,
                 enabled: bool | None = None, methods: list[str] | None = None,
                 alert_threshold_per_minute: int | None = None) -> dict:
    policy = ensure_policy(session)
    if route_id != FHIR_ROUTE:
        if route_id in _static_route_ids() or any(r["id"] == route_id for r in static_routes()):
            raise RouteError(409, f"路由 {route_id} 是部署設定檔內的靜態路由，請修改設定檔後重新部署")
        raise RouteError(404, f"找不到路由 {route_id}")
    changes: dict = {}
    if enabled is not None and enabled != policy.enabled:
        policy.enabled = changes["enabled"] = enabled
    if methods is not None:
        cleaned = list(dict.fromkeys(m.upper() for m in methods))
        if not cleaned or any(m not in ALL_METHODS for m in cleaned):
            raise RouteError(422, f"methods 至少一個，且只能是 {'、'.join(ALL_METHODS)}")
        if cleaned != list(policy.methods):
            policy.methods = changes["methods"] = cleaned
    if alert_threshold_per_minute is not None:
        if not 1 <= alert_threshold_per_minute <= 100000:
            raise RouteError(422, "alert_threshold_per_minute 必須介於 1 與 100000")
        if alert_threshold_per_minute != policy.alert_threshold_per_minute:
            policy.alert_threshold_per_minute = changes["alert_threshold_per_minute"] = alert_threshold_per_minute
    if changes:
        policy.updated_by, policy.updated_at = actor, utcnow()
        record(session, actor=actor, category=AuditCategory.DATA_EXCHANGE, action="fhir.gateway.route.update",
               target=f"gateway-route:{route_id}", source_ip=source_ip, detail=changes)
        session.commit()
    return policy_out(policy)


# ---------- forward-auth ----------

def check_fhir(request: Request, uri: str, user: User, session: Session) -> Response:
    """每次判斷都寫稽核（允許與拒絕都寫）。路徑形式不合法時不知道是哪個專案，只回 403 不寫稽核。"""
    method = request.headers.get("x-forwarded-method", "GET").upper()
    target = match_fhir(uri, method)
    if target is None:
        raise HTTPException(403, "此路徑未開放")
    policy = ensure_policy(session)
    reason = _deny_reason(session, user, target, method, policy)
    mailer = _mailer(request)
    if session.get(Project, target.project_id) is not None:
        traffic.record_access(session, actor=user.username, project_id=target.project_id, method=method,
                              path=target.path, allowed=reason is None, reason=reason,
                              source_ip=client_ip(request), threshold=policy.alert_threshold_per_minute,
                              mailer=mailer)
        session.commit()
    if reason is not None:
        raise HTTPException(403, reason)
    return Response(status_code=200, headers={"X-User": user.username, "X-Fhir-Tenant": str(target.project_id)})


def _deny_reason(session: Session, user: User, target: FhirTarget, method: str, policy: GatewayRoutePolicy
                 ) -> str | None:
    if Permission.PROJECT not in effective_permissions(session, user, target.project_id) \
            or session.get(Project, target.project_id) is None:
        return f"你沒有 {Permission.PROJECT.value} 權限"      # 不存在的專案同樣回這句，不透露專案是否存在
    if not policy.enabled:
        return "此路由已由管理者停用"
    if method not in policy.methods:
        return f"此路由不允許 {method} 方法"
    if target.is_write and user.account_type != AccountType.ADMIN:
        return "寫入 FHIR 資料需要 Admin 權限"
    return None


def _mailer(request: Request):
    state = request.app.state
    if not hasattr(state, "mailer"):
        state.mailer = traffic.mailer_from_env()
    return state.mailer
