#!/usr/bin/env python3
"""列出 components/images/kustomization.yaml 的映像（build-and-load.sh、offline/bundle.sh 用）。

  python3 images.py upstream   上游映像（name:tag 或 name@digest），一行一個
  python3 images.py built      平台建置的映像（name:tag），一行一個
  python3 images.py jobs       平台 API 送到叢集的 Job 映像（TRAINING_IMAGE、JOB_IMAGE）
"""
import sys
from pathlib import Path

import yaml

COMPONENT = Path(__file__).resolve().parent / "components/images/kustomization.yaml"
BUILT = {"ai-platform/api", "ai-platform/fakes", "ai-platform/trainer", "ai-platform/web"}


def entries() -> list[tuple[str, str]]:
    data = yaml.safe_load(COMPONENT.read_text(encoding="utf-8"))
    out = []
    for e in data["images"]:
        ref = e["newName"]
        ref += f"@{e['digest']}" if e.get("digest") else f":{e['newTag']}"
        out.append((e["name"], ref))
    return out


def job_images() -> list[str]:
    data = yaml.safe_load(COMPONENT.read_text(encoding="utf-8"))
    literals = [lit for g in data["configMapGenerator"] if g["name"] == "platform-images" for lit in g["literals"]]
    return [lit.split("=", 1)[1] for lit in literals]


if __name__ == "__main__":
    kind = sys.argv[1] if len(sys.argv) > 1 else "all"
    if kind == "jobs":
        print("\n".join(job_images()))
    else:
        rows = [ref for name, ref in entries()
                if kind == "all" or (kind == "built") == (name in BUILT)]
        print("\n".join(rows))
