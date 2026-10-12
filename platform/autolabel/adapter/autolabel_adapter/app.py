"""轉接服務的 HTTP 介面（規格 1.0）與序列推論快取。

錯誤對應（平台 app/labeling/autolabel.py：4xx＝拒絕、5xx／逾時＝服務離線，兩者都不寫入標註）：
  404  模型不存在、影像不存在
  422  影像所屬序列無法組成 3D 體積（例如單張 X 光、缺片）
  502  MONAI Label 的輸出不合規格（大小、座標、標籤值不符）
  503  MONAI Label 或 DICOM 節點連不到；或這個序列的推論還沒在等候時間內完成（再送一次會用到快取）
"""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass

import numpy as np
from fastapi import FastAPI, HTTPException, Query

from autolabel_adapter import __version__, spec
from autolabel_adapter.dicomweb import DicomwebClient, DicomwebUnavailable, NotFound
from autolabel_adapter.monai import MonaiLabel, MonaiUnavailable
from autolabel_adapter.volume import LabelError, VolumeError, build_volume, labels_from_nifti

log = logging.getLogger("autolabel_adapter")


@dataclass(frozen=True)
class Settings:
    monai_url: str = "http://monai-label:8000"
    dicomweb_url: str = "http://orthanc:8042/dicom-web"
    dicomweb_username: str = ""
    dicomweb_password: str = ""
    models: frozenset[str] = frozenset()     # 空的＝MONAI Label 所有分割模型
    infer_wait_seconds: float = 22.0         # 平台等 25 秒；超過這個時間先回 503，推論在背景繼續
    monai_timeout_seconds: float = 300.0
    cache_series: int = 8
    cache_ttl_seconds: float = 3600.0
    min_slices: int = 8
    max_slices: int = 2000

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> Settings:
        d = cls()
        return cls(
            monai_url=env.get("MONAI_LABEL_URL", d.monai_url),
            dicomweb_url=env.get("DICOMWEB_URL", d.dicomweb_url),
            dicomweb_username=env.get("DICOMWEB_USERNAME", ""),
            dicomweb_password=env.get("DICOMWEB_PASSWORD", ""),
            models=frozenset(m.strip() for m in env.get("AUTOLABEL_MODELS", "").split(",") if m.strip()),
            infer_wait_seconds=float(env.get("INFER_WAIT_SECONDS") or d.infer_wait_seconds),
            monai_timeout_seconds=float(env.get("MONAI_TIMEOUT_SECONDS") or d.monai_timeout_seconds),
            cache_series=int(env.get("CACHE_SERIES") or d.cache_series),
            cache_ttl_seconds=float(env.get("CACHE_TTL_SECONDS") or d.cache_ttl_seconds),
            min_slices=int(env.get("MIN_SLICES") or d.min_slices),
            max_slices=int(env.get("MAX_SLICES") or d.max_slices),
        )


@dataclass(frozen=True)
class SeriesLabels:
    labels: np.ndarray                  # [切面, 列, 行] uint8
    index: dict[str, int]               # SOP Instance UID → 切面索引
    seconds: float                      # 取像＋推論耗時


class SeriesCache:
    """（模型, 序列）→ 標籤體積。同一個鍵同時只算一次；算好的保留 ttl 秒、最多 size 個（LRU）。"""

    def __init__(self, compute: Callable[[str, str, str], SeriesLabels], *, size: int, ttl: float, workers: int = 2):
        self._compute = compute
        self._size, self._ttl = size, ttl
        self._done: OrderedDict[tuple, tuple[float, SeriesLabels]] = OrderedDict()
        self._running: dict[tuple, Future] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="series")

    def get(self, model: str, study: str, series: str, *, wait: float) -> tuple[SeriesLabels, bool]:
        """回傳（結果, 是否來自快取）；wait 秒內沒算完丟 FutureTimeout（計算在背景繼續）。"""
        key = (model, series)
        with self._lock:
            hit = self._done.get(key)
            if hit and time.monotonic() - hit[0] < self._ttl:
                self._done.move_to_end(key)
                return hit[1], True
            self._done.pop(key, None)
            future = self._running.get(key)
            started = future is None or (future.done() and (future.cancelled() or future.exception() is not None))
            if started:                     # 沒有在算的，或上一次失敗（失敗不快取，重新算）
                future = self._pool.submit(self._compute, model, study, series)
                self._running[key] = future
        if started:
            # 鎖外註冊：已完成的 future 會在這個執行緒內直接呼叫 callback，而 _finish 要拿同一把鎖
            future.add_done_callback(lambda f, k=key: self._finish(k, f))
        return future.result(timeout=wait), False

    def _finish(self, key: tuple, future: Future) -> None:
        with self._lock:
            if self._running.get(key) is future:
                del self._running[key]
            if future.cancelled() or future.exception() is not None:
                return
            self._done[key] = (time.monotonic(), future.result())
            while len(self._done) > self._size:
                self._done.popitem(last=False)


def create_app(settings: Settings | None = None, *, monai: MonaiLabel | None = None,
               dicomweb: DicomwebClient | None = None) -> FastAPI:
    settings = settings or Settings.from_env(os.environ)
    monai = monai or MonaiLabel(settings.monai_url, timeout=settings.monai_timeout_seconds)
    dicomweb = dicomweb or DicomwebClient(settings.dicomweb_url, username=settings.dicomweb_username,
                                          password=settings.dicomweb_password)
    app = FastAPI(title="autolabel-adapter", version=__version__,
                  description="MONAI Label 轉接服務（自動標註規格 1.0）")
    models_cache: dict[str, tuple[float, dict]] = {}

    def monai_models(*, fresh: bool = False) -> tuple[dict, dict]:
        cached = models_cache.get("info")
        if fresh or not cached or time.monotonic() - cached[0] > 60:
            try:
                info = monai.info()
            except MonaiUnavailable as exc:
                raise HTTPException(503, str(exc)) from exc
            try:
                models = spec.models_from_info(info, set(settings.models) or None)
            except spec.SpecError as exc:
                raise HTTPException(502, str(exc)) from exc
            cached = (time.monotonic(), {"info": info, "models": models})
            models_cache["info"] = cached
        return cached[1]["info"], cached[1]["models"]

    def compute(model: str, study: str, series: str) -> SeriesLabels:
        started = time.monotonic()
        datasets = dicomweb.series(study, series)
        if len(datasets) > settings.max_slices:
            raise VolumeError(f"序列有 {len(datasets)} 張影像，超過上限 {settings.max_slices}")
        volume = build_volume(datasets)
        if volume.shape[0] < settings.min_slices:
            raise VolumeError(f"序列只有 {volume.shape[0]} 張切面，至少要 {settings.min_slices} 張才能做 3D 推論")
        fetched = time.monotonic()
        labels = labels_from_nifti(monai.infer_volume(model, volume.to_nifti()), volume)
        done = time.monotonic()
        log.info("推論 model=%s series=%s 切面=%d 取像 %.1fs 推論 %.1fs", model, series, volume.shape[0],
                 fetched - started, done - fetched)
        return SeriesLabels(labels=labels, index={uid: i for i, uid in enumerate(volume.sop_uids)},
                            seconds=done - started)

    cache = SeriesCache(compute, size=settings.cache_series, ttl=settings.cache_ttl_seconds)
    app.state.cache = cache

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/info/")
    def info() -> dict:
        monai_info, models = monai_models(fresh=True)
        return spec.info_response(monai_info, models)

    @app.post("/infer/{model}")
    def infer(model: str, image: str = Query(..., min_length=1)) -> dict:
        _, models = monai_models()
        if model not in models:
            raise HTTPException(404, f"模型 {model} 不存在")
        try:
            study, series = dicomweb.locate(image)
            result, cached = cache.get(model, study, series, wait=settings.infer_wait_seconds)
        except NotFound:
            raise HTTPException(404, f"影像 {image} 不存在") from None
        except DicomwebUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        except MonaiUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        except FutureTimeout:
            raise HTTPException(503, "這個序列的推論還在進行中，請稍後再送一次") from None
        except VolumeError as exc:
            raise HTTPException(422, str(exc)) from exc
        except LabelError as exc:
            raise HTTPException(502, str(exc)) from exc
        if image not in result.index:
            raise HTTPException(422, f"影像 {image} 不在組成體積的切面中（例如定位片）")
        mask = result.labels[result.index[image]]
        try:
            body = spec.segmentation_response(model, image, mask, models[model]["labels"])
        except spec.SpecError as exc:
            raise HTTPException(502, str(exc)) from exc
        log.info("infer model=%s image=%s cached=%s", model, image, cached)
        return body

    return app


def main() -> None:
    import uvicorn
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(create_app(), host="0.0.0.0", port=int(os.environ.get("PORT", "8102")))


if __name__ == "__main__":
    main()
