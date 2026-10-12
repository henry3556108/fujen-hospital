#!/usr/bin/env python3
"""列出 components/images/kustomization.yaml 的映像（build-and-load.sh、offline/bundle.sh 用）。

  python3 images.py upstream   上游映像（name:tag 或 name@digest），一行一個
  python3 images.py built      平台建置、kind 也用到的映像（name:tag），一行一個
  python3 images.py autolabel  只用在正式環境的自動標註映像（MONAI Label 與轉接服務；platform/autolabel/build.sh 建置）
  python3 images.py gpu-services  常駐在 GPU 共享池的服務映像（MONAI Label），只載入 GPU 節點
  python3 images.py jobs       平台 API 送到叢集的 Job 映像（TRAINING_IMAGE、JOB_IMAGE），載入所有工作節點
  python3 images.py gpu-jobs   只在 GPU 池執行的 Job 映像（TRAINING_GPU_IMAGE），只載入 GPU 節點
"""
import sys
from pathlib import Path

import yaml

COMPONENT = Path(__file__).resolve().parent / "components/images/kustomization.yaml"
BUILT = {"ai-platform/api", "ai-platform/fakes", "ai-platform/trainer", "ai-platform/web",
         "ai-platform/autolabel", "ai-platform/monailabel"}
# kind 不部署（overlays/kind 用 fake-autolabel）：build-and-load.sh 不建置也不載入
PRODUCTION_ONLY = {"ai-platform/autolabel", "ai-platform/monailabel"}
GPU_SERVICES = {"ai-platform/monailabel"}


def entries() -> list[tuple[str, str]]:
    data = yaml.safe_load(COMPONENT.read_text(encoding="utf-8"))
    out = []
    for e in data["images"]:
        ref = e["newName"]
        ref += f"@{e['digest']}" if e.get("digest") else f":{e['newTag']}"
        out.append((e["name"], ref))
    return out


GPU_ONLY = {"TRAINING_GPU_IMAGE"}


def job_images(*, gpu: bool = False) -> list[str]:
    data = yaml.safe_load(COMPONENT.read_text(encoding="utf-8"))
    literals = [lit for g in data["configMapGenerator"] if g["name"] == "platform-images" for lit in g["literals"]]
    pairs = [lit.split("=", 1) for lit in literals]
    return [value for key, value in pairs if (key in GPU_ONLY) == gpu]


if __name__ == "__main__":
    kind = sys.argv[1] if len(sys.argv) > 1 else "all"
    if kind == "jobs":
        print("\n".join(job_images()))
    elif kind == "gpu-jobs":
        print("\n".join(job_images(gpu=True)))
    elif kind == "autolabel":
        print("\n".join(ref for name, ref in entries() if name in PRODUCTION_ONLY))
    elif kind == "gpu-services":
        print("\n".join(ref for name, ref in entries() if name in GPU_SERVICES))
    else:
        rows = [ref for name, ref in entries()
                if kind == "all" or ((kind == "built") == (name in BUILT) and name not in PRODUCTION_ONLY)]
        print("\n".join(rows))
