"""影像訓練範本共用：讀影像與標註、Resize、6 項資料增強、固定 Keras 的亂數與執行緒。

這個檔案會跟著「匯出原始碼」一起帶走。支援的檔案格式：
  影像  dicom、nifti、itk（.mha）、png、npy
  遮罩  nifti、itk、png、npy（整數類別，0 是背景）
"""
from __future__ import annotations

import gzip
import io
import os
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from scipy import ndimage

import runtime

AUGMENTATION_KEYS = ("rotation_range", "width_shift_range", "height_shift_range", "shear_range", "zoom_range",
                     "horizontal_flip", "vertical_flip")
LIBRARIES = ["tensorflow-cpu", "tensorflow", "torch", "keras", "numpy", "h5py"]
BACKENDS = ("tensorflow", "torch")


# --------------------------------------------------------------------------- 讀檔

def read_slices(data: bytes, fmt: str) -> list[np.ndarray]:
    """回傳一或多張 2D 陣列（立體影像沿切片方向展開）。"""
    fmt = fmt.lower()
    if fmt == "dicom":
        import pydicom

        ds = pydicom.dcmread(io.BytesIO(data))
        pixels = ds.pixel_array.astype("float32")
        pixels = pixels * float(getattr(ds, "RescaleSlope", 1) or 1) + float(getattr(ds, "RescaleIntercept", 0) or 0)
        return [pixels] if pixels.ndim == 2 else list(pixels)
    if fmt == "nifti":
        import nibabel as nib

        if data[:2] == b"\x1f\x8b":
            data = gzip.decompress(data)
        volume = np.asarray(nib.Nifti1Image.from_bytes(data).dataobj)
        return [volume] if volume.ndim == 2 else [volume[..., i] for i in range(volume.shape[-1])]
    if fmt == "itk":
        import SimpleITK as sitk

        with tempfile.NamedTemporaryFile(suffix=".mha") as tmp:
            tmp.write(data)
            tmp.flush()
            volume = sitk.GetArrayFromImage(sitk.ReadImage(tmp.name))
        return [volume] if volume.ndim == 2 else list(volume)
    if fmt == "png":
        from PIL import Image

        return [np.asarray(Image.open(io.BytesIO(data)).convert("F"))]
    if fmt == "npy":
        array = np.load(io.BytesIO(data), allow_pickle=False)
        return [array] if array.ndim == 2 else list(array)
    raise ValueError(f"不支援的影像格式：{fmt}")


def read_ref(data_dir: Path, ref: dict[str, Any]) -> list[np.ndarray]:
    return read_slices(runtime.blob_path(data_dir, ref).read_bytes(), ref["format"])


# --------------------------------------------------------------------------- Resize 與正規化

def resize(image: np.ndarray, size: tuple[int, int], *, order: int = 1) -> np.ndarray:
    """縮放到 (高, 寬)。影像用雙線性（order=1），遮罩用最近鄰（order=0）以保留類別值。"""
    height, width = int(size[0]), int(size[1])
    if image.shape == (height, width):
        return image
    zoom = (height / image.shape[0], width / image.shape[1])
    out = ndimage.zoom(image, zoom, order=order, mode="nearest", grid_mode=True)
    if out.shape != (height, width):  # 四捨五入造成的 1 像素誤差
        fixed = np.zeros((height, width), dtype=out.dtype)
        h, w = min(height, out.shape[0]), min(width, out.shape[1])
        fixed[:h, :w] = out[:h, :w]
        out = fixed
    return out


def normalise(image: np.ndarray) -> np.ndarray:
    image = image.astype("float32")
    low, high = float(image.min()), float(image.max())
    return (image - low) / (high - low) if high > low else np.zeros_like(image)


def prepare_image(image: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    return normalise(resize(np.asarray(image, dtype="float32"), size))


def scale_boxes(boxes: list[dict], original: tuple[int, int], size: tuple[int, int]) -> list[dict]:
    """方框 [x, y, 寬, 高]（像素）換算到 Resize 後的座標。"""
    fy, fx = size[0] / original[0], size[1] / original[1]
    return [{**b, "bbox": [b["bbox"][0] * fx, b["bbox"][1] * fy, b["bbox"][2] * fx, b["bbox"][3] * fy]}
            for b in boxes]


# --------------------------------------------------------------------------- 資料增強

def normalise_augmentation(config: dict | None) -> dict[str, Any]:
    config = config or {}
    return {
        "rotation_range": float(config.get("rotation_range", 0)),
        "width_shift_range": float(config.get("width_shift_range", 0)),
        "height_shift_range": float(config.get("height_shift_range", 0)),
        "shear_range": float(config.get("shear_range", 0)),
        "zoom_range": float(config.get("zoom_range", 0)),
        "horizontal_flip": bool(config.get("horizontal_flip", False)),
        "vertical_flip": bool(config.get("vertical_flip", False)),
    }


def augmentation_enabled(config: dict[str, Any]) -> bool:
    return any(bool(config[k]) for k in AUGMENTATION_KEYS)


def _translate(dy: float, dx: float) -> np.ndarray:
    return np.array([[1, 0, dy], [0, 1, dx], [0, 0, 1]], dtype="float64")


def draw(config: dict[str, Any], rng: np.random.RandomState) -> dict[str, Any]:
    """依設定的範圍抽一組增強參數。抽取順序固定，所以同一個種子得到同一組參數。"""
    return {
        "rotation": rng.uniform(-config["rotation_range"], config["rotation_range"]),
        "shift_x": rng.uniform(-config["width_shift_range"], config["width_shift_range"]),
        "shift_y": rng.uniform(-config["height_shift_range"], config["height_shift_range"]),
        "shear": rng.uniform(-config["shear_range"], config["shear_range"]),
        "zoom": rng.uniform(1 - config["zoom_range"], 1 + config["zoom_range"]),
        "flip_h": bool(config["horizontal_flip"] and rng.rand() < 0.5),
        "flip_v": bool(config["vertical_flip"] and rng.rand() < 0.5),
    }


def forward_matrix(shape: tuple[int, int], p: dict[str, Any]) -> np.ndarray:
    """輸入座標（列, 行）→ 輸出座標的仿射矩陣：以影像中心旋轉、Shear、Zoom、翻轉，再位移。"""
    h, w = shape
    theta, shear = np.deg2rad(p["rotation"]), np.deg2rad(p["shear"])
    rotate = np.array([[np.cos(theta), -np.sin(theta), 0], [np.sin(theta), np.cos(theta), 0], [0, 0, 1]])
    shear_m = np.array([[1, 0, 0], [np.tan(shear), 1, 0], [0, 0, 1]])
    zoom = np.diag([p["zoom"], p["zoom"], 1.0])
    flip = np.diag([-1.0 if p["flip_v"] else 1.0, -1.0 if p["flip_h"] else 1.0, 1.0])
    centre = _translate(-(h - 1) / 2, -(w - 1) / 2)
    back = _translate((h - 1) / 2 + p["shift_y"] * h, (w - 1) / 2 + p["shift_x"] * w)
    return back @ flip @ zoom @ shear_m @ rotate @ centre


def warp(image: np.ndarray, matrix: np.ndarray, *, order: int, mode: str = "nearest") -> np.ndarray:
    inverse = np.linalg.inv(matrix)
    return ndimage.affine_transform(image, inverse[:2, :2], offset=inverse[:2, 2], order=order, mode=mode,
                                    cval=0, output=image.dtype)


def warp_boxes(boxes: list[dict], matrix: np.ndarray, shape: tuple[int, int]) -> list[dict]:
    """方框四個角各自變換後取外接矩形，再裁到影像範圍內；面積不到 1 像素的丟掉。"""
    h, w = shape
    out = []
    for box in boxes:
        x, y, bw, bh = box["bbox"]
        corners = np.array([[y, x, 1], [y, x + bw, 1], [y + bh, x, 1], [y + bh, x + bw, 1]], dtype="float64").T
        rows, cols, _ = matrix @ corners
        x0, x1 = float(np.clip(cols.min(), 0, w)), float(np.clip(cols.max(), 0, w))
        y0, y1 = float(np.clip(rows.min(), 0, h)), float(np.clip(rows.max(), 0, h))
        if (x1 - x0) * (y1 - y0) >= 1:
            out.append({**box, "bbox": [x0, y0, x1 - x0, y1 - y0]})
    return out


def augment(image: np.ndarray, params: dict[str, Any], *, mask: np.ndarray | None = None,
            boxes: list[dict] | None = None):
    """影像、遮罩、方框用同一個變換。"""
    matrix = forward_matrix(image.shape, params)
    new_image = warp(image, matrix, order=1)
    new_mask = warp(mask, matrix, order=0, mode="constant") if mask is not None else None
    new_boxes = warp_boxes(boxes, matrix, image.shape) if boxes is not None else None
    return new_image, new_mask, new_boxes


def augment_training_set(samples: list[dict], config: dict[str, Any], seed: int, copies: int = 1) -> list[dict]:
    """在原始訓練樣本之外，每筆再產生 copies 筆增強樣本。驗證與測試資料不增強。"""
    if not augmentation_enabled(config) or copies < 1:
        return list(samples)
    rng = np.random.RandomState(seed)
    out = list(samples)
    for round_no in range(copies):
        for sample in samples:
            params = draw(config, rng)
            image, mask, boxes = augment(sample["image"], params, mask=sample.get("mask"), boxes=sample.get("boxes"))
            out.append({**sample, "id": f"{sample['id']}@aug{round_no + 1}", "image": image, "mask": mask,
                        "boxes": boxes, "augmentation": params})
    return out


# --------------------------------------------------------------------------- 樣本

def load_samples(data_dir: Path, manifest: dict, size: tuple[int, int], *, want_mask: bool = False,
                 want_boxes: bool = False) -> list[dict]:
    """把 manifest 的項目展開成樣本（立體影像每張切片一筆），並完成 Resize 與正規化。"""
    samples = []
    for item in manifest["items"]:
        images = read_ref(data_dir, item["files"]["image"])
        masks = read_ref(data_dir, item["files"]["mask"]) if want_mask and "mask" in item["files"] else None
        if want_mask and (masks is None or len(masks) != len(images)):
            raise ValueError(f"項目「{item['id']}」缺少遮罩，或遮罩與影像的切片數不同")
        for index, image in enumerate(images):
            sample = {"id": item["id"] if len(images) == 1 else f"{item['id']}#{index}", "item": item["id"],
                      "group": item.get("group") or item["id"], "label": item.get("label"),
                      "image": prepare_image(image, size)}
            if masks is not None:
                sample["mask"] = resize(np.asarray(masks[index]).astype("int32"), size, order=0)
            if want_boxes:
                sample["boxes"] = scale_boxes(item.get("boxes") or [], image.shape, size)
            samples.append(sample)
    return samples


def split_samples(samples: list[dict], config: dict) -> tuple[dict[str, list[dict]], dict[str, Any]]:
    groups = runtime.split_groups([s["group"] for s in samples], config["split"], int(config["seed"]))
    where = {g: name for name, members in groups.items() for g in members}
    parts: dict[str, list[dict]] = {name: [] for name in runtime.SPLITS}
    for sample in samples:
        parts[where[sample["group"]]].append(sample)
    splits = {"unit": "sample", "groups": groups,
              **{name: [s["id"] for s in part] for name, part in parts.items()}}
    return parts, splits


def stack(samples: list[dict]) -> np.ndarray:
    return np.stack([s["image"] for s in samples]).astype("float32")[..., None]


# --------------------------------------------------------------------------- Keras

def keras_backend() -> str:
    """Keras 後端由環境變數 KERAS_BACKEND 決定：tensorflow（預設）或 torch（備案）。兩者輸出一樣是 H5。"""
    backend = os.environ.get("KERAS_BACKEND") or "tensorflow"
    if backend not in BACKENDS:
        raise ValueError(f"KERAS_BACKEND 必須是：{'、'.join(BACKENDS)}")
    os.environ["KERAS_BACKEND"] = backend       # 必須在 import keras 之前設定
    return backend


def keras_setup(seed: int):
    """固定亂數、執行緒數、啟用決定性運算：同資料、設定、種子在同一台機器（同一張 GPU 或 CPU）上
    得到逐位元相同的權重。看得到 GPU 就用 GPU（CPU 映像以 CUDA_VISIBLE_DEVICES="" 關掉）。"""
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    backend = keras_backend()
    threads = int(os.environ.get("TRAIN_THREADS", "1"))
    if backend == "tensorflow":
        import tensorflow as tf

        try:
            tf.config.threading.set_intra_op_parallelism_threads(threads)
            tf.config.threading.set_inter_op_parallelism_threads(threads)
        except RuntimeError:
            pass  # 同一個程序第二次呼叫（推論服務載入第二個模型）：TensorFlow 已初始化，沿用第一次的設定
    else:
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")    # cuBLAS 決定性運算的必要設定
        import torch

        torch.set_num_threads(threads)
        torch.use_deterministic_algorithms(True)
        torch.backends.cudnn.benchmark = False
    import keras

    keras.utils.set_random_seed(seed)
    if backend == "tensorflow":
        tf.config.experimental.enable_op_determinism()
    return keras


def device_info() -> dict[str, Any]:
    """記在模型卡：實際使用的 Keras 後端與運算裝置（GPU 型號或 CPU）。在 keras_setup 之後呼叫。"""
    backend = keras_backend()
    device = "CPU"
    if backend == "tensorflow":
        import tensorflow as tf

        gpus = tf.config.list_physical_devices("GPU")
        if gpus:
            device = tf.config.experimental.get_device_details(gpus[0]).get("device_name") or "GPU"
    else:
        import torch

        if torch.cuda.is_available():
            device = torch.cuda.get_device_name(0)
    return {"keras_backend": backend, "device": device}


def hyper(config: dict, **defaults) -> dict[str, Any]:
    return {**defaults, **(config.get("hyperparameters") or {})}


def save_h5(model, out_dir: Path) -> None:
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # Keras 3 會提醒 H5 是舊格式；契約指定交付 H5
        model.save(Path(out_dir) / "model.h5")


def image_config(config: dict) -> tuple[tuple[int, int], dict[str, Any]]:
    image = config.get("image") or {}
    size = tuple(int(v) for v in image.get("resize", (32, 32)))
    return size, normalise_augmentation(config.get("augmentation"))
