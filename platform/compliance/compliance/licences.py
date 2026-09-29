"""授權清單（TC-D01-01）：產生文件，以及「重新掃描 vs 文件」的比對。差異 0 才算通過。"""
from __future__ import annotations

import csv
import io
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from compliance.sbom import Row, Subject

SUMMARY = "第三方授權清單.md"
LIST_DIR = "licence-list"
UNKNOWN = "（未標示）"


def rows_csv(rows: list[Row]) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(["name", "version", "type", "licences"])
    writer.writerows(rows)
    return out.getvalue()


def read_rows(path: Path) -> list[Row]:
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        next(reader, None)
        return [tuple(r) for r in reader]  # type: ignore[misc]


def index_entry(s: Subject) -> dict:
    return {"kind": s.kind, "name": s.name, "file": f"{s.slug}.csv", "components": len(s.rows), **s.meta}


def summary_md(subjects: list[Subject], tools: dict) -> str:
    lines = [
        "# 第三方軟體授權清單", "",
        "本文件由 `python -m compliance licences generate` 產生，請勿手改；內容與實際使用的差異由 "
        "`python -m compliance licences check` 重新掃描比對（TC-D01-01，差異須為 0）。",
        "", f"掃描工具：Syft {tools['syft']['version']}（`{tools['syft']['image']}`）。"
        "完整元件列在 `licence-list/` 下，每個對象一份 CSV（名稱、版本、類型、授權）。",
        "", "涵蓋範圍：容器映像（含作業系統套件與映像內的函式庫）、平台自建映像、各子專案的 Python 與 Node 套件。"
        "主機作業系統、GPU 驅動、AI 模型與 LLM 權重不在此清單，見 `掃毒與來源檢核說明.md`。",
        "", "## 容器映像", "",
        "| 映像 | 作業系統 | 架構 | digest | 元件數 | 未標示授權 | 引用位置 |", "|---|---|---|---|---|---|---|",
    ]
    for s in (x for x in subjects if x.kind == "image"):
        digest = "<br>".join(d.split("@")[-1][:19] + "…" for d in s.meta.get("repo_digests", [])) or "—"
        tag_note = "" if s.meta.get("pinned", True) else "（**未釘版本**）"
        lines.append(f"| `{s.name}`{tag_note} | {s.meta.get('os') or '—'} | {s.meta.get('architecture') or '—'} | "
                     f"{digest} | {len(s.rows)} | {_unknown(s)} | {_used(s)} |")
    lines += ["", "## 平台自建映像", "", "| 映像 | 基底映像 | 作業系統 | 元件數 | 未標示授權 | 引用位置 |",
              "|---|---|---|---|---|---|"]
    for s in (x for x in subjects if x.kind == "build"):
        bases = "<br>".join(f"`{b}`" for b in s.meta.get("base_images", [])) or "—"
        lines.append(f"| {s.name} | {bases} | {s.meta.get('os') or '—'} | {len(s.rows)} | {_unknown(s)} | {_used(s)} |")
    lines += ["", "## 套件集合", "", "| 對象 | lock 檔 | 套件數 | 未標示授權 |", "|---|---|---|---|"]
    for s in (x for x in subjects if x.kind in ("python", "node")):
        lines.append(f"| {s.name} | `{s.meta.get('lock', '')}` | {len(s.rows)} | {_unknown(s)} |")
    lines += ["", "## 授權分布（所有對象合計，依元件數）", "", "| 授權 | 元件數 |", "|---|---|"]
    counts = Counter(r[3] or UNKNOWN for s in subjects for r in s.rows)
    for licence, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append(f"| {licence.replace('|', '／')} | {n} |")
    lines += ["", "## 掃描工具", "", "| 工具 | 版本 | 映像 | 來源 | 授權 |", "|---|---|---|---|---|"]
    for name, t in sorted(tools.items()):
        lines.append(f"| {name} | {t['version']} | `{t['image']}` | {t['source']} | {t['licence']} |")
    return "\n".join(lines) + "\n"


def _unknown(s: Subject) -> int:
    return sum(1 for r in s.rows if not r[3])


def _used(s: Subject) -> str:
    return "<br>".join(f"`{u}`" for u in s.meta.get("used_by", [])) or "—"


def render(subjects: list[Subject], tools: dict) -> dict[str, str]:
    """相對路徑 → 檔案內容。產生與比對用同一個函式，所以文件格式改了也不會誤判。"""
    ok = [s for s in subjects if s.error is None]
    files = {f"{LIST_DIR}/{s.slug}.csv": rows_csv(s.rows) for s in ok}
    files[f"{LIST_DIR}/index.json"] = json.dumps([index_entry(s) for s in ok], ensure_ascii=False, indent=2) + "\n"
    files[SUMMARY] = summary_md(ok, tools)
    return files


def write(out_dir: Path, files: dict[str, str]) -> None:
    listing = out_dir / LIST_DIR
    if listing.exists():
        for old in listing.iterdir():
            if old.suffix in (".csv", ".json"):
                old.unlink()
    for rel, text in files.items():
        path = out_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


@dataclass
class Difference:
    subject: str
    kind: str        # 多出對象 | 缺少對象 | 多出元件 | 缺少元件 | 版本或授權不同 | 摘要不同
    detail: str

    def __str__(self) -> str:
        return f"{self.subject}：{self.kind} {self.detail}"


def compare(doc_dir: Path, fresh: dict[str, str]) -> list[Difference]:
    """doc_dir 是已 commit 的文件；fresh 是重新掃描後 render 的結果。"""
    diffs: list[Difference] = []
    listing = doc_dir / LIST_DIR
    documented = {f"{LIST_DIR}/{p.name}" for p in listing.glob("*.csv")} if listing.exists() else set()
    scanned = {k for k in fresh if k.endswith(".csv")}
    for rel in sorted(scanned - documented):
        diffs.append(Difference(rel, "多出對象", "實際使用但文件沒有"))
    for rel in sorted(documented - scanned):
        diffs.append(Difference(rel, "缺少對象", "文件有但實際掃不到"))
    for rel in sorted(scanned & documented):
        old, new = set(read_rows(doc_dir / rel)), set(_parse(fresh[rel]))
        added, removed = new - old, old - new
        changed = {(r[0], r[2]) for r in added} & {(r[0], r[2]) for r in removed}
        for key in sorted(changed):
            was = "、".join(f"{r[1]}［{r[3]}］" for r in sorted(removed) if (r[0], r[2]) == key)
            now = "、".join(f"{r[1]}［{r[3]}］" for r in sorted(added) if (r[0], r[2]) == key)
            diffs.append(Difference(rel, "版本或授權不同", f"{key[0]}：文件 {was}，實際 {now}"))
        for r in sorted(added):
            if (r[0], r[2]) not in changed:
                diffs.append(Difference(rel, "多出元件", f"{r[0]} {r[1]}"))
        for r in sorted(removed):
            if (r[0], r[2]) not in changed:
                diffs.append(Difference(rel, "缺少元件", f"{r[0]} {r[1]}"))
    index_rel = f"{LIST_DIR}/index.json"
    index_path = doc_dir / index_rel
    if not index_path.exists():
        diffs.append(Difference(index_rel, "缺少對象", "文件不存在，請先執行 licences generate"))
    else:
        old_index = {e["file"]: e for e in json.loads(index_path.read_text(encoding="utf-8"))}
        for entry in json.loads(fresh[index_rel]):
            old = old_index.get(entry["file"])
            if old is None:
                continue  # 已在上面列為多出對象
            for key in sorted(set(old) | set(entry)):
                if key != "components" and old.get(key) != entry.get(key):
                    diffs.append(Difference(f"{LIST_DIR}/{entry['file']}", "摘要不同",
                                            f"{key}：文件 {old.get(key)}，實際 {entry.get(key)}"))
    summary_path = doc_dir / SUMMARY
    if not summary_path.exists():
        diffs.append(Difference(SUMMARY, "缺少對象", "文件不存在，請先執行 licences generate"))
    elif not diffs and summary_path.read_text(encoding="utf-8") != fresh[SUMMARY]:
        diffs.append(Difference(SUMMARY, "摘要不同", "摘要文件與重新產生的內容不一致（可能被手動修改）"))
    return diffs


def _parse(text: str) -> list[Row]:
    reader = csv.reader(io.StringIO(text))
    next(reader, None)
    return [tuple(r) for r in reader]  # type: ignore[misc]
