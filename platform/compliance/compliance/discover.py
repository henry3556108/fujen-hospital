"""探索平台實際用到的映像與套件集合，不寫死清單。

來源：
- compose 檔（`compose*.y*ml`、`docker-compose*.y*ml`，含疊加檔）：`image:`、`build:`、名稱以 `_IMAGE` 結尾的環境變數
- Kubernetes 部署檔（kind 目錄下所有 YAML）：任何層級的 `image:`
- Kustomize（deploy/k8s）：`images:` 清單的實際映像；manifest 裡的邏輯名稱 `ai-platform/<服務>` 不算映像，
  平台自己建置的 `platform-*`（Dockerfile 另外列入）也不算外部映像
- 部署腳本（*.sh）裡 `kubectl apply -f https://…yaml` 的遠端部署檔
- Dockerfile 的 `FROM`
- 程式碼裡讀取名稱以 `_IMAGE` 結尾的環境變數時給的預設映像
- 套件集合：`uv.lock`、`package-lock.json`
"""
from __future__ import annotations

import json
import re
import tomllib
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

import yaml

SKIP_DIRS = {".venv", "node_modules", ".git", "__pycache__", "dist", ".tools", "reports", "test-results",
             "playwright-report", ".claude"}
COMPOSE_PATTERNS = ("compose*.yaml", "compose*.yml", "docker-compose*.yaml", "docker-compose*.yml")
IMAGE_ENV = re.compile(r"^[A-Z0-9_]*_IMAGE$")
ENV_DEFAULT_IMAGE = re.compile(r"""environ\.get\(\s*["']([A-Z0-9_]*_IMAGE)["']\s*,\s*["']([^"']+)["']""")
REMOTE_MANIFEST = re.compile(r"""https://[^\s"'\\]+\.ya?ml""")
SHELL_DEFAULT = re.compile(r"""^\s*([A-Z_][A-Z0-9_]*)=["']?\$\{\1:-([^}]+)\}["']?\s*$""", re.M)
SHELL_ASSIGN = re.compile(r"""^\s*([A-Z_][A-Z0-9_]*)=["']?([^\s"'$]+)["']?\s*$""", re.M)


@dataclass(frozen=True)
class ImageRef:
    registry: str
    repository: str
    tag: str | None = None
    digest: str | None = None

    @property
    def name(self) -> str:
        """完整名稱（不含 tag／digest），例：docker.io/library/postgres。"""
        return f"{self.registry}/{self.repository}"

    @property
    def pinned(self) -> bool:
        return self.digest is not None or (self.tag not in (None, "latest", "stable", "main", "master"))

    def __str__(self) -> str:
        out = self.name
        if self.tag:
            out += f":{self.tag}"
        if self.digest:
            out += f"@{self.digest}"
        return out


def parse_image(ref: str) -> ImageRef:
    ref = ref.strip()
    digest = None
    if "@" in ref:
        ref, digest = ref.split("@", 1)
    tag = None
    last = ref.rsplit("/", 1)[-1]
    if ":" in last:
        ref, tag = ref.rsplit(":", 1)
    parts = ref.split("/")
    if len(parts) == 1:
        registry, repo = "docker.io", f"library/{parts[0]}"
    elif "." in parts[0] or ":" in parts[0] or parts[0] == "localhost":
        registry, repo = parts[0], "/".join(parts[1:])
    else:
        registry, repo = "docker.io", "/".join(parts)
    if tag is None and digest is None:
        tag = "latest"
    return ImageRef(registry=registry, repository=repo, tag=tag, digest=digest)


@dataclass
class Image:
    """一個外部映像，以及它在哪些地方被引用。"""
    ref: ImageRef
    used_by: set[str] = field(default_factory=set)      # 例：compose:local/compose.yaml#postgres
    platforms: set[str] = field(default_factory=set)    # compose 的 platform: 指定

    @property
    def key(self) -> str:
        return str(self.ref)


@dataclass
class Build:
    """平台自己建置的映像（compose 的 build:）。"""
    name: str                   # 掃描時用的映像名稱：compliance-scan/<name>
    context: Path
    dockerfile: Path
    used_by: set[str] = field(default_factory=set)
    base_images: list[ImageRef] = field(default_factory=list)

    @property
    def scan_tag(self) -> str:
        return f"compliance-scan/{self.name}:latest"


@dataclass(frozen=True)
class PackageSet:
    kind: str                   # python | node
    path: Path                  # lock 檔
    name: str                   # 以相對路徑命名，例：api、web


@dataclass
class Inventory:
    root: Path
    images: dict[str, Image] = field(default_factory=dict)
    builds: dict[str, Build] = field(default_factory=dict)
    package_sets: list[PackageSet] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def add_image(self, ref: str, used_by: str, platform: str | None = None) -> None:
        if not ref or "$" in ref:
            self.warnings.append(f"{used_by}：映像名稱含未展開的變數，無法判斷：{ref!r}")
            return
        parsed = parse_image(ref)
        image = self.images.setdefault(str(parsed), Image(ref=parsed))
        image.used_by.add(used_by)
        if platform:
            image.platforms.add(platform)


def _walk(root: Path) -> Iterable[Path]:
    for path in sorted(root.iterdir()):
        if path.name in SKIP_DIRS:
            continue
        if path.is_dir():
            yield from _walk(path)
        else:
            yield path


def _rel(root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def _is_compose(path: Path) -> bool:
    return any(path.match(p) for p in COMPOSE_PATTERNS)


def _load_yaml_docs(path: Path) -> list:
    try:
        return [d for d in yaml.safe_load_all(path.read_text(encoding="utf-8")) if d is not None]
    except yaml.YAMLError:
        return []


def _expand(value: str, variables: dict[str, str]) -> str:
    """展開 ${VAR:-default}、${VAR}、$VAR；沒有值的保留原樣（之後會被記成警告）。"""
    def repl(m: re.Match) -> str:
        name, default = m.group(1) or m.group(3), m.group(2)
        return variables.get(name, default if default is not None else m.group(0))
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)", repl, value)


def dockerfile_bases(path: Path) -> list[ImageRef]:
    stages, bases = set(), []
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?", line, re.I)
        if not m:
            continue
        image, alias = m.group(1), m.group(2)
        if image.lower() != "scratch" and image not in stages:
            bases.append(parse_image(image))
        if alias:
            stages.add(alias)
    return bases


def _compose(inv: Inventory, path: Path) -> None:
    rel = _rel(inv.root, path)
    for doc in _load_yaml_docs(path):
        services = doc.get("services") if isinstance(doc, dict) else None
        if not isinstance(services, dict):
            continue
        for name, svc in services.items():
            if not isinstance(svc, dict):
                continue
            where = f"compose:{rel}#{name}"
            if "image" in svc:
                inv.add_image(_expand(str(svc["image"]), {}), where, svc.get("platform"))
            build = svc.get("build")
            if build:
                if isinstance(build, str):
                    build = {"context": build}
                context = (path.parent / build.get("context", ".")).resolve()
                dockerfile = (context / build.get("dockerfile", "Dockerfile")).resolve()
                _add_build(inv, context, dockerfile, where)
            env = svc.get("environment") or {}
            if isinstance(env, list):
                env = dict(item.split("=", 1) for item in env if isinstance(item, str) and "=" in item)
            for key, value in env.items():
                if IMAGE_ENV.match(str(key)) and value:
                    inv.add_image(_expand(str(value), {}), f"{where}:{key}")


def _add_build(inv: Inventory, context: Path, dockerfile: Path, used_by: str) -> None:
    key = _rel(inv.root, dockerfile)
    build = inv.builds.get(key)
    if build is None:
        name = re.sub(r"[^a-z0-9]+", "-", _rel(inv.root, dockerfile.parent).lower()).strip("-") or "root"
        if dockerfile.name != "Dockerfile":
            name += "-" + re.sub(r"[^a-z0-9]+", "-", dockerfile.name.lower()).strip("-")
        build = inv.builds[key] = Build(name=name, context=context, dockerfile=dockerfile)
        if dockerfile.exists():
            build.base_images = dockerfile_bases(dockerfile)
            for base in build.base_images:
                inv.add_image(str(base), f"dockerfile:{key}")
        else:
            inv.warnings.append(f"{used_by}：找不到 Dockerfile {key}")
    build.used_by.add(used_by)


def _images_in(node, found: list[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "image" and isinstance(value, str):
                found.append(value)
            else:
                _images_in(value, found)
    elif isinstance(node, list):
        for item in node:
            _images_in(item, found)


KUSTOMIZE_LOGICAL = "ai-platform/"     # deploy/k8s 的 manifest 只寫邏輯名稱，實際映像在 Kustomize 的 images:
PLATFORM_BUILT = re.compile(r"^platform-[a-z0-9-]+$")


def kustomize_images(text: str) -> list[str]:
    """Kustomize（kustomization.yaml、Component）的 images: 清單 → 實際映像。平台自己建置的映像不列入。"""
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError:
        return []
    if not isinstance(doc, dict) or not str(doc.get("kind", "")).startswith(("Kustomization", "Component")):
        return []
    out = []
    for entry in doc.get("images") or []:
        name = entry.get("newName") or entry.get("name")
        if not name or PLATFORM_BUILT.match(name):
            continue
        ref = name + (f":{entry['newTag']}" if entry.get("newTag") else "")
        out.append(ref + (f"@{entry['digest']}" if entry.get("digest") else ""))
    return out


def manifest_images(text: str) -> list[str]:
    found: list[str] = []
    try:
        for doc in yaml.safe_load_all(text):
            _images_in(doc, found)
    except yaml.YAMLError:
        pass
    return found


def _script(inv: Inventory, path: Path, fetch: Callable[[str], str] | None) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    variables = {m.group(1): m.group(2) for m in SHELL_ASSIGN.finditer(text)}
    variables.update({m.group(1): m.group(2) for m in SHELL_DEFAULT.finditer(text)})
    rel = _rel(inv.root, path)
    for raw in sorted(set(REMOTE_MANIFEST.findall(text))):
        url = _expand(raw, variables)
        if "$" in url:
            inv.warnings.append(f"script:{rel}：遠端部署檔網址含未展開的變數：{raw}")
            continue
        if fetch is None:
            inv.warnings.append(f"script:{rel}：未下載遠端部署檔（離線模式），其映像未列入：{url}")
            continue
        try:
            body = fetch(url)
        except Exception as exc:  # 下載失敗要讓人看到，不能默默漏掉
            inv.warnings.append(f"script:{rel}：下載遠端部署檔失敗（{type(exc).__name__}）：{url}")
            continue
        for image in manifest_images(body):
            inv.add_image(image, f"remote:{url}")


def discover(root: Path, *, fetch: Callable[[str], str] | None = None) -> Inventory:
    """root 是 platform/ 目錄。fetch(url) 取回遠端部署檔內容；None 表示離線（記成警告）。"""
    root = Path(root)
    inv = Inventory(root=root)
    dockerfiles_seen: set[str] = set()
    for path in _walk(root):
        rel = _rel(root, path)
        if _is_compose(path):
            _compose(inv, path)
        elif path.suffix in (".yaml", ".yml"):
            text = path.read_text(encoding="utf-8", errors="replace")
            for image in manifest_images(text):
                if not image.startswith(KUSTOMIZE_LOGICAL):
                    inv.add_image(image, f"manifest:{rel}")
            for image in kustomize_images(text):
                inv.add_image(image, f"kustomize:{rel}")
        elif path.suffix == ".sh":
            _script(inv, path, fetch)
        elif path.suffix == ".py" and "/tests/" not in f"/{rel}" and not path.name.startswith("test_"):
            for m in ENV_DEFAULT_IMAGE.finditer(path.read_text(encoding="utf-8", errors="replace")):
                inv.add_image(m.group(2), f"code:{rel}:{m.group(1)}")
        elif path.name == "Dockerfile" or (path.name.startswith("Dockerfile.") and path.suffix != ".dockerignore"):
            dockerfiles_seen.add(rel)
        elif path.name == "uv.lock":
            inv.package_sets.append(PackageSet("python", path, _rel(root, path.parent) or "root"))
        elif path.name == "package-lock.json":
            inv.package_sets.append(PackageSet("node", path, _rel(root, path.parent) or "root"))
    # 沒有被任何 compose 引用的 Dockerfile 也要列入（例如只在叢集用的映像）
    for rel in sorted(dockerfiles_seen - set(inv.builds)):
        dockerfile = (root / rel).resolve()
        context = _guess_context(root, dockerfile)
        _add_build(inv, context, dockerfile, f"dockerfile:{rel}")
    return inv


def _guess_context(root: Path, dockerfile: Path) -> Path:
    """Dockerfile 開頭註解若寫了 `Build context 是 platform/` 之類就用 root，否則用所在目錄。"""
    head = "\n".join(dockerfile.read_text(encoding="utf-8", errors="replace").splitlines()[:5])
    if re.search(r"[Bb]uild context.*platform/", head):
        return root.resolve()
    return dockerfile.parent


def python_packages(lock: Path) -> list[tuple[str, str]]:
    data = tomllib.loads(lock.read_text(encoding="utf-8"))
    return sorted((p["name"], p.get("version", "")) for p in data.get("package", []))


def node_packages(lock: Path) -> list[tuple[str, str, str]]:
    """（名稱, 版本, 授權）。lockfile v2／v3 的 packages 區段帶 license 欄位。"""
    data = json.loads(lock.read_text(encoding="utf-8"))
    rows = set()
    for key, pkg in (data.get("packages") or {}).items():
        if not key or pkg.get("link"):
            continue
        name = pkg.get("name") or key.split("node_modules/")[-1]
        licence = pkg.get("license")
        if isinstance(licence, dict):
            licence = licence.get("type")
        rows.add((name, pkg.get("version", ""), licence or ""))
    return sorted(rows)
