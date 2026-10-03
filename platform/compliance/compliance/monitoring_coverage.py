"""監控覆蓋（TC-DAILY-02）：已部署服務 vs Prometheus 抓取目標。

服務清單從叢集探索（所有命名空間的 Deployment、StatefulSet、DaemonSet，扣除政策排除的系統命名空間）。
每個服務要嘛有同名、狀態 up 的抓取工作（服務探索的目標還要同命名空間），要嘛列在政策的「只以容器指標覆蓋」且確實有 cAdvisor 容器指標。
compose 堆疊的服務（開發機才有）另列：Prometheus 在叢集內，抓不到 compose 的容器，照實列為未覆蓋。
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import yaml

POLICY = Path(__file__).resolve().parent.parent / "policy" / "monitoring.yaml"


@dataclass
class Policy:
    excluded_namespaces: set[str]
    container_only: set[str]
    per_node_jobs: list[str]

    @classmethod
    def load(cls, path: Path = POLICY) -> "Policy":
        d = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return cls(set(d.get("excluded_namespaces", [])), set(d.get("container_metrics_only", [])),
                   list(d.get("per_node_jobs", [])))


@dataclass
class Workload:
    namespace: str
    name: str
    pods: list[str]

    @property
    def key(self) -> str:
        return f"{self.namespace}/{self.name}"


@dataclass
class Target:
    job: str
    health: str
    instance: str = ""
    node: str | None = None
    error: str = ""
    namespace: str | None = None   # 服務探索的目標（平台 Pod）才有；靜態目標沒有


@dataclass
class CoverageReport:
    covered_by_target: list[str] = field(default_factory=list)
    covered_by_container: list[str] = field(default_factory=list)
    uncovered: list[str] = field(default_factory=list)
    down: list[str] = field(default_factory=list)
    node_gaps: list[str] = field(default_factory=list)
    compose_uncovered: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not (self.uncovered or self.down or self.node_gaps or self.compose_uncovered)

    @property
    def total(self) -> int:
        return len(self.covered_by_target) + len(self.covered_by_container) + len(self.uncovered)


def evaluate(workloads: list[Workload], targets: list[Target], nodes: list[str], container_pods: set[str],
             policy: Policy, compose_services: list[str] = ()) -> CoverageReport:
    report = CoverageReport()
    def has_target(w: Workload) -> bool:
        return any(t.job == w.name and t.namespace in (None, w.namespace) for t in targets)

    report.down = sorted(f"{t.job} {t.instance}：{t.error or t.health}" for t in targets if t.health != "up")
    for w in sorted(workloads, key=lambda w: w.key):
        if w.namespace in policy.excluded_namespaces:
            continue
        if has_target(w):
            report.covered_by_target.append(w.key)
        elif w.key in policy.container_only:
            missing = [p for p in w.pods if p not in container_pods]
            if w.pods and not missing:
                report.covered_by_container.append(w.key)
            else:
                report.uncovered.append(f"{w.key}：沒有容器指標（{'、'.join(missing) or '沒有執行中的 Pod'}）")
        else:
            report.uncovered.append(f"{w.key}：沒有抓取目標，也不在「只以容器指標覆蓋」政策內")
    for job in policy.per_node_jobs:
        seen = {t.node for t in targets if t.job == job}
        for node in sorted(set(nodes) - seen):
            report.node_gaps.append(f"節點 {node} 沒有 {job} 抓取目標")
    report.compose_uncovered = [f"compose/{s}：叢集內的 Prometheus 抓不到 compose 容器" for s in sorted(compose_services)]
    return report


def _kubectl(context: str, *args: str) -> dict:
    proc = subprocess.run(["kubectl", "--context", context, *args, "-o", "json"],
                          capture_output=True, text=True, timeout=60, check=True)
    return json.loads(proc.stdout)


def collect(context: str, prometheus: str, policy: Policy, compose_project: str | None = None) -> CoverageReport:
    workloads = []
    pods = _kubectl(context, "get", "pods", "-A")["items"]
    for kind in ("deployments", "statefulsets", "daemonsets"):
        for item in _kubectl(context, "get", kind, "-A")["items"]:
            ns, name = item["metadata"]["namespace"], item["metadata"]["name"]
            selector = (item["spec"].get("selector") or {}).get("matchLabels") or {}
            members = [p["metadata"]["name"] for p in pods if p["metadata"]["namespace"] == ns
                       and p["status"].get("phase") == "Running"
                       and selector and all((p["metadata"].get("labels") or {}).get(k) == v for k, v in selector.items())]
            workloads.append(Workload(ns, name, members))
    nodes = [n["metadata"]["name"] for n in _kubectl(context, "get", "nodes")["items"]]
    data = httpx.get(f"{prometheus}/api/v1/targets", params={"state": "active"}, timeout=15).json()["data"]
    targets = [Target(t["labels"]["job"], t["health"], t["labels"].get("instance", ""), t["labels"].get("node"),
                      t.get("lastError", ""), t["labels"].get("namespace")) for t in data["activeTargets"]]
    result = httpx.get(f"{prometheus}/api/v1/query", params={"query": 'count by (pod) (container_memory_working_set_bytes{container!=""})'},
                       timeout=15).json()["data"]["result"]
    container_pods = {r["metric"].get("pod") for r in result}
    compose = []
    if compose_project:
        proc = subprocess.run(["docker", "compose", "-p", compose_project, "ps", "--services", "--status", "running"],
                              capture_output=True, text=True, timeout=60)
        compose = proc.stdout.split()
    return evaluate(workloads, targets, nodes, container_pods, policy, compose)
