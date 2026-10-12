"""切面排序、體積座標、NIfTI 往返。"""
import gzip

import nibabel as nib
import numpy as np
import pytest
from conftest import make_series

from autolabel_adapter.volume import LPS_TO_RAS, LabelError, VolumeError, build_volume, labels_from_nifti


@pytest.mark.parametrize("normal_sign", [1.0, -1.0])
@pytest.mark.parametrize("tilt", [False, True])
def test_slices_are_sorted_along_the_normal(normal_sign, tilt):
    datasets = make_series(normal_sign=normal_sign, tilt=tilt)
    volume = build_volume(datasets)
    row_dir = np.array(datasets[0].ImageOrientationPatient[:3], dtype=float)
    col_dir = np.array(datasets[0].ImageOrientationPatient[3:], dtype=float)
    normal = np.cross(row_dir, col_dir)
    by_uid = {ds.SOPInstanceUID: ds for ds in datasets}
    depth = [float(np.array(by_uid[u].ImagePositionPatient, dtype=float) @ normal) for u in volume.sop_uids]
    assert depth == sorted(depth)
    # 法向量反向（切面由頭往腳排）時，像素值仍與位置一致
    values = [int(volume.voxels[k, 1, 1]) for k in range(volume.shape[0])]
    assert values == (list(range(100, 110)) if normal_sign > 0 else list(range(109, 99, -1)))


@pytest.mark.parametrize("signed", [True, False])
def test_rescale_gives_hu_and_rows_cols_are_not_swapped(signed):
    volume = build_volume(make_series(signed=signed))
    assert volume.shape == (10, 6, 5)
    assert volume.voxels[:, 0, 0].tolist() == [-1000] * 10
    assert volume.voxels.dtype.kind == "i"


def test_affine_maps_indices_to_patient_positions():
    datasets = make_series(tilt=True)
    volume = build_volume(datasets)
    by_uid = {ds.SOPInstanceUID: ds for ds in datasets}
    for k, u in enumerate(volume.sop_uids):
        ipp = np.array(by_uid[u].ImagePositionPatient, dtype=float)
        assert np.allclose(volume.affine_lps @ [0, 0, k, 1], [*ipp, 1])
    # 行索引 +1 沿 row 方向前進 PixelSpacing[1]，列索引 +1 沿 column 方向前進 PixelSpacing[0]
    assert np.allclose(np.linalg.norm(volume.affine_lps[:3, 0]), 0.7)
    assert np.allclose(np.linalg.norm(volume.affine_lps[:3, 1]), 0.8)


def test_nifti_round_trip_keeps_voxels_and_ras_affine():
    volume = build_volume(make_series())
    image = nib.Nifti1Image.from_bytes(volume.to_nifti())
    assert image.shape == (5, 6, 10)                      # (行, 列, 切面)
    assert np.allclose(image.affine, LPS_TO_RAS @ volume.affine_lps)
    assert np.array_equal(np.asanyarray(image.dataobj).transpose(2, 1, 0), volume.voxels)
    assert image.get_data_dtype() == np.int16


def _label_nifti(volume, labels, *, gz=False, affine=None):
    data = labels.transpose(2, 1, 0).astype(np.uint8)
    blob = nib.Nifti1Image(data, LPS_TO_RAS @ volume.affine_lps if affine is None else affine).to_bytes()
    return gzip.compress(blob) if gz else blob


@pytest.mark.parametrize("gz", [False, True])
def test_labels_come_back_in_slice_row_col_order(gz):
    volume = build_volume(make_series())
    labels = np.zeros(volume.shape, dtype=np.uint8)
    labels[3, 2, 4] = 1
    out = labels_from_nifti(_label_nifti(volume, labels, gz=gz), volume)
    assert out.shape == volume.shape and np.array_equal(out, labels)


def test_labels_with_other_geometry_are_rejected():
    volume = build_volume(make_series())
    with pytest.raises(LabelError, match="大小"):
        labels_from_nifti(_label_nifti(volume, np.zeros((9, 6, 5))), volume)
    with pytest.raises(LabelError, match="座標"):
        labels_from_nifti(_label_nifti(volume, np.zeros(volume.shape), affine=np.eye(4)), volume)
    with pytest.raises(LabelError):
        labels_from_nifti(b"not a nifti", volume)


def test_scout_images_with_other_orientation_are_left_out():
    datasets = make_series()
    scout = make_series(n=1, tilt=True, series="1.2.3.99")[0]   # UID 不同；方向不同
    volume = build_volume(datasets + [scout])
    assert scout.SOPInstanceUID not in volume.sop_uids and volume.shape[0] == 10


def test_missing_slice_or_duplicate_position_is_rejected():
    datasets = sorted(make_series(), key=lambda ds: ds.ImagePositionPatient[2])
    with pytest.raises(VolumeError, match="間距不均"):
        build_volume(datasets[:4] + datasets[5:])
    datasets[1].ImagePositionPatient = datasets[0].ImagePositionPatient
    with pytest.raises(VolumeError, match="重複"):
        build_volume(datasets)
    del datasets[2].ImagePositionPatient
    with pytest.raises(VolumeError, match="ImagePositionPatient"):
        build_volume(datasets)
