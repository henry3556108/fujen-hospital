"""模型執行環境：載入、卸載。甲方環境由 vLLM Deployment 實作；本機只記錄設定，不載入任何權重。"""
from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class LoadRequest:
    name: str
    location: str
    quantization: str
    cpu: int
    memory_gb: int
    gpu_type: str
    gpu_count: int
    trust_remote_code: bool


class ModelRuntime(Protocol):
    def load(self, request: LoadRequest) -> None: ...
    def unload(self, name: str) -> None: ...
    def loaded(self) -> list[LoadRequest]: ...


@dataclass
class RecordingModelRuntime:
    _loaded: dict[str, LoadRequest] = field(default_factory=dict)

    def load(self, request: LoadRequest) -> None:
        self._loaded[request.name] = request

    def unload(self, name: str) -> None:
        self._loaded.pop(name, None)

    def loaded(self) -> list[LoadRequest]:
        return list(self._loaded.values())
