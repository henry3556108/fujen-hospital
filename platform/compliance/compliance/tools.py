"""外部工具（Syft、Trivy、ClamAV）一律以釘住 digest 的容器執行，版本記在 tools.lock.json。

ToolRunner 是介面：DockerToolRunner 真的跑容器，FakeToolRunner 給單元測試用。
快取（漏洞資料庫、病毒碼）放在 git 以外：$COMPLIANCE_CACHE，預設 ~/.cache/fujen-compliance。
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from compliance.discover import Build

HERE = Path(__file__).resolve().parent.parent
DOCKER_SOCK = "/var/run/docker.sock"


class ToolError(RuntimeError):
    pass


def cache_dir() -> Path:
    path = Path(os.environ.get("COMPLIANCE_CACHE") or Path.home() / ".cache" / "fujen-compliance")
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_lock(path: Path | None = None) -> dict:
    return json.loads((path or HERE / "tools.lock.json").read_text(encoding="utf-8"))


class ToolRunner(Protocol):
    def build(self, build: Build) -> None: ...
    def syft_image(self, image: str, platform: str | None = None) -> dict: ...
    def trivy_image(self, image: str, platform: str | None = None) -> dict: ...
    def sync_python(self, project_dir: Path) -> Path | None: ...
    def clamscan(self, directory: Path) -> tuple[int, str]: ...


def _run(cmd: list[str], *, timeout: int, ok: tuple[int, ...] = (0,), cwd: Path | None = None) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    if proc.returncode not in ok:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-5:]
        raise ToolError(f"{' '.join(cmd[:6])} … 結束碼 {proc.returncode}：{' | '.join(tail)}")
    return proc


@dataclass
class DockerToolRunner:
    lock: dict = field(default_factory=load_lock)
    timeout: int = 1800

    def build(self, build: Build) -> None:
        _run(["docker", "build", "-q", "-f", str(build.dockerfile), "-t", build.scan_tag, str(build.context)],
             timeout=self.timeout)

    def syft_image(self, image: str, platform: str | None = None) -> dict:
        cache = cache_dir() / "syft"
        cache.mkdir(exist_ok=True)
        cmd = ["docker", "run", "--rm", "-v", f"{DOCKER_SOCK}:{DOCKER_SOCK}", "-v", f"{cache}:/cache",
               "-e", "SYFT_CACHE_DIR=/cache", "-e", "SYFT_CHECK_FOR_APP_UPDATE=false",
               self.lock["syft"]["image"], image, "-o", "syft-json", "-q"]
        if platform:
            cmd += ["--platform", platform]
        return json.loads(_run(cmd, timeout=self.timeout).stdout)

    def trivy_image(self, image: str, platform: str | None = None) -> dict:
        cache = cache_dir() / "trivy"
        cache.mkdir(exist_ok=True)
        cmd = ["docker", "run", "--rm", "-v", f"{DOCKER_SOCK}:{DOCKER_SOCK}", "-v", f"{cache}:/root/.cache/trivy",
               self.lock["trivy"]["image"], "image", "--quiet", "--format", "json", "--scanners", "vuln",
               "--timeout", "20m"]
        if platform:
            cmd += ["--platform", platform]
        return json.loads(_run(cmd + [image], timeout=self.timeout).stdout)

    def sync_python(self, project_dir: Path) -> Path | None:
        """安裝 lock 檔鎖定的版本，回傳 site-packages；供讀取套件的授權資訊。"""
        try:
            _run(["uv", "sync", "--frozen", "-q"], timeout=self.timeout, cwd=project_dir)
        except (ToolError, FileNotFoundError):
            return None
        found = sorted((project_dir / ".venv").glob("lib/python*/site-packages"))
        return found[0] if found else None

    def freshclam(self) -> Path:
        db = cache_dir() / "clamav"
        db.mkdir(exist_ok=True)
        os.chmod(db, 0o777)  # 容器內以 clamav 使用者寫入
        _run(["docker", "run", "--rm", "-v", f"{db}:/var/lib/clamav", "--entrypoint", "freshclam",
              self.lock["clamav"]["image"], "--quiet", "--foreground", "--stdout"], timeout=self.timeout)
        return db

    def clamscan(self, directory: Path) -> tuple[int, str]:
        """回傳（結束碼, 輸出）。clamscan：0 = 乾淨、1 = 發現病毒、2 = 執行錯誤。"""
        db = self.freshclam()
        proc = _run(["docker", "run", "--rm", "-v", f"{db}:/var/lib/clamav:ro", "-v", f"{directory}:/scan:ro",
                     "--entrypoint", "clamscan", self.lock["clamav"]["image"],
                     "--recursive", "--infected", "--no-summary", "--stdout", "/scan"],
                    timeout=self.timeout, ok=(0, 1))
        return proc.returncode, proc.stdout


@dataclass
class FakeToolRunner:
    """單元測試用：回傳事先放好的輸出，並記下被呼叫的內容。"""
    sboms: dict[str, dict] = field(default_factory=dict)
    vulns: dict[str, dict] = field(default_factory=dict)
    site_packages: dict[str, Path] = field(default_factory=dict)
    clam: tuple[int, str] = (0, "")
    calls: list[tuple] = field(default_factory=list)
    fail: set[str] = field(default_factory=set)

    def build(self, build: Build) -> None:
        self.calls.append(("build", build.name))

    def syft_image(self, image: str, platform: str | None = None) -> dict:
        self.calls.append(("syft", image, platform))
        if image in self.fail:
            raise ToolError(f"無法取得映像 {image}")
        return self.sboms[image]

    def trivy_image(self, image: str, platform: str | None = None) -> dict:
        self.calls.append(("trivy", image, platform))
        if image in self.fail:
            raise ToolError(f"無法取得映像 {image}")
        return self.vulns[image]

    def sync_python(self, project_dir: Path) -> Path | None:
        self.calls.append(("sync", project_dir.name))
        return self.site_packages.get(project_dir.name)

    def clamscan(self, directory: Path) -> tuple[int, str]:
        self.calls.append(("clamscan", str(directory)))
        return self.clam
