"""Job 資料包、匯出原始碼、使用者原始碼的檢查。

資料包（tar）：config.json、dataset/manifest.json、dataset/blobs/<sha256>、選用的 source/。
匯出原始碼（zip）：train.py（該訓練種類的範本）、共用模組、config.json、requirements.txt、README.md；
結構式訓練另外附上 tabular/ 函式庫原始碼，解壓後不需安裝平台任何套件就能執行。
"""
from __future__ import annotations

import io
import json
import os
import tarfile
import zipfile
from importlib import util as import_util
from pathlib import Path, PurePosixPath
from typing import Any

from app.storage import ObjectStore
from app.training.config import IMAGE_KINDS, KIND_NAMES
from app.training.snapshot import blob_key

MAX_SOURCE_BYTES = 5 * 1024 * 1024
MAX_SOURCE_FILES = 200
SOURCE_SUFFIXES = {".py", ".json", ".txt", ".md", ".cfg", ".toml", ".yaml", ".yml"}
HELPERS = {True: ("runtime.py", "imagekit.py"), False: ("runtime.py", "tabularkit.py")}
# 影像：平台在 GPU 上以 NVIDIA NGC TensorFlow 25.02（TF 2.17、CUDA 12.8）＋ Keras 3.15.1 訓練，CPU 推論服務是 TF 2.21；
# 這個範圍內都能執行。Blackwell 等新 GPU 官方 TensorFlow 不支援，改用 NGC 容器或 KERAS_BACKEND=torch（README）。
REQUIREMENTS = {
    True: ["numpy", "scipy", "pydicom", "nibabel", "SimpleITK", "pillow", "h5py", "keras==3.15.1",
           "tensorflow>=2.17,<2.22"],
    False: ["numpy", "pandas", "scikit-learn", "statsmodels", "lifelines"],
}


class SourceError(Exception):
    status_code = 422


def templates_dir() -> Path:
    configured = os.environ.get("TRAINING_TEMPLATES_DIR")
    path = Path(configured) if configured else Path(__file__).resolve().parents[3] / "training" / "trainer" / "templates"
    if not (path / "runtime.py").is_file():
        raise RuntimeError(f"找不到訓練範本目錄：{path}（請設定 TRAINING_TEMPLATES_DIR）")
    return path


def _json(data: Any) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _readme(kind: str, config: dict[str, Any]) -> str:
    model = "model.h5" if kind in IMAGE_KINDS else "model.pkl"
    return f"""# {KIND_NAMES[kind]}訓練原始碼

由平台匯出。內容與平台上執行的範本完全相同。

| 檔案 | 說明 |
|---|---|
| `train.py` | 訓練程式（可修改） |
| `config.json` | 這次訓練的設定：切分、亂數種子（{config['seed']}）、超參數等（可修改） |
| `runtime.py` 等 | 共用模組：讀資料、切分、寫出結果 |
| `requirements.txt` | 需要的 Python 套件 |

## 在平台上執行修改後的版本

把整個資料夾重新壓成 zip，上傳到原訓練的「以修改後的原始碼執行」。平台會用同一份凍結的資料執行。
程式在獨立的容器內執行，容器內沒有任何平台帳密；只能讀 `dataset/`、寫 `out/`。

## 在自己的電腦執行

```bash
pip install -r requirements.txt
python train.py --config config.json --data <資料夾> --out out
```

`<資料夾>` 的格式：`manifest.json` 加上 `blobs/<sha256>`。產出：`out/{model}`、`out/metrics.json`、
`out/splits.json`、`out/model_card.json`。

同一份資料、設定、亂數種子在同一台機器（同一張 GPU 或 CPU）上會得到相同的模型與指標。
{_GPU_NOTE if kind in IMAGE_KINDS else ""}"""


_GPU_NOTE = """
## GPU

有 GPU 就會自動使用。平台的 GPU 是 NVIDIA RTX PRO 6000 Blackwell，官方 TensorFlow 不支援這一代 GPU，
平台用 NVIDIA 的 TensorFlow 容器 `nvcr.io/nvidia/tensorflow:25.02-tf2-py3`（TF 2.17、CUDA 12.8）。
分類與偵測也可以改用 PyTorch 執行同一份程式，輸出一樣是 `model.h5`（分割目前不行：Keras 3.15.1 的 PyTorch 後端
訓練這個模型會出錯）：

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu128
KERAS_BACKEND=torch python train.py --config config.json --data <資料夾> --out out
```

模型卡 `model_card.json` 的 `keras_backend`、`device`、`libraries` 記錄平台訓練時實際的後端、GPU 與套件版本。
"""


def export_source(kind: str, config: dict[str, Any]) -> bytes:
    root = templates_dir()
    is_image = kind in IMAGE_KINDS
    files: dict[str, bytes] = {"train.py": (root / f"{kind}.py").read_bytes()}
    for name in HELPERS[is_image]:
        files[name] = (root / name).read_bytes()
    files["config.json"] = _json(config)
    files["requirements.txt"] = ("\n".join(REQUIREMENTS[is_image]) + "\n").encode()
    files["README.md"] = _readme(kind, config).encode("utf-8")
    if not is_image:
        package = Path(import_util.find_spec("tabular").origin).parent
        for path in sorted(package.glob("*.py")):
            files[f"tabular/{path.name}"] = path.read_bytes()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))   # 固定時間：同內容產出相同的 zip
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, files[name])
    return buffer.getvalue()


def read_source(data: bytes) -> dict[str, bytes]:
    """檢查使用者上傳的原始碼 zip，回傳（路徑 → 內容）。"""
    files = read_zip(data, "train.py")
    if "train.py" not in files:
        raise SourceError("原始碼內找不到 train.py")
    try:
        compile(files["train.py"], "train.py", "exec")
    except SyntaxError as exc:
        raise SourceError(f"train.py 有語法錯誤（第 {exc.lineno} 行）：{exc.msg}") from None
    return files


def write_zip(files: dict[str, bytes]) -> bytes:
    """固定檔案時間與順序：同內容產出相同的 zip。"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, files[name])
    return buffer.getvalue()


def read_zip(data: bytes, marker: str, *, max_bytes: int = MAX_SOURCE_BYTES) -> dict[str, bytes]:
    """檢查使用者上傳的 zip（大小、檔案數、副檔名白名單、不得有絕對路徑或 ..），回傳（路徑 → 內容）。
    整包放在單一資料夾內（找不到 marker 時）去掉那一層。"""
    if len(data) > max_bytes:
        raise SourceError(f"壓縮檔超過上限 {max_bytes // 1024 // 1024} MB")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise SourceError("上傳的檔案不是 zip 壓縮檔") from None
    entries = [e for e in archive.infolist() if not e.is_dir()]
    if len(entries) > MAX_SOURCE_FILES:
        raise SourceError(f"原始碼檔案數超過上限 {MAX_SOURCE_FILES}")
    if sum(e.file_size for e in entries) > max_bytes * 4:
        raise SourceError("原始碼解壓後過大")
    files: dict[str, bytes] = {}
    for entry in entries:
        path = PurePosixPath(entry.filename.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise SourceError(f"原始碼內有不合法的路徑：{entry.filename}")
        if path.suffix.lower() not in SOURCE_SUFFIXES:
            raise SourceError(f"原始碼內有不允許的檔案類型：{entry.filename}")
        files[path.as_posix()] = archive.read(entry)
    # 整包放在單一資料夾內時，去掉那一層
    tops = {name.split("/", 1)[0] for name in files}
    if marker not in files and len(tops) == 1 and all("/" in name for name in files):
        files = {name.split("/", 1)[1]: body for name, body in files.items()}
    return files


def source_config(files: dict[str, bytes]) -> dict[str, Any] | None:
    if "config.json" not in files:
        return None
    try:
        data = json.loads(files["config.json"])
    except ValueError:
        raise SourceError("原始碼內的 config.json 不是合法的 JSON") from None
    if not isinstance(data, dict):
        raise SourceError("原始碼內的 config.json 必須是物件")
    return data


def _add(archive: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size, info.mode, info.mtime = len(data), 0o644, 0
    archive.addfile(info, io.BytesIO(data))


def build_bundle(store: ObjectStore, *, project_id: int, config: dict[str, Any], manifest: dict[str, Any],
                 source: bytes | None) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        _add(archive, "config.json", _json(config))
        _add(archive, "dataset/manifest.json", _json(manifest))
        digests = sorted({ref["blob"] for item in manifest["items"] for ref in item["files"].values()})
        for digest in digests:
            _add(archive, f"dataset/blobs/{digest}", store.get(blob_key(project_id, digest)))
        if source is not None:
            for name, body in sorted(read_source(source).items()):
                if name != "config.json":
                    _add(archive, f"source/{name}", body)
    return buffer.getvalue()
