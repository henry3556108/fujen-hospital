"""指令入口：python -m compliance <檢查>。每項檢查印一行總結，失敗時結束碼非 0。"""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

from compliance import licences, packages, sources, vulns
from compliance.discover import Inventory, discover
from compliance.sbom import Subject, scan_all
from compliance.tools import DockerToolRunner, ToolError, cache_dir, load_lock

PROJECT = Path(__file__).resolve().parent.parent          # platform/compliance
PLATFORM = PROJECT.parent                                  # platform/
REPO = PLATFORM.parent
DOCS = REPO / "docs" / "delivery"
OUT = PROJECT / "out"


def line(status: str, tc: str, text: str) -> None:
    print(f"{status:<4}  {tc:<12}  {text}", flush=True)


def note(text: str) -> None:
    print(f"      {text}", flush=True)


def fetch_manifest(url: str) -> str:
    cached = cache_dir() / "manifests" / (url.replace("://", "_").replace("/", "_"))
    if cached.exists():
        return cached.read_text(encoding="utf-8")
    response = httpx.get(url, follow_redirects=True, timeout=60)
    response.raise_for_status()
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text(response.text, encoding="utf-8")
    return response.text


def inventory(args) -> Inventory:
    inv = discover(Path(args.platform), fetch=None if args.offline else fetch_manifest)
    for warning in inv.warnings:
        line("WARN", "discover", warning)
    return inv


def subjects_for(args, inv: Inventory) -> list[Subject]:
    cache = OUT / "subjects.json"
    if getattr(args, "reuse", False) and cache.exists():
        return [Subject(**{**s, "rows": [tuple(r) for r in s["rows"]]}) for s in json.loads(cache.read_text())]
    subjects = scan_all(DockerToolRunner(), inv, progress=lambda s: print(f"      … {s}", file=sys.stderr, flush=True))
    OUT.mkdir(exist_ok=True)
    cache.write_text(json.dumps([dataclasses.asdict(s) for s in subjects], ensure_ascii=False))
    return subjects


def scan_errors(subjects: list[Subject], tc: str) -> int:
    failed = [s for s in subjects if s.error]
    for s in failed:
        line("FAIL", tc, f"無法掃描 {s.name}：{s.error}")
    return len(failed)


# ---------- 指令 ----------

def cmd_discover(args) -> int:
    inv = inventory(args)
    for image in sorted(inv.images.values(), key=lambda i: i.key):
        print(f"image   {image.key}  ←  {'、'.join(sorted(image.used_by))}")
    for build in inv.builds.values():
        print(f"build   {build.name}（{build.dockerfile.relative_to(inv.root.resolve())}）  ←  {'、'.join(sorted(build.used_by))}")
    for pkgs in inv.package_sets:
        print(f"{pkgs.kind:<7} {pkgs.name}")
    line("PASS", "discover", f"映像 {len(inv.images)}、自建映像 {len(inv.builds)}、套件集合 {len(inv.package_sets)}、警告 {len(inv.warnings)}")
    return 0


def cmd_licences(args) -> int:
    inv = inventory(args)
    subjects = subjects_for(args, inv)
    errors = scan_errors(subjects, "TC-D01-01")
    files = licences.render(subjects, load_lock())
    total = sum(len(s.rows) for s in subjects)
    if args.action == "generate":
        licences.write(Path(args.docs), files)
        status = "FAIL" if errors else "PASS"
        line(status, "TC-D01-01", f"已產生授權清單：對象 {len(subjects) - errors}、元件 {total} 列 → {args.docs}")
        return 1 if errors else 0
    diffs = licences.compare(Path(args.docs), files)
    for d in diffs[: args.max_lines]:
        note(str(d))
    if len(diffs) > args.max_lines:
        note(f"……其餘 {len(diffs) - args.max_lines} 項差異省略")
    if diffs or errors:
        line("FAIL", "TC-D01-01", f"授權清單與實際使用差異 {len(diffs)} 項、無法掃描 {errors} 個對象")
        return 1
    line("PASS", "TC-D01-01", f"授權清單與實際使用差異 0（對象 {len(subjects)}、元件 {total} 列）")
    return 0


def cmd_packages(args) -> int:
    inv = inventory(args)
    subjects = subjects_for(args, inv)
    errors = scan_errors(subjects, "TC-A01-04")
    files = packages.render(subjects)
    count = sum(len(t.split()) for t in files.values())
    if args.action == "generate":
        packages.write(Path(args.docs), files)
        line("FAIL" if errors else "PASS", "TC-A01-04", f"已產生映像內 Python 套件清單：映像 {len(files)}、套件 {count} → {args.docs}")
        return 1 if errors else 0
    diffs = packages.compare(Path(args.docs), files)
    for d in diffs[: args.max_lines]:
        note(d)
    if diffs or errors:
        line("FAIL", "TC-A01-04", f"映像內 Python 套件與已確認清單差異 {len(diffs)} 項、無法掃描 {errors} 個對象")
        return 1
    if not files:
        line("FAIL", "TC-A01-04", "沒有任何映像含 Python 套件，無法驗證")
        return 1
    line("PASS", "TC-A01-04", f"映像內 Python 套件與已確認清單差異 0（映像 {len(files)}、套件 {count}）")
    return 0


def cmd_sources(args) -> int:
    inv = inventory(args)
    policy = sources.Policy.load(Path(args.policy))
    report = sources.check_declared(inv, policy)
    for item in report.unpinned:
        line("WARN", "TC-D01-07", f"映像未釘版本，內容可能隨時間改變：{item}")
    for item in report.unapproved:
        note(f"非受限來源：{item}")
    if args.running:
        running = []
        for project in args.compose_project or []:
            found = sources.running_compose(project)
            if not found:
                line("FAIL", "TC-D01-07", f"compose 專案 {project} 沒有執行中的容器，無法檢查非專案軟體")
                return 1
            running += found
        if args.kube_context:
            try:
                running += sources.running_pods(args.kube_context)
            except Exception as exc:
                line("FAIL", "TC-D01-07", f"讀不到叢集 {args.kube_context} 的 Pod（{type(exc).__name__}）")
                return 1
        if not running:
            line("FAIL", "TC-D01-07", "--running 需要 --compose-project 或 --kube-context")
            return 1
        sources.check_running(inv, policy, running, report, tool_images=[t["image"] for t in load_lock().values()])
        for item in report.undeclared:
            note(f"非專案軟體：{item}")
    scope = f"探索到的映像 {report.checked}" + (f"、執行中的容器與 Pod {report.running_checked}" if args.running else "")
    if not report.ok:
        line("FAIL", "TC-D01-07", f"非受限來源 {len(report.unapproved)}、非專案軟體 {len(report.undeclared)}（{scope}）")
        return 1
    line("PASS", "TC-D01-07", f"非受限來源 0、非專案軟體 {'0' if args.running else '未檢查（加 --running）'}（{scope}）")
    return 0


def cmd_vulns(args) -> int:
    inv = inventory(args)
    runner = DockerToolRunner()
    targets = [(i.key, i.key, sorted(i.platforms)[0] if i.platforms else None)
               for i in sorted(inv.images.values(), key=lambda i: i.key)]
    for build in sorted(inv.builds.values(), key=lambda b: b.name):
        try:
            runner.build(build)
            targets.append((f"自建映像 {build.name}", build.scan_tag, None))
        except ToolError as exc:
            line("FAIL", "TC-D01-07", f"無法建置 {build.name}：{exc}")
            return 1
    summaries = []
    for name, ref, platform in targets:
        print(f"      … Trivy 掃描 {name}", file=sys.stderr, flush=True)
        try:
            summaries.append(vulns.summarise(name, runner.trivy_image(ref, platform)))
        except ToolError as exc:
            summaries.append(vulns.VulnSummary(name, error=str(exc)))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    OUT.mkdir(exist_ok=True)
    report = OUT / "vulnerabilities.md"
    report.write_text(vulns.report_md(summaries, load_lock()["trivy"], now), encoding="utf-8")
    (OUT / "vulnerabilities.json").write_text(json.dumps(
        [{"subject": s.subject, "counts": dict(s.counts), "fixable": dict(s.fixable), "top": s.top, "error": s.error}
         for s in summaries], ensure_ascii=False, indent=1))
    failed = [s for s in summaries if s.error]
    for s in summaries:
        if not s.error:
            note(f"{s.subject}：" + "、".join(f"{lv} {s.counts[lv]}" for lv in vulns.SEVERITIES))
    for s in failed:
        line("FAIL", "TC-D01-07", f"無法掃描 {s.subject}：{s.error}")
    over = vulns.exceeds(summaries, args.fail_on)
    total = {lv: sum(s.counts[lv] for s in summaries) for lv in vulns.SEVERITIES}
    text = f"掃描映像 {len(summaries) - len(failed)}／{len(summaries)}；" + "、".join(f"{k} {v}" for k, v in total.items()) + f"；報告 {report}"
    if failed or over:
        for item in over:
            note(f"超過門檻 {args.fail_on}：{item}")
        line("FAIL", "TC-D01-07", text)
        return 1
    line("WARN" if total["CRITICAL"] or total["HIGH"] else "PASS", "TC-D01-07", text)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m compliance", description="合規與交付檢查")
    parser.add_argument("--platform", default=str(PLATFORM), help="platform/ 目錄")
    parser.add_argument("--offline", action="store_true", help="不下載遠端部署檔（會列為警告）")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("discover", help="列出探索到的映像與套件集合").set_defaults(func=cmd_discover)
    for name, func, docs in (("licences", cmd_licences, DOCS), ("packages", cmd_packages, DOCS)):
        p = sub.add_parser(name)
        p.add_argument("action", choices=["generate", "check"])
        p.add_argument("--docs", default=str(docs))
        p.add_argument("--reuse", action="store_true", help="沿用上一次掃描結果（out/subjects.json），不重新掃描")
        p.add_argument("--max-lines", type=int, default=40)
        p.set_defaults(func=func)
    p = sub.add_parser("sources")
    p.add_argument("--policy", default=str(sources.POLICY))
    p.add_argument("--running", action="store_true", help="另比對執行中的容器與叢集 Pod")
    p.add_argument("--compose-project", action="append")
    p.add_argument("--kube-context")
    p.set_defaults(func=cmd_sources)
    p = sub.add_parser("vulns")
    p.add_argument("--fail-on", choices=vulns.SEVERITIES, default=None, help="出現這個嚴重度以上的漏洞就失敗")
    p.set_defaults(func=cmd_vulns)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    from compliance import cli_checks  # 其餘檢查（掃毒、稽核、監控、報告、機密）
    cli_checks.register(parser._subparsers._group_actions[0])  # type: ignore[attr-defined]
    args = parser.parse_args(argv)
    # docker compose 一律以 -p <專案> 指定；呼叫端的 COMPOSE_FILE 多半是相對 deploy/local 的路徑，在這裡會找不到檔
    os.environ.pop("COMPOSE_FILE", None)
    return args.func(args)
