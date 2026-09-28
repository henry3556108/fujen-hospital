from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from fixtures.generate import CSV_PATH, load_schema  # noqa: E402


@pytest.fixture
def schema_dict() -> dict:
    return load_schema()


@pytest.fixture
def patients_csv() -> Path:
    return CSV_PATH


@pytest.fixture
def patients_df(patients_csv, schema_dict):
    from tabular.schema import Schema
    from tabular.validate import load_clean_csv

    return load_clean_csv(patients_csv, Schema.from_dict(schema_dict))
