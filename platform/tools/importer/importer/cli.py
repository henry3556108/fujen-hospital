"""批次影像匯入 CLI：先登入（Keycloak device-code；本機可用帳密），再把資料夾經 Gateway 上傳。

    python -m importer login                                # device-code：開瀏覽器輸入代碼
    python -m importer login --username ra01 --password-stdin   # 本機開發用
    python -m importer upload --project P1-lung-ct ./data [--exclude manifest.json]
    python -m importer logout

結束碼：0 全部成功（含重複）；1 有任何檔案失敗或資料夾沒有檔案；2 未登入、登入失效、參數或專案錯誤。
環境變數：GATEWAY_URL（預設 http://localhost:9080）、KEYCLOAK_URL（預設 http://localhost:8080）、
KEYCLOAK_REALM（ai-platform）、IMPORTER_CLIENT_ID（ai-platform-importer）、IMPORTER_TOKEN_FILE。
"""
import argparse
import fnmatch
import json
import os
import sys
import time
from pathlib import Path
from typing import TextIO

import httpx

DICOM_EXT = ("", ".dcm", ".dicom", ".ima")
FILE_EXT = (".nii", ".nii.gz", ".mha", ".json")
LOGIN_HINT = "尚未登入或登入已失效，請先執行：python -m importer login"


class LoginRequired(Exception):
    pass


class Config:
    def __init__(self):
        self.gateway = os.environ.get("GATEWAY_URL", "http://localhost:9080").rstrip("/")
        self.keycloak = os.environ.get("KEYCLOAK_URL", "http://localhost:8080").rstrip("/")
        self.realm = os.environ.get("KEYCLOAK_REALM", "ai-platform")
        self.client_id = os.environ.get("IMPORTER_CLIENT_ID", "ai-platform-importer")
        default = Path.home() / ".config" / "ai-platform" / "importer-token.json"
        self.token_file = Path(os.environ.get("IMPORTER_TOKEN_FILE", default))

    @property
    def oidc(self) -> str:
        return f"{self.keycloak}/realms/{self.realm}/protocol/openid-connect"


# ---------- token ----------

def _save(cfg: Config, token: dict) -> None:
    now = time.time()
    data = {"access_token": token["access_token"], "refresh_token": token.get("refresh_token", ""),
            "expires_at": now + token.get("expires_in", 60),
            "refresh_expires_at": now + token.get("refresh_expires_in", 0)}
    cfg.token_file.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(cfg.token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    os.chmod(cfg.token_file, 0o600)


def access_token(cfg: Config, http: httpx.Client) -> str:
    """回傳有效的 access token；沒有登入或無法續期就丟 LoginRequired（此時不會送出任何上傳）。"""
    try:
        saved = json.loads(cfg.token_file.read_text())
    except (OSError, ValueError):
        raise LoginRequired
    now = time.time()
    if saved.get("expires_at", 0) - 30 > now:
        return saved["access_token"]
    if not saved.get("refresh_token") or saved.get("refresh_expires_at", 0) - 30 <= now:
        raise LoginRequired
    r = http.post(f"{cfg.oidc}/token", data={"grant_type": "refresh_token", "client_id": cfg.client_id,
                                             "refresh_token": saved["refresh_token"]})
    if r.status_code != 200:
        raise LoginRequired
    _save(cfg, r.json())
    return r.json()["access_token"]


def cmd_login(args, cfg: Config, http: httpx.Client, out: TextIO, err: TextIO, stdin: TextIO) -> int:
    if args.username:
        password = stdin.readline().rstrip("\n") if args.password_stdin else os.environ.get("IMPORTER_PASSWORD")
        if password is None:
            import getpass
            password = getpass.getpass("密碼：")
        r = http.post(f"{cfg.oidc}/token", data={"grant_type": "password", "client_id": cfg.client_id,
                                                 "username": args.username, "password": password,
                                                 "scope": "openid"})
        if r.status_code != 200:
            print(f"登入失敗：{r.json().get('error_description') or r.json().get('error', r.status_code)}", file=err)
            return 2
        _save(cfg, r.json())
        print(f"已登入：{args.username}", file=out)
        return 0
    r = http.post(f"{cfg.oidc}/auth/device", data={"client_id": cfg.client_id, "scope": "openid"})
    if r.status_code != 200:
        print(f"登入失敗：無法啟動 device-code 登入（{r.status_code}）", file=err)
        return 2
    d = r.json()
    print(f"請用瀏覽器開啟 {d.get('verification_uri_complete') or d['verification_uri']}"
          f"，輸入代碼 {d['user_code']} 完成登入。", file=out)
    interval, deadline = d.get("interval", 5), time.time() + d.get("expires_in", 600)
    while time.time() < deadline:
        time.sleep(interval)
        t = http.post(f"{cfg.oidc}/token", data={"grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                                                 "client_id": cfg.client_id, "device_code": d["device_code"]})
        if t.status_code == 200:
            _save(cfg, t.json())
            print("已登入", file=out)
            return 0
        error = t.json().get("error")
        if error == "slow_down":
            interval += 5
        elif error != "authorization_pending":
            print(f"登入失敗：{error}", file=err)
            return 2
    print("登入失敗：逾時", file=err)
    return 2


def cmd_logout(args, cfg: Config, http, out: TextIO, err, stdin) -> int:
    cfg.token_file.unlink(missing_ok=True)
    print("已登出", file=out)
    return 0


# ---------- upload ----------

def _kind(path: str) -> str | None:
    lower = path.lower()
    if lower.endswith(FILE_EXT):
        return "files"
    if os.path.splitext(lower)[1] in DICOM_EXT:
        return "dicom"
    return None


def collect(folder: Path, excludes: list[str]) -> list[str]:
    rels = []
    for p in sorted(folder.rglob("*")):
        rel = p.relative_to(folder).as_posix()
        if not p.is_file() or any(part.startswith(".") for part in rel.split("/")):
            continue
        if any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(p.name, pat) for pat in excludes):
            continue
        rels.append(rel)
    return rels


def _resolve_project(http: httpx.Client, cfg: Config, headers: dict, project: str) -> int | None:
    r = http.get(f"{cfg.gateway}/api/me", headers=headers)
    if r.status_code == 401:
        raise LoginRequired
    r.raise_for_status()
    for p in r.json().get("projects", []):
        if str(p["id"]) == project or p["name"] == project:
            return p["id"]
    return None


def _detail(r: httpx.Response) -> str:
    try:
        d = r.json().get("detail")
    except ValueError:
        return f"HTTP {r.status_code}"
    if isinstance(d, dict):
        d = d.get("message") or json.dumps(d, ensure_ascii=False)
    return f"HTTP {r.status_code}：{d}"


def cmd_upload(args, cfg: Config, http: httpx.Client, out: TextIO, err: TextIO, stdin) -> int:
    try:
        token = access_token(cfg, http)
    except LoginRequired:
        print(LOGIN_HINT, file=err)
        return 2
    folder = Path(args.folder)
    if not folder.is_dir():
        print(f"找不到資料夾：{folder}", file=err)
        return 2
    headers = {"Authorization": f"Bearer {token}"}
    try:
        pid = _resolve_project(http, cfg, headers, args.project)
    except LoginRequired:
        print(LOGIN_HINT, file=err)
        return 2
    if pid is None:
        print(f"找不到專案或你不是成員：{args.project}", file=err)
        return 2

    rels = collect(folder, args.exclude)
    if not rels:
        print(f"資料夾內沒有可匯入的檔案：{folder}", file=err)
        return 1
    results: list[dict] = []
    groups: dict[str, list[str]] = {"dicom": [], "files": []}
    for rel in rels:
        kind = _kind(rel)
        if kind is None:
            results.append({"filename": rel, "status": "failed", "reason": "不支援的副檔名"})
        else:
            groups[kind].append(rel)
    for kind in ("dicom", "files"):   # DICOM 先匯，makesense 標註才配得到影像
        names = groups[kind]
        for i in range(0, len(names), args.batch_size):
            batch = names[i: i + args.batch_size]
            files = [("files", (rel, (folder / rel).read_bytes())) for rel in batch]
            r = http.post(f"{cfg.gateway}/api/projects/{pid}/imaging/{kind}", headers=headers, files=files)
            if r.status_code == 401:
                print(LOGIN_HINT, file=err)
                return 2
            if r.status_code != 201:
                reason = _detail(r)
                results.extend({"filename": rel, "status": "failed", "reason": reason} for rel in batch)
                continue
            job = r.json()
            results.extend(job["files"])
            print(f"匯入工作 #{job['id']}（{kind}，{len(batch)} 檔）", file=out)

    order = {rel: n for n, rel in enumerate(rels)}
    results.sort(key=lambda x: order.get(x["filename"], len(order)))
    width = max(len(x["filename"]) for x in results)
    print(f"{'檔案'.ljust(width)}  結果       原因", file=out)
    for x in results:
        print(f"{x['filename'].ljust(width)}  {x['status'].ljust(9)}  {x.get('reason', '')}", file=out)
    counts = {s: sum(1 for x in results if x["status"] == s) for s in ("imported", "duplicate", "failed")}
    print(f"匯入 {counts['imported']}、重複 {counts['duplicate']}、失敗 {counts['failed']}", file=out)
    return 1 if counts["failed"] else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="importer", description="經 Gateway 批次匯入醫療影像")
    sub = parser.add_subparsers(dest="command", required=True)
    login = sub.add_parser("login", help="登入（預設 device-code）")
    login.add_argument("--username", help="本機開發用帳密登入")
    login.add_argument("--password-stdin", action="store_true", help="從標準輸入讀密碼")
    sub.add_parser("logout", help="刪除本機 token")
    up = sub.add_parser("upload", help="上傳資料夾")
    up.add_argument("--project", required=True, help="專案 ID 或名稱")
    up.add_argument("--exclude", action="append", default=[], help="略過的檔名或相對路徑樣式（可重複）")
    up.add_argument("--batch-size", type=int, default=20)
    up.add_argument("folder")
    return parser


COMMANDS = {"login": cmd_login, "logout": cmd_logout, "upload": cmd_upload}


def main(argv: list[str] | None = None, *, transport: httpx.BaseTransport | None = None,
         stdout: TextIO = sys.stdout, stderr: TextIO = sys.stderr, stdin: TextIO = sys.stdin) -> int:
    args = build_parser().parse_args(argv)
    cfg = Config()
    with httpx.Client(timeout=120, transport=transport) as http:
        try:
            return COMMANDS[args.command](args, cfg, http, stdout, stderr, stdin)
        except httpx.HTTPError as exc:
            print(f"連線失敗：{exc}", file=stderr)
            return 2
