"""批次推論的 Job 進入點：下載輸入包 → 載入模型 → 分批預測 → 回報原始預測。

容器只拿到三個值（環境變數）：
  JOB_IO_URL     平台 API 的工作 I/O 位址（只對應這一筆推論）
  JOB_IO_TOKEN   這一筆推論的一次性 token：只能下載自己的輸入包、回報自己的結果，定案後即失效
  INFERENCE_ID   推論編號（只用於紀錄）

輸入包（tar）：
  batch.json       {"inference_id", "kind", "format": "pkl"|"h5", "card", "images": [{"name", "path", "format"}]}
  model.pkl／model.h5、preprocess.pkl（結構式）、schema.json（結構式，選用）
  input.csv（結構式）或 images/<n>（影像）

回報的是原始預測（結構式 predictions／notes，影像 results）；加預測欄、存結果、寫稽核由平台 API 做。
"""
from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx

from trainer.runner import extract

CHUNK = 32          # 影像一次送進模型的檔案數，限制記憶體用量


class BatchIO:
    def __init__(self, http: httpx.Client, url: str, token: str):
        self.http, self.url, self.headers = http, url.rstrip("/"), {"X-Job-Token": token}

    def bundle(self) -> bytes:
        response = self.http.get(f"{self.url}/bundle", headers=self.headers)
        response.raise_for_status()
        return response.content

    def complete(self, status: str, message: str = "", answer: dict | None = None) -> None:
        self.http.post(f"{self.url}/complete", headers=self.headers,
                       json={"status": status, "message": message[-1000:], "answer": answer}).raise_for_status()


def _inside(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"輸入包的路徑不合法：{relative}")
    return path


def load_predictor(meta: dict, root: Path):
    """依模型格式建立預測器（與推論服務同一份程式）。"""
    from trainer.predict import ImagePredictor, TabularPredictor

    card = meta["card"]
    if meta["format"] == "pkl":
        schema = root / "schema.json"
        return TabularPredictor((root / "model.pkl").read_bytes(), (root / "preprocess.pkl").read_bytes(), card,
                                json.loads(schema.read_text(encoding="utf-8")) if schema.is_file() else None)
    return ImagePredictor(root / "model.h5", card)


def predict(meta: dict, root: Path, predictor, chunk: int = CHUNK) -> dict[str, Any]:
    if meta["format"] == "pkl":
        return predictor.predict((root / "input.csv").read_bytes())
    images = meta.get("images") or []
    results: list[dict] = []
    for start in range(0, len(images), chunk):
        part = [(i["name"], _inside(root, i["path"]).read_bytes(), i["format"]) for i in images[start:start + chunk]]
        results.extend(predictor.predict(part)["results"])
    return {"results": results}


def run_batch(io_, workdir: Path, *, load: Callable[[dict, Path], Any] = load_predictor, chunk: int = CHUNK) -> int:
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        extract(io_.bundle(), workdir)
        meta = json.loads((workdir / "batch.json").read_text(encoding="utf-8"))
        answer = predict(meta, workdir, load(meta, workdir), chunk)
    except Exception as exc:  # noqa: BLE001  任何錯誤都要回報原因，否則平台只看得到「工作失敗」
        message = str(exc) if type(exc).__name__ == "InputError" else f"{type(exc).__name__}: {exc}"
        try:
            io_.complete("failed", message)
        except Exception:  # noqa: BLE001
            pass
        print(f"批次推論失敗：{message}", file=sys.stderr)
        return 1
    io_.complete("succeeded", answer=answer)
    return 0


def main() -> int:
    url, token = os.environ.get("JOB_IO_URL"), os.environ.get("JOB_IO_TOKEN")
    if not url or not token:
        print("缺少 JOB_IO_URL 或 JOB_IO_TOKEN", file=sys.stderr)
        return 2
    workdir = Path(os.environ.get("JOB_WORKDIR", "/work"))
    with httpx.Client(timeout=httpx.Timeout(300.0, connect=30.0),
                      transport=httpx.HTTPTransport(retries=5)) as http:
        return run_batch(BatchIO(http, url, token), workdir)


if __name__ == "__main__":
    raise SystemExit(main())
