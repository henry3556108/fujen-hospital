"""STORAGE_BACKEND 選擇與 S3（MinIO）實作。整合測試需設定 S3_TEST_ENDPOINT，否則略過。"""
import os
import uuid

import pytest

from app.storage import LocalObjectStore, ObjectNotFound, S3ObjectStore, store_from_env

S3_ENV = {"S3_ENDPOINT": "minio:9000", "S3_ACCESS_KEY": "ak", "S3_SECRET_KEY": "sk", "S3_BUCKET": "platform"}


def test_local_is_default(tmp_path):
    store = store_from_env({"STORAGE_ROOT": str(tmp_path)})
    assert isinstance(store, LocalObjectStore)


def test_s3_backend_selected():
    store = store_from_env({"STORAGE_BACKEND": "s3", **S3_ENV})
    assert isinstance(store, S3ObjectStore)
    assert store.bucket == "platform"


def test_s3_missing_variable_is_named():
    env = {"STORAGE_BACKEND": "s3", **S3_ENV}
    del env["S3_SECRET_KEY"]
    with pytest.raises(RuntimeError, match="S3_SECRET_KEY"):
        store_from_env(env)


def test_unknown_backend_rejected():
    with pytest.raises(RuntimeError, match="STORAGE_BACKEND"):
        store_from_env({"STORAGE_BACKEND": "ftp"})


def test_s3_rejects_unsafe_keys_before_network():
    store = store_from_env({"STORAGE_BACKEND": "s3", **S3_ENV})
    with pytest.raises(ValueError):
        store.put("../x", b"1")


@pytest.mark.skipif(not os.environ.get("S3_TEST_ENDPOINT"), reason="需要 MinIO：設定 S3_TEST_ENDPOINT")
def test_s3_roundtrip_against_minio():
    store = store_from_env({
        "STORAGE_BACKEND": "s3",
        "S3_ENDPOINT": os.environ["S3_TEST_ENDPOINT"],
        "S3_ACCESS_KEY": os.environ.get("S3_TEST_ACCESS_KEY", "minio-dev"),
        "S3_SECRET_KEY": os.environ.get("S3_TEST_SECRET_KEY", "minio-dev-secret"),
        "S3_BUCKET": f"test-{uuid.uuid4().hex[:8]}",
    })
    store.put("p/1/a.nii.gz", b"abc")
    store.put("p/1/b", b"2")
    store.put("p/2/c", b"3")
    assert store.exists("p/1/a.nii.gz") and store.get("p/1/a.nii.gz") == b"abc"
    assert store.list("p/1/") == ["p/1/a.nii.gz", "p/1/b"]
    store.delete("p/1/a.nii.gz")
    assert not store.exists("p/1/a.nii.gz")
    with pytest.raises(ObjectNotFound):
        store.get("p/1/a.nii.gz")
