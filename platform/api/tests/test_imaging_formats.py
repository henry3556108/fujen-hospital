import json

import pytest

from app.imaging.formats import InvalidFile, parse_file
from imaging_support import make_makesense, make_mha, make_nifti


@pytest.mark.parametrize("name,data,fmt,role,case", [
    ("case_001_image.nii.gz", make_nifti(), "nifti", "image", "case_001"),
    ("nifti/case_002_label.nii.gz", make_nifti(), "nifti", "label", "case_002"),
    ("case_003_image.nii", make_nifti(gz=False), "nifti", "image", "case_003"),
    ("itk/case_001_label.mha", make_mha(), "itk", "label", "case_001"),
    ("imagesTr/lung_004.nii.gz", make_nifti(), "nifti", "image", "lung_004"),
    ("labelsTr/lung_004.nii.gz", make_nifti(), "nifti", "label", "lung_004"),
    ("makesense_001.json", make_makesense(1), "makesense", "label", None),
])
def test_tc_b01_03_formats_parse(name, data, fmt, role, case):
    parsed = parse_file(name, data)
    assert (parsed.format, parsed.role, parsed.case) == (fmt, role, case)


def test_nifti_dims_recorded():
    assert parse_file("a_image.nii.gz", make_nifti((4, 4, 2))).meta["dims"] == [4, 4, 2]


def test_makesense_image_refs():
    parsed = parse_file("m.json", make_makesense(2))
    assert parsed.meta["file_names"] == [f"study_0002/series_001/IM000{s}.dcm" for s in (1, 2, 3)]
    assert parsed.meta["annotations"] == 3


@pytest.mark.parametrize("name,data,reason", [
    ("notes.txt", b"hello", "不支援的副檔名"),
    ("case_001_image.nii.gz", b"not gzip at all", "NIfTI"),
    ("case_001_image.nii.gz", make_nifti()[:40], "NIfTI"),
    ("case_001_image.nii", make_nifti(gz=False)[:360], "NIfTI"),
    ("case_001_image.mha", b"ObjectType = Image\nNDims = 3\n", "MetaImage"),
    ("case_001_image.mha", make_mha()[:-10], "MetaImage"),
    ("case_001_image.mhd", b"ObjectType = Image\n", "不支援的副檔名"),
    ("m.json", b"{not json", "JSON"),
    ("m.json", json.dumps({"images": []}).encode(), "makesense"),
    ("m.json", json.dumps({"images": [{"id": 1}], "annotations": [], "categories": []}).encode(), "makesense"),
    ("m.json", json.dumps({"images": [{"id": [1], "file_name": "a"}], "annotations": [],
                           "categories": []}).encode(), "makesense"),
    ("m.json", json.dumps({"images": [{"id": 1, "file_name": "a"}], "annotations": ["x"],
                           "categories": []}).encode(), "makesense"),
])
def test_tc_b01_05_bad_files_rejected_with_reason(name, data, reason):
    with pytest.raises(InvalidFile, match=reason):
        parse_file(name, data)


# ---- 大小上限與壓縮炸彈 ----

def _bomb(declared_dims=(4, 4, 2), payload_mb=64) -> bytes:
    """標頭宣告很小、解壓後卻很大的 .nii.gz（壓縮後只有數十 KB）。"""
    import gzip

    return gzip.compress(make_nifti(declared_dims, gz=False) + bytes(payload_mb * 1024 * 1024), mtime=0)


def test_nifti_large_stream_is_not_held_in_memory():
    """串流解壓：只留標頭，其餘只計長度，不會把解壓後的內容整個放進記憶體。"""
    import tracemalloc

    data = _bomb(payload_mb=64)
    assert len(data) < 200 * 1024
    tracemalloc.start()
    parsed = parse_file("bomb_image.nii.gz", data)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert parsed.meta["dims"] == [4, 4, 2]
    assert peak < 8 * 1024 * 1024, f"解壓用了 {peak / 1024 / 1024:.1f} MB"


def test_nifti_declared_size_over_limit_rejected():
    big = make_nifti((64, 64, 64))                      # 解壓後約 0.5 MB
    with pytest.raises(InvalidFile, match="解壓縮後.*超過上限"):
        parse_file("big_image.nii.gz", big, max_decompressed=100 * 1024)
    assert parse_file("big_image.nii.gz", big, max_decompressed=1024 * 1024).meta["dims"] == [64, 64, 64]


def test_nifti_uncompressed_declared_size_over_limit_rejected():
    with pytest.raises(InvalidFile, match="超過上限"):
        parse_file("big_image.nii", make_nifti((64, 64, 64), gz=False), max_decompressed=100 * 1024)


def test_nifti_truncated_gzip_still_reported():
    data = make_nifti((16, 16, 16))
    with pytest.raises(InvalidFile, match="解壓縮失敗|不完整"):
        parse_file("cut_image.nii.gz", data[: len(data) // 2])


def test_nifti_multi_member_gzip_accepted():
    import gzip

    raw = make_nifti((4, 4, 2), gz=False)
    data = gzip.compress(raw[:200], mtime=0) + gzip.compress(raw[200:], mtime=0)
    assert parse_file("multi_image.nii.gz", data).meta["dims"] == [4, 4, 2]


def test_nifti_header_bomb_before_header_complete():
    """連標頭都湊不滿卻一直吐空資料的串流不存在於 gzip；但垃圾尾端要被當成錯誤而不是無限讀取。"""
    import gzip

    with pytest.raises(InvalidFile):
        parse_file("x_image.nii.gz", gzip.compress(b"\x00" * 100, mtime=0))


def test_nifti_bomb_over_limit_rejected_without_holding_it_in_memory():
    """標頭宣告很小、實際解壓後超過上限：在串流途中就拒絕。"""
    import tracemalloc

    data = _bomb(payload_mb=64)
    tracemalloc.start()
    with pytest.raises(InvalidFile, match="壓縮炸彈"):
        parse_file("bomb_image.nii.gz", data, max_decompressed=1024 * 1024)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert peak < 8 * 1024 * 1024
