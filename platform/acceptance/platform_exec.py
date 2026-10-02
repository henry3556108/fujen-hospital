"""在部署好的平台內部執行指令：Docker Compose 或 Kubernetes（platform/deploy/k8s）。

驗收測試有些步驟要看不對外開放的東西（資料庫的稽核表、物件儲存、服務的環境變數），或要停掉一個服務。
compose 用 `docker compose -p <專案> exec`；Kubernetes 用 `kubectl -n <命名空間> exec`。

環境變數（二擇一）：
  COMPOSE_PROJECT   compose 專案名稱
  K8S_NAMESPACE     Kubernetes 命名空間（例：ai-platform）；設定後優先使用
"""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE_PROJECT = os.environ.get("COMPOSE_PROJECT")
K8S_NAMESPACE = os.environ.get("K8S_NAMESPACE")
AVAILABLE = bool(COMPOSE_PROJECT or K8S_NAMESPACE)
REASON = "設定 COMPOSE_PROJECT（compose）或 K8S_NAMESPACE（Kubernetes）才能查看平台內部"

# Kubernetes：compose 服務名稱 → 工作負載
WORKLOADS = {"postgres": "statefulset/postgres", "orthanc": "statefulset/orthanc", "minio": "statefulset/minio",
             "clamav": "statefulset/clamav", "mlflow": "statefulset/mlflow", "orthanc-pacs": "statefulset/orthanc-pacs"}


def workload(service: str) -> str:
    return WORKLOADS.get(service, f"deployment/{service}")


def kubectl(*args: str, stdin: str | None = None, timeout: float = 300, check: bool = True
            ) -> subprocess.CompletedProcess:
    return subprocess.run(["kubectl", "-n", K8S_NAMESPACE, *args], input=stdin, capture_output=True, text=True,
                          timeout=timeout, check=check)


def compose(*args: str, stdin: str | None = None, timeout: float = 300, check: bool = True
            ) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", "compose", "-p", COMPOSE_PROJECT, *args], input=stdin, capture_output=True,
                          text=True, timeout=timeout, check=check, cwd=ROOT / "deploy" / "local")


def exec_in(service: str, *command: str, stdin: str | None = None, timeout: float = 300, check: bool = True
            ) -> subprocess.CompletedProcess:
    assert AVAILABLE, REASON
    if K8S_NAMESPACE:
        flags = ["-i"] if stdin is not None else []
        return kubectl("exec", *flags, workload(service), "--", *command, stdin=stdin, timeout=timeout, check=check)
    return compose("exec", "-T", service, *command, stdin=stdin, timeout=timeout, check=check)


def psql(database: str, sql: str) -> str:
    """以 stdin 送 SQL；回傳 -qtA 的輸出。"""
    return exec_in("postgres", "psql", "-U", "platform", "-d", database, "-v", "ON_ERROR_STOP=1", "-qtA", "-f", "-",
                   stdin=sql).stdout


def sql(query: str, database: str = "platform") -> str:
    return exec_in("postgres", "psql", "-U", "platform", "-d", database, "-tAc", query).stdout.strip()


def env_of(service: str, name: str) -> str:
    out = exec_in(service, "printenv", name, check=False, timeout=60)
    return out.stdout.strip() if out.returncode == 0 else ""


def stop(service: str) -> None:
    """停掉一個服務（Kubernetes：縮到 0 份並等 Pod 消失）。"""
    assert AVAILABLE, REASON
    if K8S_NAMESPACE:
        kubectl("scale", workload(service), "--replicas=0")
        kubectl("wait", "--for=delete", "pod", "-l", f"app={service}", "--timeout=120s", check=False)
    else:
        compose("stop", service, timeout=120)


def start(service: str, replicas: int = 1) -> None:
    assert AVAILABLE, REASON
    if K8S_NAMESPACE:
        kubectl("scale", workload(service), f"--replicas={replicas}")
        kubectl("rollout", "status", workload(service), "--timeout=600s", timeout=660)
    else:
        compose("start", service, timeout=120)


def kill(service: str) -> None:
    """強制結束（不等程序收尾）。Kubernetes：立即刪除 Pod，由控制器重建。"""
    assert AVAILABLE, REASON
    if K8S_NAMESPACE:
        kubectl("delete", "pod", "-l", f"app={service}", "--grace-period=0", "--force", "--wait=false")
    else:
        compose("kill", service)


def pod_addresses(service: str) -> list[str]:
    """Kubernetes：服務每一份 Pod 的 IP（Running）。"""
    out = kubectl("get", "pod", "-l", f"app={service}", "--field-selector=status.phase=Running",
                  "-o", "jsonpath={range .items[*]}{.status.podIP}{\"\\n\"}{end}")
    return [line for line in out.stdout.split() if line]


def fetch_from_namespace(namespace: str, url: str, timeout: int = 5, labels: dict[str, str] | None = None
                         ) -> subprocess.CompletedProcess:
    """Kubernetes：在指定命名空間起一個臨時 Pod 發出 GET（busybox 的 wget），回傳 wget 的結果。
    labels 用來模擬某一種用戶端（NetworkPolicy 以標籤判斷）。"""
    name = f"probe-{int(time.time() * 1000) % 10**9}"
    overrides = ('{"spec":{"nodeSelector":{"platform/pool":"cpu-web"},"automountServiceAccountToken":false}}')
    cmd = ["kubectl", "-n", namespace, "run", name, "--rm", "-i", "--restart=Never", "--quiet",
           "--image=busybox:1.36", "--image-pull-policy=IfNotPresent", f"--overrides={overrides}"]
    if labels:
        cmd.append("--labels=" + ",".join(f"{k}={v}" for k, v in labels.items()))
    cmd += ["--", "wget", "-q", "-T", str(timeout), "-O", "-", url]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=120)


def logs_since(service: str, since: str) -> str:
    """since：RFC 3339 時間。Kubernetes：所有 Pod 的紀錄。"""
    if K8S_NAMESPACE:
        return kubectl("logs", "-l", f"app={service}", f"--since-time={since}", "--tail=-1", "--max-log-requests=10",
                       check=False).stdout
    ids = compose("ps", "-q", service).stdout.split()
    return "".join(subprocess.run(["docker", "logs", "--since", since, i], capture_output=True, text=True).stdout
                   for i in ids)
