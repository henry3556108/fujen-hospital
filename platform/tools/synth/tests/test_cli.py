"""CLI (`python -m synth <command> --out DIR [--seed N]`), `all`, and determinism."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT = Path(__file__).resolve().parents[1]
KINDS = ["dicom", "nifti", "itk", "makesense", "tabular", "clinical", "vitals"]


def run(*args):
    return subprocess.run([sys.executable, "-m", "synth", *map(str, args)], cwd=PROJECT,
                          capture_output=True, text=True)


def hashes(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file()}


@pytest.fixture(scope="module")
def runs(tmp_path_factory):
    base = tmp_path_factory.mktemp("cli")
    for name, seed in (("a", 42), ("b", 42), ("c", 7)):
        res = run("all", "--out", base / name, "--seed", seed)
        assert res.returncode == 0, res.stderr
    return base


@pytest.mark.parametrize("command,extra,count_key,count", [
    ("dicom", ["--studies", "20"], "studies", 20),
    ("nifti", ["--count", "3"], "cases", 3),
    ("itk", ["--count", "3"], "cases", 3),
    ("makesense", ["--count", "3"], "exports", 3),
    ("tabular", [], "clean_rows", 300),
    ("clinical", [], "hl7_messages", 20),
    ("vitals", ["--count", "100"], "readings", 100),
])
def test_each_command_writes_manifest_with_default_seed(tmp_path, command, extra, count_key, count):
    res = run(command, "--out", tmp_path, *extra)
    assert res.returncode == 0, res.stderr
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["kind"] == command
    assert manifest["seed"] == 42
    assert manifest["counts"][count_key] == count


def test_unknown_command_fails(tmp_path):
    assert run("bogus", "--out", tmp_path).returncode != 0


def test_all_writes_every_kind_into_subfolders(runs):
    root = runs / "a"
    top = json.loads((root / "manifest.json").read_text())
    assert top["kind"] == "all" and top["seed"] == 42
    assert sorted(top["outputs"]) == sorted(KINDS)
    for kind in KINDS:
        sub = json.loads((root / kind / "manifest.json").read_text())
        assert sub["kind"] == kind
        assert top["outputs"][kind] == {"dir": kind, "counts": sub["counts"]}


def test_makesense_images_exist_in_dicom_output(runs):
    root = runs / "a"
    for export in sorted((root / "makesense").glob("makesense_*.json")):
        for image in json.loads(export.read_text())["images"]:
            assert (root / "dicom" / image["file_name"]).is_file()


def test_same_seed_is_byte_identical(runs):
    a, b = hashes(runs / "a"), hashes(runs / "b")
    assert a.keys() == b.keys()
    assert [k for k in a if a[k] != b[k]] == []


def test_different_seed_changes_every_kind(runs):
    a, c = hashes(runs / "a"), hashes(runs / "c")
    for kind in KINDS:
        data = [k for k in a if k.startswith(kind + "/") and not k.endswith("manifest.json")]
        assert data, kind
        changed = [k for k in data if a[k] != c.get(k)]
        assert len(changed) >= len(data) / 2, kind  # only static files (e.g. schema.json) may repeat


def test_different_seed_changes_dicom_identity_values(runs):
    a = json.loads((runs / "a" / "dicom" / "manifest.json").read_text())["studies"]
    c = json.loads((runs / "c" / "dicom" / "manifest.json").read_text())["studies"]
    for key in ("study_instance_uid", "patient_id", "patient_name", "study_date"):
        assert [s[key] for s in a] != [s[key] for s in c], key
