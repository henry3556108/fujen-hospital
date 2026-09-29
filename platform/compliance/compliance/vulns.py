"""Trivy 掃描結果彙整（TC-D01-07）。漏洞數量如實列出；是否擋下由 --fail-on 決定。"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]


@dataclass
class VulnSummary:
    subject: str
    counts: Counter = field(default_factory=Counter)      # 嚴重度 → 不重複的漏洞數
    fixable: Counter = field(default_factory=Counter)     # 嚴重度 → 已有修補版本的數量
    top: list[dict] = field(default_factory=list)         # CRITICAL 與 HIGH 的明細
    error: str | None = None

    @property
    def total(self) -> int:
        return sum(self.counts.values())


def summarise(subject: str, report: dict) -> VulnSummary:
    summary = VulnSummary(subject)
    seen = set()
    for result in report.get("Results") or []:
        for v in result.get("Vulnerabilities") or []:
            key = (v.get("VulnerabilityID"), v.get("PkgName"), v.get("InstalledVersion"))
            if key in seen:
                continue
            seen.add(key)
            severity = v.get("Severity") if v.get("Severity") in SEVERITIES else "UNKNOWN"
            summary.counts[severity] += 1
            if v.get("FixedVersion"):
                summary.fixable[severity] += 1
            if severity in ("CRITICAL", "HIGH"):
                summary.top.append({"id": key[0], "package": key[1], "installed": key[2],
                                    "fixed": v.get("FixedVersion") or "", "severity": severity,
                                    "target": result.get("Target", "")})
    summary.top.sort(key=lambda t: (SEVERITIES.index(t["severity"]), t["package"] or "", t["id"] or ""))
    return summary


def exceeds(summaries: list[VulnSummary], fail_on: str | None) -> list[str]:
    """fail_on=HIGH 表示出現 HIGH 以上就失敗。回傳超標的對象。"""
    if not fail_on:
        return []
    levels = SEVERITIES[: SEVERITIES.index(fail_on) + 1]
    return [f"{s.subject}：" + "、".join(f"{lv} {s.counts[lv]}" for lv in levels if s.counts[lv])
            for s in summaries if any(s.counts[lv] for lv in levels)]


def report_md(summaries: list[VulnSummary], trivy: dict, generated_at: str) -> str:
    lines = ["# 映像漏洞掃描報告", "", f"產生時間：{generated_at}；工具：Trivy {trivy['version']}（`{trivy['image']}`）。",
             "", "| 映像 | CRITICAL | HIGH | MEDIUM | LOW | UNKNOWN | 合計 | 其中已有修補版本 |",
             "|---|---|---|---|---|---|---|---|"]
    for s in summaries:
        if s.error:
            lines.append(f"| `{s.subject}` | 掃描失敗：{s.error} | | | | | | |")
            continue
        lines.append(f"| `{s.subject}` | " + " | ".join(str(s.counts[lv]) for lv in SEVERITIES)
                     + f" | {s.total} | {sum(s.fixable.values())} |")
    lines += ["", "## CRITICAL 與 HIGH 明細", ""]
    for s in summaries:
        if not s.top:
            continue
        lines += [f"### `{s.subject}`", "", "| 嚴重度 | 編號 | 套件 | 安裝版本 | 修補版本 |", "|---|---|---|---|---|"]
        lines += [f"| {t['severity']} | {t['id']} | {t['package']} | {t['installed']} | {t['fixed'] or '尚無'} |"
                  for t in s.top]
        lines.append("")
    return "\n".join(lines) + "\n"
