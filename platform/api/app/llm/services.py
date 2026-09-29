"""WP7 對外部服務的相依，集中放在 app.state.llm。未設定時依環境變數延遲建立；測試直接換成記憶體版。"""
import os
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import Request

from app.llm.client import LlmClient, LlmSettings, client_from_env, settings_from_env
from app.llm.runtime import ModelRuntime, RecordingModelRuntime
from app.llm.sources import ModelSource, OfflinePreloadSource, offline_from_env, sources_from_env


@dataclass
class LlmServices:
    client: LlmClient | None = None
    settings: LlmSettings = field(default_factory=lambda: LlmSettings("fake-llm-small", "fake-embed-small"))
    sources: dict[str, ModelSource] = field(default_factory=dict)
    offline: OfflinePreloadSource | None = None
    runtime: ModelRuntime = field(default_factory=RecordingModelRuntime)
    model_dir: Path = field(default_factory=lambda: Path(tempfile.gettempdir()) / "llm-models")
    vectors: object | None = None       # app.llm.vectors.VectorStore
    wiki: object | None = None          # app.llm.wiki.WikiClient


def services_from_env(app, env: Mapping[str, str] = os.environ) -> LlmServices:
    from app.llm.vectors import store_from_env
    from app.llm.wiki import wiki_from_env
    model_dir = Path(env.get("LLM_MODEL_DIR") or Path(env.get("STORAGE_ROOT", tempfile.gettempdir())) / "llm-models")
    return LlmServices(client=client_from_env(env), settings=settings_from_env(env),
                       sources=sources_from_env(env), offline=offline_from_env(env), model_dir=model_dir,
                       vectors=store_from_env(app.state.sessionmaker, env), wiki=wiki_from_env(env))


def get_services(request: Request) -> LlmServices:
    services = getattr(request.app.state, "llm", None)
    if services is None:
        services = services_from_env(request.app)
        request.app.state.llm = services
    return services
