"""Wiki.js 首次設定，可重複執行：python -m app.llm.wiki_setup

1. 等 Wiki.js 起來。
2. 還在安裝精靈階段時，以 WIKI_ADMIN_EMAIL／WIKI_ADMIN_PASSWORD 建立管理帳號（平台用的服務帳號），關閉遙測。
3. 把檢索引擎設為 PostgreSQL 全文檢索並重建索引。

平台之後用同一組帳號登入 Wiki 的 GraphQL API。Wiki 不對主機開放，使用者只經平台 API 操作。
"""
import json
import os
import sys
import time

import httpx

from app.llm.wiki import WikiJsClient, WikiUnavailable


def wait_until_up(base_url: str, *, timeout: float = 180.0) -> httpx.Response:
    deadline = time.monotonic() + timeout
    last = ""
    while time.monotonic() < deadline:
        try:
            response = httpx.get(f"{base_url}/", timeout=5, follow_redirects=True)
            if response.status_code < 500:
                return response
            last = f"HTTP {response.status_code}"
        except httpx.HTTPError as exc:
            last = type(exc).__name__
        time.sleep(2)
    raise SystemExit(f"Wiki 在 {timeout:.0f} 秒內沒有起來（{last}）")


def in_setup_mode(base_url: str) -> bool:
    """安裝精靈階段沒有 GraphQL 端點；完成後 /graphql 會回 JSON。"""
    try:
        response = httpx.post(f"{base_url}/graphql", json={"query": "{ site { config { title } } }"}, timeout=10)
        body = response.json()
    except (ValueError, httpx.HTTPError):
        return True
    # 安裝精靈階段 /graphql 回 404 {"message": "Not Found"}；正常運作時回 GraphQL 的 data 或 errors
    return response.status_code == 404 or not isinstance(body, dict) or not ({"data", "errors"} & set(body))


def finalize(base_url: str, email: str, password: str, site_url: str) -> None:
    response = httpx.post(f"{base_url}/finalize", timeout=120, json={
        "adminEmail": email, "adminPassword": password, "adminPasswordConfirm": password,
        "siteUrl": site_url, "telemetry": False})
    try:
        body = response.json()
    except ValueError:
        raise SystemExit(f"Wiki 安裝失敗：HTTP {response.status_code} {response.text[:200]}")
    if not body.get("ok"):
        raise SystemExit(f"Wiki 安裝失敗：{body.get('error') or body}")


def wait_for_login(client: WikiJsClient, *, timeout: float = 180.0) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            client._call("{ site { config { title } } }", {})
            return
        except WikiUnavailable as exc:
            if time.monotonic() > deadline:
                raise SystemExit(f"無法登入 Wiki：{exc}")
            time.sleep(2)


def enable_postgres_search(client: WikiJsClient) -> bool:
    """回傳是否有變更。"""
    engines = client._call("{ search { searchEngines { key isEnabled config { key value } } } }",
                           {})["search"]["searchEngines"]
    current = next((e["key"] for e in engines if e["isEnabled"]), None)
    if current == "postgres":
        return False
    payload = []
    for engine in engines:
        config = []
        for item in engine["config"]:
            value = json.loads(item["value"])
            chosen = "simple" if (engine["key"], item["key"]) == ("postgres", "dictLanguage") else value.get("value")
            config.append({"key": item["key"], "value": json.dumps({"v": chosen})})
        payload.append({"key": engine["key"], "isEnabled": engine["key"] == "postgres", "config": config})
    result = client._call(
        "mutation($engines: [SearchEngineInput]) { search { updateSearchEngines(engines: $engines) { "
        "responseResult { succeeded message } } } }", {"engines": payload})
    client._check(result["search"]["updateSearchEngines"])
    rebuilt = client._call("mutation { search { rebuildIndex { responseResult { succeeded message } } } }", {})
    client._check(rebuilt["search"]["rebuildIndex"])
    return True


def main() -> int:
    base_url = os.environ.get("WIKI_URL", "").rstrip("/")
    email, password = os.environ.get("WIKI_ADMIN_EMAIL", ""), os.environ.get("WIKI_ADMIN_PASSWORD", "")
    if not (base_url and email and password):
        print("缺少環境變數：WIKI_URL、WIKI_ADMIN_EMAIL、WIKI_ADMIN_PASSWORD", file=sys.stderr)
        return 2
    wait_until_up(base_url)
    installed = False
    if in_setup_mode(base_url):
        finalize(base_url, email, password, os.environ.get("WIKI_SITE_URL", base_url))
        installed = True
    client = WikiJsClient(base_url, email=email, password=password)
    wait_for_login(client)
    search_changed = enable_postgres_search(client)
    print(json.dumps({"wiki": base_url, "installed": installed, "search_engine": "postgres",
                      "search_engine_changed": search_changed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
