"""模型來源。平台只向白名單登記的來源取模型；取回後核對 commit 與 hash。

- InMemoryModelSource：測試與本機整合環境用的假來源，內容是幾個位元組的設定檔，沒有任何權重。
- OfflinePreloadSource：無對外網路時的離線預載目錄，每個模型一個資料夾，內含 manifest.json。
- 正式來源（例如甲方核准的模型站鏡像）待甲方確認後再實作同一個介面。
"""
import hashlib
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


class SourceError(Exception):
    pass


class SourceUnreachable(SourceError):
    """連不上來源（無對外網路）。"""


class SourceAuthError(SourceError):
    """Token 無效或缺少 Token。"""


class SourceNotFound(SourceError):
    """來源沒有這個 repo 或 commit。"""


def content_hash(files: Mapping[str, bytes]) -> str:
    """整個模型的 hash：依檔名排序，檔名與內容一起算，改名或改內容都會變。"""
    digest = hashlib.sha256()
    for name in sorted(files):
        digest.update(name.encode() + b"\0" + hashlib.sha256(files[name]).digest())
    return digest.hexdigest()


def carries_code(files: Mapping[str, bytes]) -> bool:
    """模型 Repository 是否夾帶會被執行的程式碼：任何 .py 檔，或 config.json 有 auto_map。"""
    if any(name.endswith(".py") for name in files):
        return True
    try:
        config = json.loads(files.get("config.json", b"{}"))
    except ValueError:
        return False
    return isinstance(config, dict) and "auto_map" in config


@dataclass(frozen=True)
class ModelArtifact:
    repo: str
    commit: str
    files: Mapping[str, bytes]

    @property
    def sha256(self) -> str:
        return content_hash(self.files)

    @property
    def has_remote_code(self) -> bool:
        return carries_code(self.files)


class ModelSource(Protocol):
    def fetch(self, repo: str, revision: str, token: str | None) -> ModelArtifact: ...


@dataclass
class InMemoryModelSource:
    repos: dict[str, ModelArtifact] = field(default_factory=dict)
    valid_tokens: set[str] = field(default_factory=set)
    gated: set[str] = field(default_factory=set)       # 需要 Token 的 repo
    reachable: bool = True
    fetches: list[tuple[str, str]] = field(default_factory=list)

    def add(self, repo: str, commit: str, files: Mapping[str, bytes], *, gated: bool = False) -> ModelArtifact:
        artifact = ModelArtifact(repo=repo, commit=commit, files=dict(files))
        self.repos[repo] = artifact
        if gated:
            self.gated.add(repo)
        return artifact

    def fetch(self, repo, revision, token) -> ModelArtifact:
        if not self.reachable:
            raise SourceUnreachable("無法連到模型來源")
        artifact = self.repos.get(repo)
        if artifact is None or artifact.commit != revision:
            raise SourceNotFound(f"來源沒有 {repo}@{revision}")
        if repo in self.gated and token not in self.valid_tokens:
            raise SourceAuthError("Token 無效或沒有這個模型的存取權")
        self.fetches.append((repo, revision))
        return artifact


class OfflinePreloadSource:
    """離線預載：<root>/<模型名稱>/manifest.json（repo、commit）加上模型檔。"""

    def __init__(self, root: str | Path):
        self.root = Path(root)

    def fetch(self, name: str) -> ModelArtifact | None:
        folder = self.root / name
        manifest = folder / "manifest.json"
        if not manifest.is_file():
            return None
        meta = json.loads(manifest.read_text())
        files = {p.relative_to(folder).as_posix(): p.read_bytes()
                 for p in sorted(folder.rglob("*")) if p.is_file() and p.name != "manifest.json"}
        return ModelArtifact(repo=meta["repo"], commit=meta["commit"], files=files)


# 本機整合環境的假來源（LLM_MODEL_SOURCE=fake）。只有設定檔，沒有權重；不可用於甲方環境。
FAKE_SOURCE_HOST = "models.test.invalid"
FAKE_VALID_TOKEN = "hf_test_valid_token"


def fake_source() -> InMemoryModelSource:
    source = InMemoryModelSource(valid_tokens={FAKE_VALID_TOKEN})
    source.add("fake-org/fake-llm-small", "a" * 40,
               {"config.json": b'{"model_type": "fake", "hidden_size": 8}', "README.md": b"fake model, no weights"})
    source.add("fake-org/fake-llm-gated", "b" * 40,
               {"config.json": b'{"model_type": "fake", "hidden_size": 16}'}, gated=True)
    source.add("fake-org/fake-llm-remote-code", "c" * 40,
               {"config.json": b'{"model_type": "fake", "auto_map": {"AutoModel": "modeling_fake.FakeModel"}}',
                "modeling_fake.py": b"class FakeModel:\n    pass\n"})
    return source


def sources_from_env(env: Mapping[str, str] = os.environ) -> dict[str, ModelSource]:
    if env.get("LLM_MODEL_SOURCE", "").strip().lower() == "fake":
        return {FAKE_SOURCE_HOST: fake_source()}
    return {}


def offline_from_env(env: Mapping[str, str] = os.environ) -> OfflinePreloadSource | None:
    root = env.get("LLM_PRELOAD_DIR", "").strip()
    return OfflinePreloadSource(root) if root else None
