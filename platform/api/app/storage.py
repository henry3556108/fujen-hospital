"""物件儲存介面：影像、標註、CSV、模型檔都經這裡存取。

本機與單元測試用 LocalObjectStore；整合環境改用 MinIO（S3 相容）實作，介面相同。
"""
import posixpath
from pathlib import Path
from typing import Protocol


class ObjectNotFound(Exception):
    pass


def check_key(key: str) -> str:
    """只接受相對、正規的 key，避免跨專案或跳出儲存根目錄。"""
    if not key or key.startswith("/") or "\\" in key or posixpath.normpath(key) != key or key.startswith(".."):
        raise ValueError(f"不合法的物件路徑：{key!r}")
    return key


class ObjectStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...
    def list(self, prefix: str) -> list[str]: ...


class LocalObjectStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        return self.root / check_key(key)

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, key: str) -> bytes:
        path = self._path(key)
        if not path.is_file():
            raise ObjectNotFound(key)
        return path.read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def list(self, prefix: str) -> list[str]:
        if not self.root.exists():
            return []
        keys = (p.relative_to(self.root).as_posix() for p in self.root.rglob("*") if p.is_file())
        return sorted(k for k in keys if k.startswith(prefix))
