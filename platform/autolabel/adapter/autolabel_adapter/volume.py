"""DICOM 切面 → 3D 體積（NIfTI），以及 MONAI Label 回傳的標籤體積 → 每張切面的遮罩。

座標約定：
- 體積陣列 voxels[k, r, c]：k 是沿切面法向量排序後的切面索引，r、c 是 DICOM 的列（Rows）、行（Columns）。
- DICOM 病人座標是 LPS；NIfTI 是 RAS，所以 affine 的前兩列取負號。
- NIfTI 資料的軸順序是 (i, j, k) = (行, 列, 切面)，也就是 voxels 轉置成 [c, r, k]。
  MONAI Label 推論後以同一個 affine 與大小把標籤存回原影像空間（Restored），這裡再轉置回 [k, r, c]。
"""
from __future__ import annotations

import gzip
from dataclasses import dataclass

import nibabel as nib
import numpy as np
from pydicom.dataset import Dataset

LPS_TO_RAS = np.diag([-1.0, -1.0, 1.0, 1.0])


class VolumeError(ValueError):
    """序列無法組成 3D 體積（缺欄位、切面大小或方向不一致、間距不均）。訊息為繁體中文。"""


class LabelError(ValueError):
    """MONAI Label 回傳的標籤體積與影像不符（大小、座標、標籤值）。"""


@dataclass(frozen=True)
class Volume:
    voxels: np.ndarray            # [切面, 列, 行]，HU（已套用 Rescale Slope／Intercept）
    affine_lps: np.ndarray        # 4×4，(行, 列, 切面) 索引 → LPS 毫米
    sop_uids: tuple[str, ...]     # 依切面索引排列

    @property
    def shape(self) -> tuple[int, int, int]:
        return tuple(self.voxels.shape)

    def index_of(self, sop_uid: str) -> int:
        try:
            return self.sop_uids.index(sop_uid)
        except ValueError:
            raise KeyError(sop_uid) from None

    def to_nifti(self) -> bytes:
        """未壓縮的 NIfTI-1（.nii）。整數 HU 存 int16，否則 float32。"""
        data = self.voxels.transpose(2, 1, 0)
        if np.issubdtype(data.dtype, np.integer) and data.min() >= -32768 and data.max() <= 32767:
            data = data.astype(np.int16)
        else:
            data = data.astype(np.float32)
        image = nib.Nifti1Image(np.ascontiguousarray(data), LPS_TO_RAS @ self.affine_lps)
        image.header.set_xyzt_units("mm")
        image.set_qform(image.affine, code=1)
        image.set_sform(image.affine, code=1)
        return image.to_bytes()


def _floats(ds: Dataset, keyword: str, n: int) -> np.ndarray:
    value = ds.get(keyword)
    if value is None or len(value) != n:
        raise VolumeError(f"影像缺少 {keyword}，無法組成 3D 體積")
    return np.array([float(v) for v in value], dtype=np.float64)


def build_volume(datasets: list[Dataset], *, max_gap_ratio: float = 0.2) -> Volume:
    """把同一序列的切面依 ImagePositionPatient 在法向量上的投影排序，組成體積。

    只收單張影格、與多數切面同大小同方向的影像（定位片等不同方向的影像略過）。
    相鄰切面間距與中位數差超過 max_gap_ratio 時視為不均（缺片），拒絕（推論結果的位置會錯）。
    """
    if not datasets:
        raise VolumeError("序列沒有影像")
    groups: dict[tuple, list[Dataset]] = {}
    for ds in datasets:
        if int(ds.get("NumberOfFrames", 1) or 1) != 1 or "PixelData" not in ds:
            continue
        iop = tuple(np.round(_floats(ds, "ImageOrientationPatient", 6), 4))
        groups.setdefault((int(ds.Rows), int(ds.Columns), iop), []).append(ds)
    if not groups:
        raise VolumeError("序列沒有可用的單張影像")
    (rows, cols, _), members = max(groups.items(), key=lambda kv: len(kv[1]))
    iop = _floats(members[0], "ImageOrientationPatient", 6)
    row_dir, col_dir = iop[:3], iop[3:]          # 行索引增加的方向、列索引增加的方向
    normal = np.cross(row_dir, col_dir)
    positions = {ds.SOPInstanceUID: _floats(ds, "ImagePositionPatient", 3) for ds in members}
    ordered = sorted(members, key=lambda ds: float(positions[ds.SOPInstanceUID] @ normal))
    depth = np.array([positions[ds.SOPInstanceUID] @ normal for ds in ordered])
    if len(ordered) > 1:
        gaps = np.diff(depth)
        if np.any(gaps <= 1e-4):
            raise VolumeError("序列有位置重複的切面，無法組成 3D 體積")
        median = float(np.median(gaps))
        if np.any(np.abs(gaps - median) > max_gap_ratio * median):
            raise VolumeError("序列的切面間距不均（可能缺片），無法組成 3D 體積")
    spacing = _floats(ordered[0], "PixelSpacing", 2)     # [列間距, 行間距]
    first = positions[ordered[0].SOPInstanceUID]
    if len(ordered) > 1:
        step = (positions[ordered[-1].SOPInstanceUID] - first) / (len(ordered) - 1)
    else:
        step = normal * float(ordered[0].get("SliceThickness") or 1.0)
    affine = np.eye(4)
    affine[:3, 0] = row_dir * spacing[1]
    affine[:3, 1] = col_dir * spacing[0]
    affine[:3, 2] = step
    affine[:3, 3] = first

    slices = []
    for ds in ordered:
        pixels = ds.pixel_array
        if pixels.ndim != 2:
            raise VolumeError("只支援單色（灰階）影像")
        slope = float(ds.get("RescaleSlope", 1) or 1)
        intercept = float(ds.get("RescaleIntercept", 0) or 0)
        if slope == 1 and intercept == int(intercept):
            slices.append(pixels.astype(np.int32) + int(intercept))
        else:
            slices.append(pixels.astype(np.float32) * slope + intercept)
    voxels = np.stack(slices)
    return Volume(voxels=voxels, affine_lps=affine, sop_uids=tuple(ds.SOPInstanceUID for ds in ordered))


def labels_from_nifti(blob: bytes, volume: Volume, *, atol: float = 1e-2) -> np.ndarray:
    """MONAI Label 回傳的標籤 NIfTI → [切面, 列, 行] 的 uint8 陣列；大小或位置與原體積不符就拒絕。"""
    try:
        image = nib.Nifti1Image.from_bytes(_gunzip(blob))
    except Exception as exc:                       # nibabel 對壞檔會丟各種例外
        raise LabelError(f"MONAI Label 回傳的標籤檔無法讀取：{exc}") from exc
    data = np.asanyarray(image.dataobj)
    while data.ndim > 3 and data.shape[-1] == 1:
        data = data[..., 0]
    expected = (volume.shape[2], volume.shape[1], volume.shape[0])
    if data.shape != expected:
        raise LabelError(f"標籤體積大小 {data.shape} 與影像 {expected} 不符")
    if not np.allclose(image.affine, LPS_TO_RAS @ volume.affine_lps, atol=atol):
        raise LabelError("標籤體積的座標與影像不符")
    if data.min() < 0 or data.max() > 255:
        raise LabelError("標籤值超出 0–255")
    return np.ascontiguousarray(np.rint(data).astype(np.uint8).transpose(2, 1, 0))


def _gunzip(blob: bytes) -> bytes:
    if blob[:2] == b"\x1f\x8b":
        return gzip.decompress(blob)
    return blob
