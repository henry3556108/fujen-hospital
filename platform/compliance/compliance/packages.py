"""映像內 Python 套件版本清單（TC-A01-04）：從 SBOM 取出 python 類型的元件，與已確認清單比對。"""
from __future__ import annotations

from pathlib import Path

from compliance.sbom import Subject

DIR = "python-packages"


def package_lines(subject: Subject) -> list[str]:
    return sorted({f"{name}=={version}" for name, version, kind, _ in subject.rows if kind == "python"},
                  key=str.lower)


def render(subjects: list[Subject]) -> dict[str, str]:
    files = {}
    for s in subjects:
        if s.kind not in ("image", "build") or s.error:
            continue
        lines = package_lines(s)
        if lines:
            files[f"{DIR}/{s.slug}.txt"] = "\n".join(lines) + "\n"
    return files


def write(out_dir: Path, files: dict[str, str]) -> None:
    target = out_dir / DIR
    if target.exists():
        for old in target.glob("*.txt"):
            old.unlink()
    for rel, text in files.items():
        path = out_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def compare(doc_dir: Path, fresh: dict[str, str]) -> list[str]:
    diffs = []
    target = doc_dir / DIR
    confirmed = {f"{DIR}/{p.name}" for p in target.glob("*.txt")} if target.exists() else set()
    for rel in sorted(set(fresh) - confirmed):
        diffs.append(f"{rel}：映像內有 Python 套件，但沒有已確認清單")
    for rel in sorted(confirmed - set(fresh)):
        diffs.append(f"{rel}：有已確認清單，但找不到對應映像或映像內沒有 Python 套件")
    for rel in sorted(confirmed & set(fresh)):
        old = set((doc_dir / rel).read_text(encoding="utf-8").split())
        new = set(fresh[rel].split())
        diffs += [f"{rel}：實際多出 {x}" for x in sorted(new - old)]
        diffs += [f"{rel}：實際缺少 {x}" for x in sorted(old - new)]
    return diffs
