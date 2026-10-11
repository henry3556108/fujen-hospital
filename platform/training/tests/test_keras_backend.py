"""Keras 後端的選擇（不需要 TensorFlow）。"""
import pytest

import imagekit


def test_default_backend_is_tensorflow(monkeypatch):
    monkeypatch.delenv("KERAS_BACKEND", raising=False)
    assert imagekit.keras_backend() == "tensorflow"


def test_torch_backend_is_accepted(monkeypatch):
    monkeypatch.setenv("KERAS_BACKEND", "torch")
    assert imagekit.keras_backend() == "torch"


def test_unknown_backend_is_rejected(monkeypatch):
    monkeypatch.setenv("KERAS_BACKEND", "jax")
    with pytest.raises(ValueError, match="KERAS_BACKEND"):
        imagekit.keras_backend()
