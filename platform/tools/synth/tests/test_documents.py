import json
import zipfile

from synth import documents


def test_six_formats_one_each_and_deterministic(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    manifest = documents.generate(a)
    documents.generate(b)
    assert manifest["counts"] == {"documents": 6}
    assert sorted(f["format"] for f in manifest["files"]) == ["csv", "docx", "html", "json", "pdf", "txt"]
    for entry in manifest["files"]:
        assert (a / entry["file"]).read_bytes() == (b / entry["file"]).read_bytes()


def test_each_file_is_a_valid_instance_of_its_format(tmp_path):
    documents.generate(tmp_path)
    assert (tmp_path / "outpatient_hours.pdf").read_bytes().startswith(b"%PDF-1.4")
    with zipfile.ZipFile(tmp_path / "mri_preparation.docx") as z:
        assert "word/document.xml" in z.namelist() and "心律調節器" in z.read("word/document.xml").decode()
    assert json.loads((tmp_path / "lab_reference_ranges.json").read_text())["items"][1]["code"] == "HbA1c"
    assert (tmp_path / "department_extensions.csv").read_text().splitlines()[0] == "department,extension,floor"
    assert "自助報到機" in (tmp_path / "registration_flow.html").read_text()
    assert "乾洗手" in (tmp_path / "hand_hygiene.txt").read_text()


def test_unique_text_appears_only_in_its_own_file(tmp_path):
    manifest = documents.generate(tmp_path)
    texts = {"txt": (tmp_path / "hand_hygiene.txt").read_text(),
             "csv": (tmp_path / "department_extensions.csv").read_text(),
             "json": (tmp_path / "lab_reference_ranges.json").read_text(),
             "html": (tmp_path / "registration_flow.html").read_text()}
    for entry in manifest["files"]:
        for fmt, text in texts.items():
            assert (entry["unique_text"] in text) == (fmt == entry["format"]), (entry["format"], fmt)
