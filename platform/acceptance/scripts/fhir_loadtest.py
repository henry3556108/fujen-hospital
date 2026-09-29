"""FHIR 壓測與可用性檢測（TC-C03-11）：經 Gateway 以固定併發送出讀取請求，輸出 JSON 與 Markdown 報告。

    uv run python scripts/fhir_loadtest.py --project 12 --username admin01 --requests 400 --concurrency 8

數字只有在甲方環境重跑才算數；開發機上只驗證腳本可跑、失敗 0。
"""
import argparse
import json
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(q * (len(ordered) - 1))))]


def run(gateway: str, token: str, project: int, *, requests: int, concurrency: int, timeout: float = 30.0) -> dict:
    base = f"{gateway}/fhir/projects/{project}"
    paths = ["/Patient?_count=20", "/Encounter?_count=20", "/Observation?_count=20", "/metadata",
             "/Patient?identifier=urn:ai-platform:mrn|SYN-42-0001"]
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/fhir+json"}

    def one(index: int) -> tuple[bool, float, str]:
        path = paths[index % len(paths)]
        started = time.perf_counter()
        try:
            with httpx.Client(timeout=timeout) as client:
                response = client.get(base + path, headers=headers)
            ok = response.status_code == 200 and response.json().get("resourceType") in ("Bundle",
                                                                                          "CapabilityStatement")
            note = "" if ok else f"HTTP {response.status_code}"
        except (httpx.HTTPError, ValueError) as exc:
            ok, note = False, type(exc).__name__
        return ok, time.perf_counter() - started, note

    wall = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        results = list(pool.map(one, range(requests)))
    elapsed = time.perf_counter() - wall
    latencies = [r[1] for r in results if r[0]]
    failures: dict[str, int] = {}
    for ok, _, note in results:
        if not ok:
            failures[note] = failures.get(note, 0) + 1
    return {
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "gateway": gateway, "project": project, "requests": requests, "concurrency": concurrency,
        "succeeded": len(latencies), "failed": requests - len(latencies), "failures": failures,
        "availability": round(len(latencies) / requests, 6) if requests else None,
        "duration_seconds": round(elapsed, 3),
        "requests_per_second": round(requests / elapsed, 2) if elapsed else None,
        "latency_ms": {"mean": round(statistics.fmean(latencies) * 1000, 1) if latencies else None,
                       "p50": round(percentile(latencies, 0.50) * 1000, 1),
                       "p95": round(percentile(latencies, 0.95) * 1000, 1),
                       "p99": round(percentile(latencies, 0.99) * 1000, 1),
                       "max": round(max(latencies) * 1000, 1) if latencies else None},
    }


def write_report(out: Path, load: dict, *, accuracy: dict | None = None, replicas: dict | None = None) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    report = {"test_case": "TC-C03-11", "load": load, "accuracy": accuracy, "replicas": replicas}
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    lat = load["latency_ms"]
    lines = ["# TC-C03-11 FHIR 擴充與壓測報告", "",
             f"- 時間：{load['started_at']}", f"- Gateway：{load['gateway']}；專案（租戶）：{load['project']}",
             "- 注意：開發機上的數字只證明腳本可跑，正式數字需在甲方環境重跑。", "",
             "## 可用性與壓測", "", "| 項目 | 數值 |", "|---|---|",
             f"| 請求數 | {load['requests']} |", f"| 併發 | {load['concurrency']} |",
             f"| 成功 | {load['succeeded']} |", f"| 失敗 | {load['failed']} |",
             f"| 可用性 | {load['availability']:.4%} |", f"| 每秒請求數 | {load['requests_per_second']} |",
             f"| 延遲 p50／p95／p99／最大（毫秒） | {lat['p50']}／{lat['p95']}／{lat['p99']}／{lat['max']} |", ""]
    if load["failures"]:
        lines += ["失敗原因：" + "、".join(f"{k} × {v}" for k, v in load["failures"].items()), ""]
    if replicas:
        lines += ["## 水平擴充", "", "| 上游（HAPI 副本） | 請求數 |", "|---|---|"]
        lines += [f"| {addr} | {count} |" for addr, count in sorted(replicas.items())] + [""]
    if accuracy:
        lines += ["## 轉換精確度", "", "| 項目 | 數值 |", "|---|---|",
                  f"| 比對的資源數 | {accuracy['resources']} |", f"| 比對的欄位數 | {accuracy['fields']} |",
                  f"| 差異欄位數 | {accuracy['mismatches']} |", f"| 精確度 | {accuracy['accuracy']:.4%} |", ""]
        lines += [f"- {d}" for d in accuracy["examples"]]
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out / "report.md"


def main(argv=None) -> int:
    from conftest import GATEWAY, login
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway", default=GATEWAY)
    parser.add_argument("--project", type=int, required=True)
    parser.add_argument("--username", default="admin01")
    parser.add_argument("--requests", type=int, default=400)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--out", type=Path,
                        default=Path("reports") / datetime.now().strftime("%Y-%m-%d") / "TC-C03-11")
    args = parser.parse_args(argv)
    token = os.environ.get("FHIR_TOKEN") or login(args.username)
    load = run(args.gateway, token, args.project, requests=args.requests, concurrency=args.concurrency)
    path = write_report(args.out, load)
    print(json.dumps(load, indent=2, ensure_ascii=False))
    print(f"報告：{path}")
    return 0 if load["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
