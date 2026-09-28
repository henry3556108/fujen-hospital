"""Domain error type. Messages are Traditional Chinese and safe to show to users."""

from __future__ import annotations

from typing import Any


class TabularError(Exception):
    """A user-facing, expected error (bad input, wrong column type, ...).

    The API layer maps it to a 4xx response via :meth:`to_dict`.
    """

    def __init__(self, message: str, code: str = "tabular_error", detail: dict[str, Any] | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.detail = detail or {}

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "detail": self.detail}
