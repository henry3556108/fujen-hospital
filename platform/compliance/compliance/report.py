"""測試報告（TC-DAILY-03）：彙整所有 junit 結果與合規檢查的總結行，缺陷依阻斷、嚴重、一般分級。"""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path

import yaml

POLICY = Path(__file__).resolve().parent.parent / "policy" / "severity.yaml"
TC = re.compile(r"(?i)tc[-_]([a-z]+[0-9]*)[-_]([0-9]{2})")
GRADES = ["阻斷", "嚴重", "一般"]
CHECK_LINE = re.compile(r"^(PASS|FAIL|WARN)\s+(\S+)\s+(.*)$")


@dataclass
class Case:
    suite: str
    name: str
    classname: str
    outcome: str            # passed | failed | error | skipped
    message: str = ""
    tc: str | None = None
    grade: str | None = None


@dataclass
class Report:
    cases: list[Case] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)

    def count(self, outcome: str) -> int:
        return sum(1 for c in self.cases if c.outcome == outcome)

    @property
    def defects(self) -> list[Case]:
        return [c for c in self.cases if c.outcome in ("failed", "error")]


def tc_id(text: str) -> str | None:
    m = TC.search(text)
    return f"TC-{m.group(1).upper()}-{m.group(2)}" if m else None


def grade(case: Case, policy: dict) -> str:
    if case.outcome == "error":
        return policy.get("error_grade", "阻斷")
    for rule in policy.get("rules", []):
        if case.tc and case.tc.startswith(rule["match"]):
            return rule["grade"]
    return policy.get("default", "一般")


def parse_junit(path: Path, suite: str) -> list[Case]:
    root = ET.parse(path).getroot()
    cases = []
    for tc in root.iter("testcase"):
        outcome, message = "passed", ""
        for tag, name in (("failure", "failed"), ("error", "error"), ("skipped", "skipped")):
            el = tc.find(tag)
            if el is not None:
                outcome, message = name, (el.get("message") or el.text or "").strip()
                break
        name, classname = tc.get("name", ""), tc.get("classname", "")
        cases.append(Case(suite, name, classname, outcome, message[:500], tc_id(f"{name} {classname}")))
    return cases


def parse_checks(path: Path) -> list[Case]:
    """合規指令的總結行（PASS／FAIL／WARN  <ID>  <說明>）。WARN 視為通過，但保留說明。"""
    cases = []
    for line in path.read_text(encoding="utf-8").splitlines():
        m = CHECK_LINE.match(line.strip())
        if m:
            status, ident, text = m.groups()
            cases.append(Case("compliance", f"{ident} {text[:80]}", "compliance",
                              "failed" if status == "FAIL" else "passed", text, tc_id(ident)))
    return cases


def build(junit: list[tuple[str, Path]], checks: list[Path] = (), policy_path: Path = POLICY) -> Report:
    policy = yaml.safe_load(policy_path.read_text(encoding="utf-8"))
    report = Report()
    for suite, path in junit:
        try:
            report.cases += parse_junit(path, suite)
            report.sources.append(str(path))
        except (ET.ParseError, OSError) as exc:
            report.unreadable.append(f"{path}：{exc}")
    for path in checks:
        report.cases += parse_checks(path)
        report.sources.append(str(path))
    for case in report.defects:
        case.grade = grade(case, policy)
    return report


def markdown(report: Report, title: str) -> str:
    total = len(report.cases)
    lines = [f"# {title}", "",
             f"| 合計 | 通過 | 失敗 | 錯誤 | 略過 |", "|---|---|---|---|---|",
             f"| {total} | {report.count('passed')} | {report.count('failed')} | {report.count('error')} | {report.count('skipped')} |",
             "", "## 缺陷", ""]
    if not report.defects:
        lines.append("無。")
    for g in GRADES:
        items = [c for c in report.defects if c.grade == g]
        if items:
            lines += [f"### {g}（{len(items)}）", "", "| 測試集 | 案例 | TC | 訊息 |", "|---|---|---|---|"]
            lines += [f"| {c.suite} | `{c.name}` | {c.tc or '—'} | {c.message.splitlines()[0][:160].replace('|', '／') if c.message else ''} |"
                      for c in items]
            lines.append("")
    by_suite: dict[str, list[Case]] = {}
    for c in report.cases:
        by_suite.setdefault(c.suite, []).append(c)
    lines += ["", "## 各測試集", "", "| 測試集 | 通過 | 失敗 | 錯誤 | 略過 |", "|---|---|---|---|---|"]
    for suite, cases in by_suite.items():
        n = lambda o: sum(1 for c in cases if c.outcome == o)  # noqa: E731
        lines.append(f"| {suite} | {n('passed')} | {n('failed')} | {n('error')} | {n('skipped')} |")
    skipped = [c for c in report.cases if c.outcome == "skipped"]
    if skipped:
        lines += ["", "## 略過的案例與原因", "", "| 測試集 | 案例 | 原因 |", "|---|---|---|"]
        lines += [f"| {c.suite} | `{c.name}` | {c.message.splitlines()[0][:160].replace('|', '／') if c.message else ''} |" for c in skipped]
    if report.unreadable:
        lines += ["", "## 無法讀取的結果檔", ""] + [f"- {u}" for u in report.unreadable]
    lines += ["", "## 來源", ""] + [f"- `{s}`" for s in report.sources]
    return "\n".join(lines) + "\n"


def write(report: Report, out_dir: Path, title: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.md").write_text(markdown(report, title), encoding="utf-8")
    (out_dir / "report.json").write_text(json.dumps([asdict(c) for c in report.cases], ensure_ascii=False, indent=1),
                                         encoding="utf-8")
    return out_dir / "report.md"
