"""Structured CSVs for TC-B01-10 (CSV upload validation) and B-04 statistics."""

import csv
import json
import re

import pytest

from synth import tabular

REASONS = {"missing_required", "wrong_type", "out_of_range", "unknown_category", "duplicate_id"}


def check(schema: dict, rows: list[dict]) -> dict[int, set[str]]:
    """Tiny reference validator: {row_index (0-based, header excluded): {reasons}}."""
    errors: dict[int, set[str]] = {}
    seen: set[str] = set()
    unique_cols = [c["name"] for c in schema["columns"] if c.get("unique")]
    for i, row in enumerate(rows):
        bad = set()
        for col in schema["columns"]:
            raw = row.get(col["name"], "")
            if raw == "":
                if col["required"]:
                    bad.add("missing_required")
                continue
            kind = col["type"]
            if kind == "int":
                if not re.fullmatch(r"-?\d+", raw):
                    bad.add("wrong_type")
                    continue
                value = int(raw)
            elif kind == "float":
                try:
                    value = float(raw)
                except ValueError:
                    bad.add("wrong_type")
                    continue
            else:
                value = raw
            if "allowed" in col and value not in col["allowed"]:
                bad.add("unknown_category")
            if "min" in col and value < col["min"] or "max" in col and value > col["max"]:
                bad.add("out_of_range")
            if "pattern" in col and not re.fullmatch(col["pattern"], raw):
                bad.add("wrong_type")
        for name in unique_cols:
            key = row.get(name, "")
            if key and key in seen:
                bad.add("duplicate_id")
            seen.add(key)
        if bad:
            errors[i] = bad
    return errors


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        return reader.fieldnames, list(reader)


@pytest.fixture(scope="module")
def generated(tmp_path_factory):
    out = tmp_path_factory.mktemp("tabular")
    tabular.generate(out, seed=42)
    return out, json.loads((out / "manifest.json").read_text())


def test_three_clean_csvs_with_100_rows_and_10_plus_columns(generated):
    out, manifest = generated
    assert manifest["counts"]["clean_files"] == 3
    assert manifest["counts"]["clean_rows"] == 300
    assert len(manifest["clean_files"]) == 3
    for name in manifest["clean_files"]:
        header, rows = read_csv(out / name)
        assert len(rows) == 100
        assert len(header) >= 10
        expected = {"patient_id", "age", "sex", "bmi", "sbp", "dbp", "glucose", "smoker",
                    "diagnosis", "time_to_event", "event", "study_accession"}
        assert expected <= set(header)


def test_schema_describes_every_column(generated):
    out, manifest = generated
    schema = json.loads((out / "schema.json").read_text())
    header, _ = read_csv(out / manifest["clean_files"][0])
    assert [c["name"] for c in schema["columns"]] == header
    for col in schema["columns"]:
        assert col["type"] in {"str", "int", "float", "category"}
        assert isinstance(col["required"], bool)
    assert any(c.get("unique") for c in schema["columns"])


def test_clean_csvs_pass_reference_checker(generated):
    out, manifest = generated
    schema = json.loads((out / "schema.json").read_text())
    all_ids = []
    for name in manifest["clean_files"]:
        _, rows = read_csv(out / name)
        assert check(schema, rows) == {}, name
        all_ids += [r["patient_id"] for r in rows]
    assert len(set(all_ids)) == 300


def test_clean_values_are_realistic_and_varied(generated):
    out, manifest = generated
    _, rows = read_csv(out / manifest["clean_files"][0])
    assert {r["sex"] for r in rows} == {"M", "F"}
    assert {r["diagnosis"] for r in rows} == {"0", "1"}
    assert {r["event"] for r in rows} == {"0", "1"}
    assert all(int(r["dbp"]) < int(r["sbp"]) for r in rows)
    ages = [int(r["age"]) for r in rows]
    assert max(ages) - min(ages) > 30
    # some optional values missing so imputation (TC-B04-04) has work to do
    assert any(r["glucose"] == "" for r in rows)


def test_outcomes_balanced_enough_for_regression(generated):
    """Logistic / survival models (TC-B04-07) need both classes well represented."""
    out, manifest = generated
    rows = [row for name in manifest["clean_files"] for row in read_csv(out / name)[1]]
    prevalence = sum(r["diagnosis"] == "1" for r in rows) / len(rows)
    event_rate = sum(r["event"] == "1" for r in rows) / len(rows)
    assert 0.2 <= prevalence <= 0.6
    assert 0.3 <= event_rate <= 0.8


def test_bad_csv_broken_rows_match_bad_rows_json(generated):
    out, manifest = generated
    schema = json.loads((out / "schema.json").read_text())
    _, rows = read_csv(out / "bad.csv")
    listed = json.loads((out / "bad_rows.json").read_text())
    assert listed["index_base"] == 0
    expected = {r["row"]: r["reason"] for r in listed["rows"]}
    found = check(schema, rows)
    assert set(found) == set(expected)
    for idx, reason in expected.items():
        assert found[idx] == {reason}, idx
    assert {r["reason"] for r in listed["rows"]} == REASONS
    assert len(rows) > len(expected)  # clean rows are mixed in
    assert manifest["counts"]["bad_rows"] == len(expected)
