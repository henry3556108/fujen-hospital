import pytest

from app.storage import LocalObjectStore, ObjectNotFound


@pytest.fixture
def store(tmp_path):
    return LocalObjectStore(tmp_path)


def test_put_get_exists_delete(store):
    store.put("projects/1/datasets/a.csv", b"x,y\n1,2\n")
    assert store.exists("projects/1/datasets/a.csv")
    assert store.get("projects/1/datasets/a.csv") == b"x,y\n1,2\n"
    store.delete("projects/1/datasets/a.csv")
    assert not store.exists("projects/1/datasets/a.csv")


def test_list_by_prefix(store):
    store.put("p/1/a", b"1")
    store.put("p/1/b", b"2")
    store.put("p/2/c", b"3")
    assert store.list("p/1/") == ["p/1/a", "p/1/b"]


def test_missing_object_raises(store):
    with pytest.raises(ObjectNotFound):
        store.get("nope")


@pytest.mark.parametrize("key", ["../escape", "/abs/path", "a/../../b", "", "a//b"])
def test_unsafe_keys_rejected(store, key):
    with pytest.raises(ValueError):
        store.put(key, b"x")


def test_app_exposes_object_store(app):
    app.state.store.put("probe/x", b"1")
    assert app.state.store.get("probe/x") == b"1"
