#!/usr/bin/env python3
"""由 compose 的設定原始檔（platform/deploy/local）產生 Kubernetes 用的設定檔。

compose 的設定檔是唯一的來源；這裡只做固定的轉換，每個轉換都檢查原文確實存在（原始檔改了就會失敗，不會默默漏掉）：
- 密碼與金鑰換成環境變數佔位，由 Secret 注入：Keycloak realm 用 `${VAR}`，Orthanc 用 `${VAR}`，APISIX 用 `${{VAR}}`。
- 服務位址換成叢集內的寫法（APISIX 的 forward-auth 用 nginx resolver，不吃 search domain，所以寫完整網域）。
- 瀏覽器網址（Keycloak redirect、CORS、OHIF authority）換成每個 overlay 自己的值。

  python3 render-config.py           重新產生
  python3 render-config.py --check   只比對，不一致就以 1 結束（manifest 測試會執行）
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCAL = HERE.parent / "local"
NAMESPACE = "ai-platform"
SVC = f".{NAMESPACE}.svc.cluster.local"
HEADER = "# 由 platform/deploy/k8s/render-config.py 從 platform/deploy/local/{src} 產生，請改原始檔後重新產生\n"


def replace(text: str, old: str, new: str, *, count: int | None = None) -> str:
    found = text.count(old)
    if found == 0 or (count is not None and found != count):
        raise SystemExit(f"render-config：原始檔中找不到預期的內容（{found} 處）：{old!r}")
    return text.replace(old, new)


# ---------- Keycloak realm ----------

def realm(production: bool) -> str:
    data = json.loads((LOCAL / "keycloak/realm-ai-platform.json").read_text(encoding="utf-8"))
    clients = {c["clientId"]: c for c in data["clients"]}
    api = clients["ai-platform-api"]
    assert api.get("secret") == "api-secret-dev", "ai-platform-api 的 secret 不是預期的開發值"
    api["secret"] = "${KC_API_CLIENT_SECRET}"
    web = clients["ai-platform-web"]
    web["redirectUris"] = ["${WEB_PUBLIC_URL}/*"]
    web["webOrigins"] = ["${WEB_PUBLIC_URL}"]
    web["attributes"]["post.logout.redirect.uris"] = "${WEB_PUBLIC_URL}/*"
    ohif = clients["ai-platform-ohif"]
    ohif["redirectUris"] = ["${OHIF_PUBLIC_URL}/*"]
    ohif["webOrigins"] = ["${OHIF_PUBLIC_URL}"]
    ohif["attributes"]["post.logout.redirect.uris"] = "${OHIF_PUBLIC_URL}/*"
    admins = [u for u in data["users"] if u["username"] == "admin01"]
    assert len(admins) == 1 and admins[0]["credentials"][0]["type"] == "password"
    admins[0]["credentials"][0]["value"] = "${KC_ADMIN01_PASSWORD}"
    admins[0]["credentials"][0]["temporary"] = production   # 正式環境第一次登入必須改密碼
    if production:
        # 密碼授權只為本機驗收腳本取 token；正式環境一律關閉（importer 改用 device-code，網頁與 OHIF 用授權碼）
        for c in data["clients"]:
            if c.get("publicClient"):
                c["directAccessGrantsEnabled"] = False
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


# ---------- APISIX ----------

def apisix_config() -> str:
    text = (LOCAL / "apisix/config.yaml").read_text(encoding="utf-8")
    # Docker 內建 DNS 換成 Pod 的 nameserver（啟動時由 /etc/resolv.conf 取得，放進 DNS_SERVER）
    text = replace(text, '"127.0.0.11:53"', '"${{DNS_SERVER}}:53"')
    text = replace(text, "# WP6：上游以 Docker 內建 DNS 做服務發現", "# WP6：上游以叢集 DNS 做服務發現（headless Service）")
    text += ("# Kubernetes：apisix.yaml 內以 ${{VAR}} 引用的環境變數，nginx worker 要宣告才讀得到\n"
             "nginx_config:\n  worker_processes: 2   # 預設依 CPU 數開 worker，每個約 30 MB；平台節點記憶體有限\n  envs:\n    - DNS_SERVER\n    - ORTHANC_GATEWAY_AUTH\n"
             "    - CORS_ALLOW_ORIGINS\n    - DICOMWEB_CORS_REGEX\n")
    return HEADER.format(src="apisix/config.yaml") + text


def apisix_routes() -> str:
    text = (LOCAL / "apisix/apisix.yaml").read_text(encoding="utf-8")
    text = replace(text, '"api:8000": 1', f'"api{SVC}:8000": 1', count=1)
    text = replace(text, "uri: http://api:8000/authz/check", f"uri: http://api{SVC}:8000/authz/check", count=2)
    text = replace(text, '"orthanc:8042": 1', f'"orthanc{SVC}:8042": 1', count=1)
    text = replace(text, '"ohif:80": 1', f'"ohif{SVC}:80": 1', count=1)
    text = replace(text, '"web:8080": 1', f'"web{SVC}:8080": 1', count=1)
    text = replace(text, "（compose.web.yaml 才會開）", "（Kubernetes：apisix Service 的 9082 埠）")
    text = replace(text, 'service_name: "hapi:8080"', f'service_name: "hapi{SVC}:8080"', count=1)
    text = replace(text, 'allow_origins: "http://localhost:5173"', 'allow_origins: "${{CORS_ALLOW_ORIGINS}}"', count=1)
    text = replace(text, 'allow_origins_by_regex: ["^http://(localhost|127\\\\.0\\\\.0\\\\.1)(:[0-9]+)?$"]',
                   # 單引號：APISIX 3.19 先在原文替換環境變數再解析 YAML，正規表示式的反斜線在雙引號內是無效的跳脫
                   "allow_origins_by_regex: ['${{DICOMWEB_CORS_REGEX}}']", count=1)
    text = replace(text, "ngx.req.set_header('Authorization', 'Basic Z2F0ZXdheTpvcnRoYW5jLWd3LWRldg==')",
                   "ngx.req.set_header('Authorization', '${{ORTHANC_GATEWAY_AUTH}}')", count=1)
    text = replace(text, "（compose.labeling.yaml 才會開）", "（Kubernetes：apisix Service 的 9081 埠）")
    return HEADER.format(src="apisix/apisix.yaml") + text


# ---------- Orthanc ----------

def orthanc_platform() -> str:
    data = json.loads((LOCAL / "orthanc/platform/orthanc.json").read_text(encoding="utf-8"))
    assert set(data["RegisteredUsers"]) == {"platform-api", "gateway", "autolabel"}
    data["RegisteredUsers"] = {"platform-api": "${ORTHANC_API_PASSWORD}", "gateway": "${ORTHANC_GATEWAY_PASSWORD}",
                               "autolabel": "${ORTHANC_AUTOLABEL_PASSWORD}"}
    assert data["DicomModalities"]["pacs"] == ["PACS", "orthanc-pacs", 4242]
    data["DicomModalities"]["pacs"] = ["${PACS_AET}", "${PACS_HOST}", "${PACS_PORT}"]
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    # Orthanc 在解析 JSON 前替換 ${VAR}；連接埠要是數字，所以去掉引號
    return replace(text, '"${PACS_PORT}"', "${PACS_PORT}", count=1)


def orthanc_pacs() -> str:
    data = json.loads((LOCAL / "orthanc/pacs/orthanc.json").read_text(encoding="utf-8"))
    assert set(data["RegisteredUsers"]) == {"pacs-admin"}
    data["RegisteredUsers"] = {"pacs-admin": "${PACS_ADMIN_PASSWORD}"}
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


# ---------- ClamAV ----------

def clamd_conf() -> str:
    text = (LOCAL / "clamav/clamd.conf").read_text(encoding="utf-8")
    # 預設重載病毒碼時新舊兩份同時在記憶體（約 2.4 GB）；叢集內關掉，重載期間暫停掃描（上傳會短暫 503）
    return text + "# Kubernetes（render-config.py 加入）：重載病毒碼時不同時保留兩份，記憶體上限才能設在 2 GB 以下\nConcurrentDatabaseReload no\n"


# ---------- OHIF ----------

def ohif(authority: str) -> str:
    text = (LOCAL / "ohif/app-config.js").read_text(encoding="utf-8")
    text = replace(text, "authority: 'http://localhost:8080/realms/ai-platform'", f"authority: '{authority}'", count=1)
    return f"// 由 platform/deploy/k8s/render-config.py 從 platform/deploy/local/ohif/app-config.js 產生\n{text}"


def outputs() -> dict[Path, str | Path]:
    return {
        HERE / "base/config/apisix-config.yaml": apisix_config(),
        HERE / "base/config/apisix.yaml": apisix_routes(),
        HERE / "base/config/realm-ai-platform.json": realm(production=False),
        HERE / "base/config/orthanc.json": orthanc_platform(),
        HERE / "base/config/autolabel-readonly.lua": LOCAL / "orthanc/platform/autolabel-readonly.lua",
        HERE / "base/config/clamd.conf": clamd_conf(),
        HERE / "overlays/kind/config/orthanc-pacs.json": orthanc_pacs(),
        HERE / "overlays/kind/config/app-config.js": ohif("http://localhost:38180/realms/ai-platform"),
        HERE / "overlays/kind/config/llm-preload-config.json": LOCAL / "llm/preload/offline-small/config.json",
        HERE / "overlays/kind/config/llm-preload-manifest.json": LOCAL / "llm/preload/offline-small/manifest.json",
        HERE / "overlays/production/config/realm-ai-platform.json": realm(production=True),
        HERE / "overlays/production/config/app-config.js": ohif("https://KEYCLOAK_HOST/realms/ai-platform"),
        HERE / "overlays/production/config/llm-models.json": LOCAL / "llm/models.json",
    }


def main(argv: list[str]) -> int:
    check = "--check" in argv
    stale = []
    for path, content in outputs().items():
        text = content.read_text(encoding="utf-8") if isinstance(content, Path) else content
        current = path.read_text(encoding="utf-8") if path.exists() else None
        if current == text:
            continue
        if check:
            stale.append(str(path.relative_to(HERE)))
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, Path):
            shutil.copyfile(content, path)
        else:
            path.write_text(text, encoding="utf-8")
        print(f"已更新 {path.relative_to(HERE)}")
    if stale:
        print("與 compose 原始檔不同步，請執行 python3 platform/deploy/k8s/render-config.py：" + "、".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
