"""模型來源。平台只向白名單登記的來源取模型；取回後核對 commit 與 hash。

- HuggingFaceSource：Hugging Face Hub（或甲方核准的鏡像，`HF_ENDPOINT`）。邊下載邊寫檔並計算 hash，
  不把模型整個讀進記憶體；可只取白名單指定的檔案（例：只要 Q4、Q8 兩種量化版）。
- InMemoryModelSource：測試與本機整合環境用的假來源，內容是幾個位元組的設定檔，沒有任何權重。
- OfflinePreloadSource：無對外網路時的離線預載目錄，每個模型一個資料夾，內含 manifest.json。

所有來源都回傳 SourceListing：檔名對各檔內容的 sha256。整個模型的 hash 由這些檔案 hash 算出，
所以審核時（只看中繼資料）與實際下載後算出的值相同。
"""
import fnmatch
import hashlib
import json
import os
import shutil
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Protocol
from urllib.parse import quote

import httpx

CHUNK = 8 * 1024 * 1024
SMALL_FILE_BYTES = 16 * 1024 * 1024     # 非 LFS 檔案（設定檔等）審核時直接下載計算 hash 的上限
Progress = Callable[[int, int], None]   # (已下載位元組, 總位元組)


class SourceError(Exception):
    pass


class SourceUnreachable(SourceError):
    """連不上來源（無對外網路）。"""


class SourceAuthError(SourceError):
    """Token 無效或缺少 Token。"""


class SourceNotFound(SourceError):
    """來源沒有這個 repo 或 commit。"""


class SourceIntegrityError(SourceError):
    """下載的檔案與來源登記的 hash 不符。"""


def content_hash_of(digests: Mapping[str, str]) -> str:
    """整個模型的 hash：依檔名排序，檔名與各檔內容 hash 一起算，改名或改內容都會變。"""
    digest = hashlib.sha256()
    for name in sorted(digests):
        digest.update(name.encode() + b"\0" + bytes.fromhex(digests[name]))
    return digest.hexdigest()


def content_hash(files: Mapping[str, bytes]) -> str:
    return content_hash_of({name: hashlib.sha256(data).hexdigest() for name, data in files.items()})


def carries_code_of(names: Iterable[str], config: bytes | None) -> bool:
    """模型 Repository 是否夾帶會被執行的程式碼：任何 .py 檔，或 config.json 有 auto_map。"""
    if any(name.endswith(".py") for name in names):
        return True
    try:
        data = json.loads(config or b"{}")
    except ValueError:
        return False
    return isinstance(data, dict) and "auto_map" in data


def carries_code(files: Mapping[str, bytes]) -> bool:
    return carries_code_of(files, files.get("config.json"))


def selected(names: Iterable[str], include: Iterable[str] = ()) -> list[str]:
    """白名單可限定只取部分檔案（glob，比對完整路徑或檔名）；沒有指定就是全部。"""
    patterns = list(include)
    if not patterns:
        return sorted(names)
    return sorted(n for n in names
                  if any(fnmatch.fnmatch(n, p) or fnmatch.fnmatch(PurePosixPath(n).name, p) for p in patterns))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True)
class SourceListing:
    repo: str
    commit: str
    digests: Mapping[str, str]        # 檔名 → 內容 sha256
    sizes: Mapping[str, int]
    has_remote_code: bool
    gated: bool = False

    @property
    def sha256(self) -> str:
        return content_hash_of(self.digests)

    @property
    def total_bytes(self) -> int:
        return sum(self.sizes.values())


@dataclass(frozen=True)
class ModelArtifact:
    """記憶體中的模型內容（只供假來源與測試）。"""
    repo: str
    commit: str
    files: Mapping[str, bytes]

    @property
    def sha256(self) -> str:
        return content_hash(self.files)

    @property
    def has_remote_code(self) -> bool:
        return carries_code(self.files)

    def listing(self, include: Iterable[str] = ()) -> SourceListing:
        names = selected(self.files, include)
        files = {n: self.files[n] for n in names}
        return SourceListing(repo=self.repo, commit=self.commit,
                             digests={n: hashlib.sha256(d).hexdigest() for n, d in files.items()},
                             sizes={n: len(d) for n, d in files.items()}, has_remote_code=carries_code(files))


class ModelSource(Protocol):
    def latest_commit(self, repo: str, token: str | None) -> str: ...

    def inspect(self, repo: str, revision: str, token: str | None,
                include: Iterable[str] = ()) -> SourceListing: ...

    def download(self, repo: str, revision: str, token: str | None, dest: Path, include: Iterable[str] = (),
                 progress: Progress | None = None) -> SourceListing: ...


def _write(dest: Path, name: str, data: bytes) -> None:
    path = dest / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


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

    def _get(self, repo, revision, token) -> ModelArtifact:
        if not self.reachable:
            raise SourceUnreachable("無法連到模型來源")
        artifact = self.repos.get(repo)
        if artifact is None or artifact.commit != revision:
            raise SourceNotFound(f"來源沒有 {repo}@{revision}")
        if repo in self.gated and token not in self.valid_tokens:
            raise SourceAuthError("Token 無效或沒有這個模型的存取權")
        return artifact

    def latest_commit(self, repo, token) -> str:
        if not self.reachable:
            raise SourceUnreachable("無法連到模型來源")
        if repo not in self.repos:
            raise SourceNotFound(f"來源沒有 {repo}")
        return self.repos[repo].commit

    def inspect(self, repo, revision, token, include=()) -> SourceListing:
        return self._get(repo, revision, token).listing(include)

    def download(self, repo, revision, token, dest, include=(), progress=None) -> SourceListing:
        artifact = self._get(repo, revision, token)
        listing = artifact.listing(include)
        for name in listing.digests:
            _write(dest, name, artifact.files[name])
        self.fetches.append((repo, revision))
        if progress:
            progress(listing.total_bytes, listing.total_bytes)
        return listing


class HuggingFaceSource:
    """Hugging Face Hub 的 HTTP API：
    - 中繼資料：GET /api/models/{repo}/revision/{commit}?blobs=true（LFS 檔附內容 sha256）
    - 檔案：GET /{repo}/resolve/{commit}/{path}（會轉址到 CDN）
    需要授權的模型（gated）中繼資料不用 Token，下載檔案才要；Token 只放在 Authorization 標頭。"""

    def __init__(self, endpoint: str = "https://huggingface.co", *, http: httpx.Client | None = None,
                 timeout: float = 30.0):
        self.endpoint = endpoint.rstrip("/")
        self._http = http or httpx.Client(follow_redirects=True, timeout=httpx.Timeout(timeout, read=120.0))

    @staticmethod
    def _headers(token: str | None) -> dict:
        return {"Authorization": f"Bearer {token}"} if token else {}

    @staticmethod
    def _raise_for(response: httpx.Response, what: str, token: str | None) -> None:
        if response.status_code in (401, 403):
            if token:
                raise SourceAuthError("Token 無效，或這個帳號沒有取得模型的使用授權（請先到模型頁面同意授權條款）")
            raise SourceAuthError("找不到這個模型，或這個模型需要 Token（請確認名稱；受限的模型請先到模型頁面同意授權條款並提供 Token）")
        if response.status_code == 404:
            raise SourceNotFound(f"來源沒有 {what}")
        if response.status_code >= 500:
            raise SourceUnreachable(f"模型來源暫時無法使用（{response.status_code}）")
        if response.status_code >= 400:
            raise SourceError(f"模型來源回報錯誤（{response.status_code}）")

    def _fetch_meta(self, repo: str, revision: str, token: str | None) -> dict:
        url = f"{self.endpoint}/api/models/{quote(repo)}/revision/{quote(revision, safe='')}"
        try:
            response = self._http.get(url, params={"blobs": "true"}, headers=self._headers(token))
        except httpx.TransportError:
            raise SourceUnreachable("無法連到模型來源")
        self._raise_for(response, f"{repo}@{revision}", token)
        return response.json()

    def _meta(self, repo: str, revision: str, token: str | None) -> dict:
        meta = self._fetch_meta(repo, revision, token)
        if not str(meta.get("sha", "")).startswith(revision.lower()):
            raise SourceNotFound(f"來源的 {repo}@{revision} 不是固定的 commit")
        return meta

    def latest_commit(self, repo: str, token: str | None) -> str:
        """預設分支目前的 commit；只用來幫管理者查出要固定的版本，白名單與下載一律用固定的 commit。"""
        return self._fetch_meta(repo, "main", token)["sha"]

    def _url(self, repo: str, commit: str, name: str) -> str:
        return f"{self.endpoint}/{quote(repo)}/resolve/{commit}/{quote(name)}"

    def _small(self, repo: str, commit: str, name: str, token: str | None) -> bytes:
        try:
            response = self._http.get(self._url(repo, commit, name), headers=self._headers(token))
        except httpx.TransportError:
            raise SourceUnreachable("無法連到模型來源")
        self._raise_for(response, f"{repo}/{name}", token)
        return response.content

    def _listing(self, repo, revision, token, include) -> tuple[SourceListing, dict[str, bytes]]:
        meta = self._meta(repo, revision, token)
        commit = meta["sha"]
        siblings = {s["rfilename"]: s for s in meta.get("siblings", [])}
        names = selected(siblings, include)
        if not names:
            raise SourceNotFound(f"{repo}@{commit} 沒有符合指定檔案的內容")
        digests, sizes, small = {}, {}, {}
        for name in names:
            info = siblings[name]
            lfs = info.get("lfs") or {}
            if lfs.get("sha256"):
                digests[name], sizes[name] = lfs["sha256"], int(lfs.get("size") or info.get("size") or 0)
                continue
            if int(info.get("size") or 0) > SMALL_FILE_BYTES:
                raise SourceError(f"{name} 不是 LFS 檔案且大於 {SMALL_FILE_BYTES // 1024 // 1024} MB，無法核對")
            data = self._small(repo, commit, name, token)
            small[name] = data
            digests[name], sizes[name] = hashlib.sha256(data).hexdigest(), len(data)
        listing = SourceListing(repo=repo, commit=commit, digests=digests, sizes=sizes,
                                has_remote_code=carries_code_of(names, small.get("config.json")),
                                gated=bool(meta.get("gated")))
        return listing, small

    def inspect(self, repo, revision, token, include=()) -> SourceListing:
        return self._listing(repo, revision, token, include)[0]

    def download(self, repo, revision, token, dest, include=(), progress=None) -> SourceListing:
        listing, small = self._listing(repo, revision, token, include)
        done = 0
        for name in sorted(listing.digests):
            path = dest / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if name in small:
                path.write_bytes(small[name])
                done += len(small[name])
                continue
            done = self._stream(listing, name, path, token, done, progress)
        if progress:
            progress(done, listing.total_bytes)
        return listing

    def _stream(self, listing: SourceListing, name: str, path: Path, token: str | None, done: int,
                progress: Progress | None) -> int:
        partial = path.with_name(path.name + ".part")
        digest = hashlib.sha256()
        try:
            with self._http.stream("GET", self._url(listing.repo, listing.commit, name),
                                   headers=self._headers(token)) as response:
                self._raise_for(response, f"{listing.repo}/{name}", token)
                with partial.open("wb") as f:
                    for chunk in response.iter_bytes(CHUNK):
                        f.write(chunk)
                        digest.update(chunk)
                        done += len(chunk)
                        if progress:
                            progress(done, listing.total_bytes)
        except httpx.TransportError:
            partial.unlink(missing_ok=True)
            raise SourceUnreachable(f"下載 {name} 時連線中斷")
        if digest.hexdigest() != listing.digests[name]:
            partial.unlink(missing_ok=True)
            raise SourceIntegrityError(f"{name} 的內容 hash 與來源登記的不同")
        partial.replace(path)
        return done


class OfflinePreloadSource:
    """離線預載：<root>/<模型名稱>/manifest.json（repo、commit）加上模型檔。檔案留在原地，安裝時才複製。"""

    def __init__(self, root: str | Path):
        self.root = Path(root)

    def locate(self, name: str, include: Iterable[str] = ()) -> tuple[SourceListing, Path] | None:
        folder = self.root / name
        manifest = folder / "manifest.json"
        if not manifest.is_file():
            return None
        meta = json.loads(manifest.read_text())
        paths = {p.relative_to(folder).as_posix(): p
                 for p in sorted(folder.rglob("*")) if p.is_file() and p.name != "manifest.json"}
        names = selected(paths, include)
        config = paths["config.json"].read_bytes() if "config.json" in names else None
        listing = SourceListing(repo=meta["repo"], commit=meta["commit"],
                                digests={n: file_sha256(paths[n]) for n in names},
                                sizes={n: paths[n].stat().st_size for n in names},
                                has_remote_code=carries_code_of(names, config))
        return listing, folder

    @staticmethod
    def copy(listing: SourceListing, folder: Path, dest: Path) -> None:
        for name in listing.digests:
            (dest / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(folder / name, dest / name)


# 本機整合環境的假來源（LLM_MODEL_SOURCE 含 fake）。只有設定檔，沒有權重；不可用於甲方環境。
FAKE_SOURCE_HOST = "models.test.invalid"
FAKE_VALID_TOKEN = "hf_test_valid_token"
HF_SOURCE_HOST = "huggingface.co"


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
    """LLM_MODEL_SOURCE：逗號分隔，fake 和／或 huggingface。白名單的「來源」欄位填對應的主機名稱。
    HF_ENDPOINT 可改指甲方核准的鏡像站（白名單來源仍記為 huggingface.co）。"""
    wanted = {s.strip().lower() for s in env.get("LLM_MODEL_SOURCE", "").split(",") if s.strip()}
    sources: dict[str, ModelSource] = {}
    if "fake" in wanted:
        sources[FAKE_SOURCE_HOST] = fake_source()
    if "huggingface" in wanted:
        sources[HF_SOURCE_HOST] = HuggingFaceSource(env.get("HF_ENDPOINT") or "https://huggingface.co")
    return sources


def offline_from_env(env: Mapping[str, str] = os.environ) -> OfflinePreloadSource | None:
    root = env.get("LLM_PRELOAD_DIR", "").strip()
    return OfflinePreloadSource(root) if root else None
