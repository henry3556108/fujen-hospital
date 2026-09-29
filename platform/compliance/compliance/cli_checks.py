"""其餘檢查的指令：掃毒、稽核覆蓋、監控覆蓋、測試報告、機密掃描。"""
from __future__ import annotations

import json
import re
import subprocess
from datetime import date
from pathlib import Path

import httpx

from compliance import audit_coverage, malware, monitoring_coverage, report, secrets_scan
from compliance.cli import OUT, PLATFORM, line, note
from compliance.tools import DockerToolRunner


def cmd_malware(args) -> int:
    free = _free_mb()
    if free is not None and free < args.min_free_mb:
        line("FAIL", "TC-D01-06", f"可用記憶體 {free} MB 低於 {args.min_free_mb} MB，未執行 clamscan（載入病毒碼約需 1.2 GB）")
        return 1
    r = malware.scan_project(args.compose_project, DockerToolRunner(), [Path(d) for d in args.extra_dir or []])
    OUT.mkdir(exist_ok=True)
    (OUT / "malware.json").write_text(malware.to_json(r), encoding="utf-8")
    for area in r.areas:
        note(f"已掃描：{area}")
    for path, sig in r.infected:
        note(f"惡意程式：{path}（{sig}）")
    for err in r.errors:
        note(f"錯誤：{err}")
    text = (f"上傳區 {len(r.areas)} 處、檔案 {r.files}；惡意程式 {len(r.infected)}；"
            f"EICAR 測試檔{'已攔截' if r.probe_detected else '未攔截'}；錯誤 {len(r.errors)}")
    line("PASS" if r.ok else "FAIL", "TC-D01-06", text)
    return 0 if r.ok else 1


def cmd_audit(args) -> int:
    try:
        r = audit_coverage.collect(args.compose_project)
    except Exception as exc:
        line("FAIL", "TC-D01-05", str(exc))
        line("FAIL", "TC-DAILY-01", "無法讀取稽核資料")
        return 1
    counts = "、".join(f"{audit_coverage.LABELS[c]} {r.counts[c]}" for c in audit_coverage.CATEGORIES)
    note(f"各類筆數：{counts}")
    for item in r.missing_fields[:30]:
        note(item)
    for cat, n in r.short.items():
        note(f"{audit_coverage.LABELS[cat]} 只抽到 {n} 筆（需 {audit_coverage.PER_CATEGORY}）")
    for cat, n in r.unknown.items():
        note(f"不屬於 8 類的類別：{cat}（{n} 筆）")
    line("PASS" if r.sample_ok else "FAIL", "TC-D01-05",
         f"8 類各抽 {audit_coverage.PER_CATEGORY} 筆：抽到 {r.sampled}／24，欄位缺漏 {len(r.missing_fields)}，不足的類別 {len(r.short)}")
    zero = [audit_coverage.LABELS[c] for c in audit_coverage.CATEGORIES if r.counts[c] == 0]
    line("PASS" if r.daily_ok else "FAIL", "TC-DAILY-01",
         "8 類稽核筆數都大於 0" if r.daily_ok else f"筆數為 0 的類別：{'、'.join(zero) or '無'}；不明類別 {len(r.unknown)}")
    return 0 if r.sample_ok and r.daily_ok else 1


def cmd_monitoring(args) -> int:
    try:
        r = monitoring_coverage.collect(args.kube_context, args.prometheus, monitoring_coverage.Policy.load(),
                                        args.compose_project)
    except Exception as exc:
        line("FAIL", "TC-DAILY-02", f"無法讀取叢集或 Prometheus（{type(exc).__name__}：{exc}）")
        return 1
    for item in r.uncovered + r.down + r.node_gaps + r.compose_uncovered:
        note(item)
    text = (f"叢集服務 {r.total}：抓取目標 {len(r.covered_by_target)}、容器指標 {len(r.covered_by_container)}、"
            f"未覆蓋 {len(r.uncovered)}；目標異常 {len(r.down)}；節點缺口 {len(r.node_gaps)}"
            + (f"；compose 服務未覆蓋 {len(r.compose_uncovered)}" if args.compose_project else ""))
    line("PASS" if r.ok else "FAIL", "TC-DAILY-02", text)
    return 0 if r.ok else 1


def _junit_files(platform: Path) -> list[tuple[str, Path]]:
    found = []
    for path in sorted(platform.rglob("*.xml")):
        if any(part in ("node_modules", ".venv") for part in path.parts) or "junit" not in path.name:
            continue
        suite = path.stem if path.parent.name in ("junit", "latest") and path.stem != "junit" else path.relative_to(platform).parts[0]
        found.append((suite, path))
    return found


def cmd_report(args) -> int:
    junit = [(j.split("=", 1)[0], Path(j.split("=", 1)[1])) for j in args.junit or []] or _junit_files(PLATFORM)
    checks = [Path(c) for c in args.checks or []]
    r = report.build(junit, checks)
    out_dir = Path(args.out) / date.today().isoformat()
    path = report.write(r, out_dir, f"測試報告 {date.today().isoformat()}")
    grades = {g: sum(1 for c in r.defects if c.grade == g) for g in report.GRADES}
    text = (f"案例 {len(r.cases)}（通過 {r.count('passed')}、失敗 {r.count('failed')}、錯誤 {r.count('error')}、"
            f"略過 {r.count('skipped')}）；缺陷 阻斷 {grades['阻斷']}、嚴重 {grades['嚴重']}、一般 {grades['一般']}；{path}")
    if not r.cases:
        line("FAIL", "TC-DAILY-03", "找不到任何測試結果")
        return 1
    line("PASS", "TC-DAILY-03", text)   # 報告產出即達成本案例；缺陷由各案例本身失敗表示
    return 0


def _token(keycloak: str, user: str, password: str) -> str:
    r = httpx.post(f"{keycloak}/realms/ai-platform/protocol/openid-connect/token", timeout=15,
                   data={"grant_type": "password", "client_id": "ai-platform-web", "username": user, "password": password})
    r.raise_for_status()
    return r.json()["access_token"]


def _openapi_paths(compose_project: str) -> list[str]:
    proc = subprocess.run(["docker", "compose", "-p", compose_project, "exec", "-T", "api", "/app/.venv/bin/python", "-c",
                           "import json; from app.main import create_app; print(json.dumps(create_app().openapi()))"],
                          capture_output=True, text=True, timeout=120, check=True)
    spec = json.loads(proc.stdout.strip().splitlines()[-1])
    return sorted(p for p, ops in spec["paths"].items() if "get" in ops)


def cmd_secrets(args) -> int:
    secrets = secrets_scan.discover_secrets(PLATFORM)
    if not secrets:
        line("FAIL", "TC-SS-04", "找不到任何要比對的機密值，無法驗證")
        return 1
    leaks, scanned = [], []
    if args.web_dist:
        files, found = secrets_scan.scan_dir(Path(args.web_dist), secrets)
        leaks += found
        scanned.append(f"前端打包檔 {files} 個")
        if files == 0:
            line("FAIL", "TC-SS-04", f"前端打包目錄 {args.web_dist} 是空的")
            return 1
    if args.gateway:
        paths = _openapi_paths(args.compose_project)
        headers = {"Authorization": f"Bearer {_token(args.keycloak, args.user, args.password)}"}
        responses = 0
        with httpx.Client(base_url=args.gateway, timeout=20) as client:
            for path in paths:
                url = re.sub(r"\{[^}]*project_id[^}]*\}", "1", path)
                url = re.sub(r"\{[^}]+\}", "1", url)
                for h in (headers, {}):          # 已登入與未登入各一次（錯誤訊息也要檢查）
                    r = client.get(url, headers=h)
                    responses += 1
                    leaks += secrets_scan.scan_text(r.text + "\n" + "\n".join(f"{k}: {v}" for k, v in r.headers.items()),
                                                    f"GET {url}（{r.status_code}）", secrets)
        scanned.append(f"API 回應 {responses} 筆（{len(paths)} 個 GET 端點 × 已登入／未登入）")
    if not scanned:
        line("FAIL", "TC-SS-04", "沒有指定要掃描的對象（--web-dist 或 --gateway）")
        return 1
    for leak in leaks:
        note(f"外洩：{leak.secret} 以{leak.form}出現在 {leak.where}")
    line("PASS" if not leaks else "FAIL", "TC-SS-04",
         f"比對機密 {len(secrets)} 項；{'、'.join(scanned)}；明文出現 {len(leaks)} 次")
    return 0 if not leaks else 1


def _free_mb() -> int | None:
    try:
        for row in Path("/proc/meminfo").read_text().splitlines():
            if row.startswith("MemAvailable:"):
                return int(row.split()[1]) // 1024
    except OSError:
        return None
    return None


def register(sub) -> None:
    p = sub.add_parser("malware", help="ClamAV 掃描上傳區（TC-D01-06）")
    p.add_argument("--compose-project", required=True)
    p.add_argument("--extra-dir", action="append", help="另外要掃的目錄")
    p.add_argument("--min-free-mb", type=int, default=1500)
    p.set_defaults(func=cmd_malware)
    p = sub.add_parser("audit", help="8 類稽核抽查與每日覆蓋（TC-D01-05、TC-DAILY-01）")
    p.add_argument("--compose-project", required=True)
    p.set_defaults(func=cmd_audit)
    p = sub.add_parser("monitoring", help="監控覆蓋（TC-DAILY-02）")
    p.add_argument("--kube-context", default="kind-ai-platform")
    p.add_argument("--prometheus", default="http://127.0.0.1:39090")
    p.add_argument("--compose-project", help="一併列出 compose 堆疊的服務（開發機）")
    p.set_defaults(func=cmd_monitoring)
    p = sub.add_parser("report", help="彙整測試報告（TC-DAILY-03）")
    p.add_argument("--junit", action="append", help="測試集=junit 檔；未指定時搜尋 platform/ 下所有 junit*.xml")
    p.add_argument("--checks", action="append", help="合規指令輸出的記錄檔")
    p.add_argument("--out", default=str(PLATFORM / "acceptance" / "reports"))
    p.set_defaults(func=cmd_report)
    p = sub.add_parser("secrets", help="機密外洩掃描（TC-SS-04）")
    p.add_argument("--web-dist")
    p.add_argument("--gateway")
    p.add_argument("--keycloak", default="http://localhost:8080")
    p.add_argument("--compose-project", default="ai-platform")
    p.add_argument("--user", default="admin01")
    p.add_argument("--password", default="Admin01-dev!")
    p.set_defaults(func=cmd_secrets)
