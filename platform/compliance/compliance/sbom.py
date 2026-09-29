"""把 Syft 的輸出與 lock 檔整理成一致的元件列：（名稱, 版本, 類型, 授權）。"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from email.parser import HeaderParser
from pathlib import Path

from compliance.discover import Build, Image, Inventory, PackageSet, node_packages, python_packages
from compliance.tools import ToolError, ToolRunner

Row = tuple[str, str, str, str]
NOT_INSTALLED = "（本平台未安裝，授權未讀取）"


@dataclass
class Subject:
    """授權清單的一個對象：外部映像、自建映像，或一組套件。"""
    kind: str                       # image | build | python | node
    name: str                       # 顯示名稱
    slug: str                       # 檔名
    rows: list[Row] = field(default_factory=list)
    meta: dict = field(default_factory=dict)
    error: str | None = None


def slugify(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("_")


def licences_of(artifact: dict) -> str:
    values = set()
    for lic in artifact.get("licenses") or []:
        value = (lic.get("spdxExpression") or lic.get("value") or "").strip()
        if value:
            values.add(" ".join(value.split())[:120])
    return "; ".join(sorted(values))


def rows_from_syft(sbom: dict) -> list[Row]:
    rows = {(a.get("name", ""), a.get("version", ""), a.get("type", ""), licences_of(a))
            for a in sbom.get("artifacts", [])}
    return sorted(rows)


def image_meta(sbom: dict) -> dict:
    src = (sbom.get("source") or {}).get("metadata") or {}
    distro = sbom.get("distro") or {}
    return {
        "repo_digests": sorted(src.get("repoDigests") or []),
        "architecture": src.get("architecture", ""),
        "os": " ".join(x for x in (distro.get("name") or distro.get("id") or "", distro.get("versionID") or "") if x),
    }


def licence_from_metadata(text: str) -> str:
    msg = HeaderParser().parsestr(text)
    if msg.get("License-Expression"):
        return msg["License-Expression"].strip()
    classifiers = sorted({c.split("::")[-1].strip() for c in msg.get_all("Classifier") or []
                          if c.startswith("License ::")})
    if classifiers:
        return "; ".join(classifiers)
    first = (msg.get("License") or "").strip().splitlines()
    return first[0].strip()[:120] if first else ""


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def installed_licences(site_packages: Path) -> dict[str, str]:
    found = {}
    for meta in site_packages.glob("*.dist-info/METADATA"):
        text = meta.read_text(encoding="utf-8", errors="replace")
        name = HeaderParser().parsestr(text).get("Name")
        if name:
            found[_norm(name)] = licence_from_metadata(text)
    return found


def scan_image(runner: ToolRunner, image: Image) -> Subject:
    platform = sorted(image.platforms)[0] if image.platforms else None
    subject = Subject("image", image.key, slugify("image-" + image.key),
                      meta={"used_by": sorted(image.used_by), "pinned": image.ref.pinned})
    try:
        sbom = runner.syft_image(image.key, platform)
    except ToolError as exc:
        subject.error = str(exc)
        return subject
    subject.rows = rows_from_syft(sbom)
    subject.meta.update(image_meta(sbom))
    return subject


def scan_build(runner: ToolRunner, build: Build) -> Subject:
    subject = Subject("build", f"自建映像 {build.name}", slugify("build-" + build.name),
                      meta={"used_by": sorted(build.used_by), "base_images": [str(b) for b in build.base_images]})
    try:
        runner.build(build)
        sbom = runner.syft_image(build.scan_tag)
    except ToolError as exc:
        subject.error = str(exc)
        return subject
    subject.rows = rows_from_syft(sbom)
    meta = image_meta(sbom)
    meta.pop("repo_digests")  # 自建映像每次建置的 ID 都不同，不列入比對
    subject.meta.update(meta)
    return subject


def scan_package_set(runner: ToolRunner, pkgs: PackageSet) -> Subject:
    subject = Subject(pkgs.kind, f"{'Python' if pkgs.kind == 'python' else 'Node'} 套件 {pkgs.name}",
                      slugify(f"{pkgs.kind}-{pkgs.name}"), meta={"lock": pkgs.name + "/" + pkgs.path.name})
    if pkgs.kind == "node":
        subject.rows = sorted({(n, v, "npm", lic) for n, v, lic in node_packages(pkgs.path)})
        return subject
    site = runner.sync_python(pkgs.path.parent)
    licences = installed_licences(site) if site else {}
    if site is None:
        subject.meta["note"] = "無法安裝 lock 檔（uv sync --frozen 失敗），授權未讀取"
    subject.rows = sorted({(n, v, "python", licences.get(_norm(n), NOT_INSTALLED if site else ""))
                           for n, v in python_packages(pkgs.path)})
    return subject


def scan_all(runner: ToolRunner, inv: Inventory, *, progress=lambda s: None) -> list[Subject]:
    subjects = []
    for image in sorted(inv.images.values(), key=lambda i: i.key):
        progress(f"掃描映像 {image.key}")
        subjects.append(scan_image(runner, image))
    for build in sorted(inv.builds.values(), key=lambda b: b.name):
        progress(f"建置並掃描 {build.name}")
        subjects.append(scan_build(runner, build))
    for pkgs in inv.package_sets:
        progress(f"讀取套件 {pkgs.name}")
        subjects.append(scan_package_set(runner, pkgs))
    return subjects
