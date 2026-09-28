"""物件儲存介面：影像、標註、CSV、模型檔都經這裡存取。

本機與單元測試用 LocalObjectStore；整合環境改用 MinIO（S3 相容）實作，介面相同。
"""
import io
import posixpath
from collections.abc import Mapping
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


_MISSING = ("NoSuchKey", "NoSuchBucket", "NoSuchObject")


class S3ObjectStore:
    """S3 相容儲存（本機 MinIO）。bucket 在第一次使用時建立；建構時不連線。"""

    def __init__(self, *, endpoint: str, access_key: str, secret_key: str, bucket: str, secure: bool = False):
        from minio import Minio

        self.bucket = bucket
        self._client = Minio(endpoint, access_key=access_key, secret_key=secret_key, secure=secure)
        self._bucket_ready = False

    def _ensure_bucket(self) -> None:
        if not self._bucket_ready:
            if not self._client.bucket_exists(self.bucket):
                self._client.make_bucket(self.bucket)
            self._bucket_ready = True

    def put(self, key: str, data: bytes) -> None:
        check_key(key)
        self._ensure_bucket()
        self._client.put_object(self.bucket, key, io.BytesIO(data), length=len(data))

    def get(self, key: str) -> bytes:
        from minio.error import S3Error

        check_key(key)
        try:
            response = self._client.get_object(self.bucket, key)
        except S3Error as exc:
            if exc.code in _MISSING:
                raise ObjectNotFound(key) from exc
            raise
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

    def exists(self, key: str) -> bool:
        from minio.error import S3Error

        check_key(key)
        try:
            self._client.stat_object(self.bucket, key)
            return True
        except S3Error as exc:
            if exc.code in _MISSING:
                return False
            raise

    def delete(self, key: str) -> None:
        check_key(key)
        self._ensure_bucket()
        self._client.remove_object(self.bucket, key)

    def list(self, prefix: str) -> list[str]:
        self._ensure_bucket()
        return sorted(o.object_name for o in self._client.list_objects(self.bucket, prefix=prefix, recursive=True))


def store_from_env(env: Mapping[str, str]) -> ObjectStore:
    """STORAGE_BACKEND=local（預設，需 STORAGE_ROOT）或 s3（需 S3_ENDPOINT、S3_ACCESS_KEY、S3_SECRET_KEY、S3_BUCKET）。"""
    backend = env.get("STORAGE_BACKEND", "local")
    if backend == "local":
        if not env.get("STORAGE_ROOT"):
            raise RuntimeError("缺少環境變數：STORAGE_ROOT")
        return LocalObjectStore(env["STORAGE_ROOT"])
    if backend == "s3":
        missing = [n for n in ("S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET") if not env.get(n)]
        if missing:
            raise RuntimeError(f"缺少環境變數：{', '.join(missing)}")
        return S3ObjectStore(endpoint=env["S3_ENDPOINT"], access_key=env["S3_ACCESS_KEY"],
                             secret_key=env["S3_SECRET_KEY"], bucket=env["S3_BUCKET"],
                             secure=env.get("S3_SECURE", "false").lower() == "true")
    raise RuntimeError(f"不支援的 STORAGE_BACKEND：{backend!r}（可用 local、s3）")
