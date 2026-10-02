"""機密外洩掃描（TC-SS-04）：前端打包檔與 API 回應裡不可出現 client secret、資料庫密碼、物件儲存金鑰。

要找的值從部署檔探索：compose 環境變數裡名稱像密碼、金鑰的值，以及 Keycloak realm 裡 client 的 secret。
比對原文、URL 編碼、base64 三種形式。
"""
from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import yaml

SECRET_NAME = re.compile(r"(PASSWORD|SECRET|ACCESS_KEY|SECRET_KEY|ROOT_USER|TOKEN|PRIVATE_KEY)", re.I)
MIN_LENGTH = 6
# 這些值是公開的設定，不是機密（例：前端本來就要知道的 client id）
NOT_SECRET_NAMES = re.compile(r"(_FILE|_PATH|_URL|_HOST|_PORT|_ENDPOINT)$", re.I)


@dataclass(frozen=True)
class Secret:
    name: str        # 例：compose.yaml#postgres:POSTGRES_PASSWORD
    value: str


@dataclass(frozen=True)
class Leak:
    secret: str
    where: str
    form: str


def _env(svc: dict) -> dict:
    env = svc.get("environment") or {}
    if isinstance(env, list):
        env = dict(item.split("=", 1) for item in env if isinstance(item, str) and "=" in item)
    return env


def discover_secrets(platform: Path) -> list[Secret]:
    found: dict[str, Secret] = {}
    for path in sorted(platform.glob("deploy/**/*.y*ml")):
        if not path.name.startswith(("compose", "docker-compose")):
            continue
        for doc in yaml.safe_load_all(path.read_text(encoding="utf-8")):
            for name, svc in ((doc or {}).get("services") or {}).items():
                for key, value in _env(svc or {}).items():
                    if (SECRET_NAME.search(str(key)) and not NOT_SECRET_NAMES.search(str(key))
                            and isinstance(value, str) and len(value) >= MIN_LENGTH and "$" not in value):
                        found.setdefault(value, Secret(f"{path.name}#{name}:{key}", value))
    for path in sorted(platform.glob("deploy/**/realm-*.json")):
        realm = json.loads(path.read_text(encoding="utf-8"))
        for client in realm.get("clients", []):
            value = client.get("secret")
            if isinstance(value, str) and len(value) >= MIN_LENGTH and "${" not in value:   # k8s 的佔位不是值
                found.setdefault(value, Secret(f"{path.name}:client {client.get('clientId')} secret", value))
    return sorted(found.values(), key=lambda s: s.name)


def kube_secrets(namespace: str, name: str = "platform-secrets") -> list[Secret]:
    """Kubernetes 部署的 Secret（platform/deploy/k8s/create-secrets.sh 建立）裡的值。"""
    import subprocess

    proc = subprocess.run(["kubectl", "-n", namespace, "get", "secret", name, "-o", "json"],
                          capture_output=True, text=True, timeout=60, check=True)
    data = json.loads(proc.stdout).get("data") or {}
    out = []
    for key, encoded in sorted(data.items()):
        value = base64.b64decode(encoded).decode("utf-8", errors="replace")
        if len(value) >= MIN_LENGTH and not NOT_SECRET_NAMES.search(key):
            out.append(Secret(f"secret/{name}:{key}", value))
    return out


def merge(*groups: list[Secret]) -> list[Secret]:
    found: dict[str, Secret] = {}
    for group in groups:
        for s in group:
            found.setdefault(s.value, s)
    return sorted(found.values(), key=lambda s: s.name)


def forms(value: str) -> dict[str, str]:
    out = {"原文": value, "URL 編碼": quote(value, safe="")}
    raw = value.encode()
    b64 = base64.b64encode(raw).decode()[: (len(raw) // 3) * 4]   # 只取完整 3 位元組組成的部分，嵌在較長內容裡也比對得到
    if len(b64) >= 8:
        out["base64"] = b64
    return {k: v for k, v in out.items() if v}


def scan_text(text: str, where: str, secrets: list[Secret]) -> list[Leak]:
    leaks = []
    for s in secrets:
        seen = set()
        for form, needle in forms(s.value).items():
            if needle in seen:
                continue
            seen.add(needle)
            if needle in text:
                leaks.append(Leak(s.name, where, form))
    return leaks


def scan_dir(directory: Path, secrets: list[Secret]) -> tuple[int, list[Leak]]:
    files, leaks = 0, []
    for path in sorted(p for p in directory.rglob("*") if p.is_file()):
        files += 1
        leaks += scan_text(path.read_bytes().decode("utf-8", "replace"), str(path.relative_to(directory)), secrets)
    return files, leaks
