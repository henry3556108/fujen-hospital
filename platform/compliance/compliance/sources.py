"""映像來源與非專案軟體檢查（TC-D01-07）。

- 來源：每個探索到的映像都要符合 policy/image-sources.yaml 的核准來源，否則算「非受限來源」。
- 版本：沒有釘住版本（latest 之類）的映像列為警告，因為之後拉到的內容可能與授權清單不同。
- 非專案軟體：執行中的容器與叢集 Pod 用到的映像，必須都在探索到的清單裡。
"""
from __future__ import annotations

import fnmatch
import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from compliance.discover import ImageRef, Inventory, parse_image

POLICY = Path(__file__).resolve().parent.parent / "policy" / "image-sources.yaml"


@dataclass
class Policy:
    approved: list[str]
    bundled_namespaces: set[str] = field(default_factory=set)

    @classmethod
    def load(cls, path: Path = POLICY) -> "Policy":
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return cls(approved=[a["pattern"] for a in data.get("approved", [])],
                   bundled_namespaces=set(data.get("bundled_namespaces", [])))

    def allows(self, ref: ImageRef) -> bool:
        return any(fnmatch.fnmatchcase(ref.name, pattern) for pattern in self.approved)


@dataclass
class SourceReport:
    unapproved: list[str] = field(default_factory=list)      # 非受限來源
    unpinned: list[str] = field(default_factory=list)        # 未釘版本（警告）
    undeclared: list[str] = field(default_factory=list)      # 非專案軟體
    checked: int = 0
    running_checked: int = 0

    @property
    def ok(self) -> bool:
        return not self.unapproved and not self.undeclared


def check_declared(inv: Inventory, policy: Policy) -> SourceReport:
    report = SourceReport()
    for image in sorted(inv.images.values(), key=lambda i: i.key):
        report.checked += 1
        where = "、".join(sorted(image.used_by))
        if not policy.allows(image.ref):
            report.unapproved.append(f"{image.key}（{where}）")
        if not image.ref.pinned:
            report.unpinned.append(f"{image.key}（{where}）")
    return report


@dataclass(frozen=True)
class Running:
    image: str
    where: str                       # 例：compose:ai-platform/api、pod:monitoring/grafana-xxx
    compose_service: str | None = None
    namespace: str | None = None


def _same(a: ImageRef, b: ImageRef) -> bool:
    if a.name != b.name:
        return False
    if a.digest and b.digest:
        return a.digest == b.digest
    if a.tag and b.tag:
        return a.tag == b.tag
    return True


def check_running(inv: Inventory, policy: Policy, running: list[Running], report: SourceReport,
                  *, tool_images: list[str] = ()) -> SourceReport:
    declared = [i.ref for i in inv.images.values()] + [parse_image(t) for t in tool_images]
    built_services = {u.split("#", 1)[1] for b in inv.builds.values() for u in b.used_by if "#" in u}
    scan_tags = {b.scan_tag for b in inv.builds.values()}
    for item in running:
        report.running_checked += 1
        if item.namespace in policy.bundled_namespaces:
            continue  # 節點映像內建的系統元件
        if item.compose_service in built_services or item.image in scan_tags:
            continue  # 平台自建映像
        ref = parse_image(item.image)
        if not any(_same(ref, d) for d in declared):
            report.undeclared.append(f"{item.image}（{item.where}）")
    report.undeclared = sorted(set(report.undeclared))
    return report


def running_compose(project: str) -> list[Running]:
    proc = subprocess.run(["docker", "ps", "--filter", f"label=com.docker.compose.project={project}",
                           "--format", "{{json .}}"], capture_output=True, text=True, timeout=60, check=True)
    out = []
    for line in proc.stdout.splitlines():
        row = json.loads(line)
        labels = dict(kv.split("=", 1) for kv in row.get("Labels", "").split(",") if "=" in kv)
        service = labels.get("com.docker.compose.service")
        out.append(Running(image=row["Image"], where=f"compose:{project}/{service}", compose_service=service))
    return out


def running_pods(context: str) -> list[Running]:
    proc = subprocess.run(["kubectl", "--context", context, "get", "pods", "-A", "-o", "json"],
                          capture_output=True, text=True, timeout=60, check=True)
    out = []
    for pod in json.loads(proc.stdout)["items"]:
        ns, name = pod["metadata"]["namespace"], pod["metadata"]["name"]
        spec = pod["spec"]
        for c in spec.get("containers", []) + spec.get("initContainers", []):
            out.append(Running(image=c["image"], where=f"pod:{ns}/{name}", namespace=ns))
    return out
