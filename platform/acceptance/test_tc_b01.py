"""B-01 醫療影像匯入：經 Gateway 的驗收測試（需要本機整合環境與 seed 基線）。

環境變數：GATEWAY_URL、KEYCLOAK_URL（見 conftest）、PACS_URL（模擬 PACS 的 REST，預設 http://127.0.0.1:8043）、
PACS_USER／PACS_PASSWORD、SYNTH_DIR（已產生的合成資料；未設定則自動產生）、
COMPOSE_PROJECT（設定時用 docker compose exec 查稽核表）。
"""
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import httpx
import pytest

from conftest import DEV_PASSWORD, GATEWAY, KEYCLOAK

ROOT = Path(__file__).resolve().parents[1]
IMPORTER = ROOT / "tools" / "importer"
SYNTH = ROOT / "tools" / "synth"
PACS = os.environ.get("PACS_URL", "http://127.0.0.1:8043")
PACS_AUTH = (os.environ.get("PACS_USER", "pacs-admin"), os.environ.get("PACS_PASSWORD", "pacs-dev"))


# ---------- fixtures ----------

def _synth(out: Path, *args: str) -> None:
    subprocess.run(["uv", "run", "python", "-m", "synth", *args, "--out", str(out)], cwd=SYNTH, check=True,
                   capture_output=True)


@pytest.fixture(scope="module")
def synth_dir(tmp_path_factory) -> Path:
    if os.environ.get("SYNTH_DIR"):
        return Path(os.environ["SYNTH_DIR"])
    out = tmp_path_factory.mktemp("synth")
    _synth(out, "all")
    return out


@pytest.fixture(scope="module")
def manifest(synth_dir) -> dict:
    return json.loads((synth_dir / "dicom" / "manifest.json").read_text())


@pytest.fixture(scope="module")
def token_file(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("importer") / "token.json"


def importer(*args: str, token_file: Path) -> subprocess.CompletedProcess:
    env = {**os.environ, "GATEWAY_URL": GATEWAY, "KEYCLOAK_URL": KEYCLOAK, "IMPORTER_TOKEN_FILE": str(token_file)}
    return subprocess.run(["uv", "run", "python", "-m", "importer", *args], cwd=IMPORTER, env=env,
                          capture_output=True, text=True, input=DEV_PASSWORD + "\n", timeout=600)


@pytest.fixture(scope="module")
def logged_in(token_file) -> Path:
    r = importer("login", "--username", "ra01", "--password-stdin", token_file=token_file)
    assert r.returncode == 0, r.stderr
    return token_file


@pytest.fixture
def admin(auth):
    return auth("admin01")


@pytest.fixture
def p1(api, admin) -> int:
    return next(p["id"] for p in api.get("/api/admin/projects", headers=admin).json() if p["name"] == "P1-lung-ct")


@pytest.fixture(scope="module")
def dicom_imported(synth_dir, logged_in):
    """TC-B01-02 的匯入；其他案例依賴 P1 已有 20 個研究。重跑時全部是 duplicate，一樣回 0。"""
    r = importer("upload", "--project", "P1-lung-ct", "--exclude", "manifest.json", str(synth_dir / "dicom"),
                 token_file=logged_in)
    return r


def _studies(api, headers, pid, **params):
    r = api.get(f"/api/projects/{pid}/imaging/studies", headers=headers, params=params)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def temp_project(api, admin):
    """由 admin 建立的臨時專案，ra01 為 research_assistant；測完刪除（驗證刪專案會連同影像索引一起刪）。"""
    created = []

    def _make() -> int:
        pid = api.post("/api/admin/projects", headers=admin, json={"name": f"wp2-{time.time_ns()}"}).json()["id"]
        uid = next(u["id"] for u in api.get("/api/admin/users", headers=admin).json() if u["username"] == "ra01")
        assert api.put(f"/api/admin/projects/{pid}/members/{uid}", headers=admin,
                       json={"role": "research_assistant"}).status_code == 200
        created.append(pid)
        return pid
    yield _make
    for pid in created:
        assert api.delete(f"/api/admin/projects/{pid}", headers=admin).status_code == 204


# ---------- TC-B01-01 ----------

def test_tc_b01_01_cli_refuses_without_login(api, auth, p1, synth_dir, tmp_path):
    ra = auth("ra01")
    before = len(api.get(f"/api/projects/{p1}/imaging/jobs", headers=ra).json())
    r = importer("upload", "--project", "P1-lung-ct", str(synth_dir / "dicom"), token_file=tmp_path / "none.json")
    assert r.returncode == 2
    assert "登入" in r.stderr
    assert len(api.get(f"/api/projects/{p1}/imaging/jobs", headers=ra).json()) == before


# ---------- TC-B01-02 ----------

def test_tc_b01_02_dicom_batch_import_counts(api, auth, p1, manifest, dicom_imported):
    assert dicom_imported.returncode == 0, dicom_imported.stdout + dicom_imported.stderr
    assert "失敗 0" in dicom_imported.stdout
    studies = {s["study_instance_uid"]: s for s in _studies(api, auth("ra01"), p1)}
    expected = {s["study_instance_uid"]: s for s in manifest["studies"]}
    got = [studies[uid] for uid in expected if uid in studies]
    assert len(got) == manifest["counts"]["studies"]
    assert sum(len(s["series"]) for s in got) == manifest["counts"]["series"]
    assert sum(s["instances"] for s in got) == manifest["counts"]["instances"]


def test_tc_b01_02_dataset_audit_recorded(dicom_imported):
    project = os.environ.get("COMPOSE_PROJECT")
    if not project:
        pytest.skip("設定 COMPOSE_PROJECT 才能查稽核表")
    sql = "select count(*) from audit_log where category='dataset' and action like 'imaging.import_%' and actor='ra01'"
    out = subprocess.run(["docker", "compose", "-p", project, "exec", "-T", "postgres", "psql", "-U", "platform",
                          "-d", "platform", "-tAc", sql], capture_output=True, text=True, check=True,
                         cwd=ROOT / "deploy" / "local")
    assert int(out.stdout.strip()) >= 1


# ---------- TC-B01-03 ----------

def test_tc_b01_03_other_formats_parse(api, auth, p1, synth_dir, logged_in, dicom_imported):
    for sub in ("nifti", "itk", "makesense"):
        r = importer("upload", "--project", "P1-lung-ct", "--exclude", "manifest.json", str(synth_dir / sub),
                     token_file=logged_in)
        assert r.returncode == 0, r.stdout + r.stderr
        assert "失敗 0" in r.stdout
    files = api.get(f"/api/projects/{p1}/imaging/files", headers=auth("ra01")).json()
    per_format = {fmt: [f for f in files if f["format"] == fmt] for fmt in ("nifti", "itk", "makesense")}
    assert len(per_format["nifti"]) >= 6 and len(per_format["itk"]) >= 6 and len(per_format["makesense"]) >= 3


# ---------- TC-B01-04 ----------

def _upload(api, headers, pid, kind, paths: list[Path], base: Path):
    files = [("files", (p.relative_to(base).as_posix(), p.read_bytes())) for p in paths]
    r = api.post(f"/api/projects/{pid}/imaging/{kind}", headers=headers, files=files, timeout=120)
    assert r.status_code == 201, r.text
    return r.json()


def test_tc_b01_04_pairing_together_and_separately(api, auth, synth_dir, temp_project):
    ra = auth("ra01")
    errors = 0
    for fmt, ext in [("nifti", ".nii.gz"), ("itk", ".mha"), ("nifti", ".nii.gz")]:   # 同時匯入 3 次
        pid = temp_project()
        paths = sorted((synth_dir / fmt).glob(f"*{ext}"))
        _upload(api, ra, pid, "files", paths, synth_dir)
        errors += _pairing_errors(api, ra, pid, fmt, ext)
    for fmt, ext in [("itk", ".mha"), ("nifti", ".nii.gz"), ("itk", ".mha")]:        # 個別匯入 3 次（標註先）
        pid = temp_project()
        _upload(api, ra, pid, "files", sorted((synth_dir / fmt).glob(f"*_label{ext}")), synth_dir)
        _upload(api, ra, pid, "files", sorted((synth_dir / fmt).glob(f"*_image{ext}")), synth_dir)
        errors += _pairing_errors(api, ra, pid, fmt, ext)
    assert errors == 0


def _pairing_errors(api, headers, pid, fmt, ext) -> int:
    files = {f["filename"]: f for f in api.get(f"/api/projects/{pid}/imaging/files", headers=headers).json()}
    labels = [f for f in files.values() if f["role"] == "label"]
    assert len(labels) == 3
    bad = 0
    for label in labels:
        expected = label["filename"].replace(f"_label{ext}", f"_image{ext}")
        bad += label["pairing"] != "paired" or label["paired_image"] != expected
    return bad


def test_tc_b01_04_makesense_pairs_to_project_dicom(api, auth, p1, manifest, synth_dir, logged_in, dicom_imported):
    importer("upload", "--project", "P1-lung-ct", "--exclude", "manifest.json", str(synth_dir / "makesense"),
             token_file=logged_in)
    files = {f["filename"]: f for f in api.get(f"/api/projects/{p1}/imaging/files", headers=auth("ra01")).json()}
    for i in (1, 2, 3):
        f = files[f"makesense_{i:03d}.json"]
        assert f["pairing"] == "paired", f
        assert f["paired_sop_instance_uids"] == sorted(manifest["studies"][i - 1]["sop_instance_uids"])


# ---------- TC-B01-05 ----------

def test_tc_b01_05_bad_files_isolated(synth_dir, logged_in, tmp_path):
    folder = tmp_path / "mixed"
    folder.mkdir()
    good = sorted((synth_dir / "dicom" / "study_0001" / "series_001").glob("*.dcm"))[:2]
    for p in good:
        shutil.copy(p, folder / p.name)
    data = good[0].read_bytes()
    (folder / "truncated.dcm").write_bytes(data[: len(data) // 2])
    (folder / "report.txt").write_text("not an image")
    (folder / "fake.dcm").write_text("not a dicom either")
    r = importer("upload", "--project", "P1-lung-ct", str(folder), token_file=logged_in)
    assert r.returncode == 1
    lines = {line.split()[0]: line for line in r.stdout.splitlines() if line.split()}
    for name in ("truncated.dcm", "report.txt", "fake.dcm"):
        assert "failed" in lines[name] and len(lines[name].split()) >= 3, lines[name]   # 檔名＋結果＋原因
    for p in good:
        assert any(s in lines[p.name] for s in ("imported", "duplicate")), lines[p.name]

    empty = tmp_path / "empty"
    empty.mkdir()
    r = importer("upload", "--project", "P1-lung-ct", str(empty), token_file=logged_in)
    assert r.returncode == 1 and "沒有" in r.stderr


# ---------- TC-B01-06 ----------

def test_tc_b01_06_reimport_creates_no_duplicates(api, auth, p1, manifest, synth_dir, logged_in, dicom_imported):
    r = importer("upload", "--project", "P1-lung-ct", "--exclude", "manifest.json", str(synth_dir / "dicom"),
                 token_file=logged_in)
    assert r.returncode == 0
    assert f"匯入 0、重複 {manifest['counts']['instances']}、失敗 0" in r.stdout
    studies = {s["study_instance_uid"]: s for s in _studies(api, auth("ra01"), p1)}
    assert sum(studies[s["study_instance_uid"]]["instances"] for s in manifest["studies"]) == \
        manifest["counts"]["instances"]


# ---------- TC-B01-07 ----------

@pytest.fixture(scope="module")
def pacs_manifest(tmp_path_factory) -> dict:
    """另一個 seed 的 2 個研究放進模擬 PACS（UID 與平台已有的不同）。"""
    out = tmp_path_factory.mktemp("pacs")
    _synth(out, "dicom", "--studies", "2", "--seed", "7")
    m = json.loads((out / "manifest.json").read_text())
    with httpx.Client(base_url=PACS, auth=PACS_AUTH, timeout=30) as pacs:
        for study in m["studies"]:
            for rel in study["files"]:
                assert pacs.post("/instances", content=(out / rel).read_bytes()).status_code == 200
    return m


def test_tc_b01_07_pacs_find_and_move(api, auth, pacs_manifest, temp_project):
    ra = auth("ra01")
    pid = temp_project()
    for study in pacs_manifest["studies"]:
        start = time.monotonic()
        r = api.post(f"/api/projects/{pid}/imaging/pacs/query", headers=ra,
                     json={"StudyInstanceUID": study["study_instance_uid"]}, timeout=30)
        assert r.status_code == 200 and time.monotonic() - start < 30, r.text
        [answer] = r.json()
        assert (answer["AccessionNumber"], answer["PatientID"], answer["PatientSex"], answer["StudyDate"],
                answer["StudyDescription"], answer["Modality"]) == (
            study["accession_number"], study["patient_id"], study["patient_sex"], study["study_date"],
            study["study_description"], study["modality"])

        start = time.monotonic()
        r = api.post(f"/api/projects/{pid}/imaging/pacs/retrieve", headers=ra,
                     json={"study_instance_uid": study["study_instance_uid"]}, timeout=30)
        assert r.status_code == 201 and time.monotonic() - start < 30, r.text
        assert r.json()["counts"] == {"imported": len(study["files"]), "duplicate": 0, "failed": 0}
        got = api.get(f"/api/projects/{pid}/imaging/studies/{study['study_instance_uid']}", headers=ra).json()
        assert (got["accession_number"], got["patient_id"], got["patient_sex"], got["study_date"],
                got["study_description"], got["series"][0]["modality"], got["series"][0]["series_description"],
                got["instances"]) == (
            study["accession_number"], study["patient_id"], study["patient_sex"], study["study_date"],
            study["study_description"], study["modality"], study["series_description"], len(study["files"]))


# ---------- TC-B01-08 ----------

@pytest.fixture
def p1_allowlist(api, admin, p1, manifest, dicom_imported):
    allowed = manifest["accession_allowlist"]
    r = api.put(f"/api/projects/{p1}/imaging/accession-allowlist", headers=admin, json={"accession_numbers": allowed})
    assert r.status_code == 200 and len(r.json()["accession_numbers"]) == 10
    yield allowed
    api.put(f"/api/projects/{p1}/imaging/accession-allowlist", headers=admin, json={"accession_numbers": []})


def test_tc_b01_08_outside_allowlist_zero_success(api, auth, p1, manifest, p1_allowlist):
    ra = auth("ra01")
    inside = next(s for s in manifest["studies"] if s["accession_number"] in p1_allowlist)
    outside = [s for s in manifest["studies"] if s["accession_number"] not in p1_allowlist][:5]
    assert len(outside) == 5

    # 對照組：清單內的研究三個入口都拿得到（證明拒絕不是因為路由壞掉）
    assert api.get(f"/api/projects/{p1}/imaging/studies/{inside['study_instance_uid']}", headers=ra).status_code == 200
    ok = api.get(f"/dicomweb/projects/{p1}/studies/{inside['study_instance_uid']}/metadata", headers=ra)
    assert ok.status_code == 200 and ok.json()[0]["0020000D"]["Value"] == [inside["study_instance_uid"]]

    web = api_hits = dicomweb = 0
    for s in outside:
        uid = s["study_instance_uid"]
        # 網頁：研究清單頁呼叫的 API
        web += any(x["study_instance_uid"] == uid for x in _studies(api, ra, p1))
        # API：研究明細
        api_hits += api.get(f"/api/projects/{p1}/imaging/studies/{uid}", headers=ra).status_code == 200
        # DICOMweb（OHIF 走的路徑）：metadata、影格、QIDO 指定研究
        for path in (f"/studies/{uid}/metadata",
                     f"/studies/{uid}/series/{s['series_instance_uid']}/instances/{s['sop_instance_uids'][0]}/frames/1",
                     f"/studies?StudyInstanceUID={uid}"):
            dicomweb += api.get(f"/dicomweb/projects/{p1}{path}", headers=ra).status_code == 200
    assert (web, api_hits, dicomweb) == (0, 0, 0)


def test_tc_b01_08_dicomweb_bypass_attempts_denied(api, auth, p1, manifest, p1_allowlist):
    ra = auth("ra01")
    inside = next(s for s in manifest["studies"] if s["accession_number"] in p1_allowlist)["study_instance_uid"]
    outside = next(s for s in manifest["studies"] if s["accession_number"] not in p1_allowlist)["study_instance_uid"]
    attempts = [
        f"/dicomweb/projects/{p1}/studies/{inside}/%2e%2e/{outside}/metadata",
        f"/dicomweb/projects/{p1}/studies/{inside}/..%2f{outside}/metadata",
        f"/dicomweb/projects/{p1}/studies?StudyInstanceUID={inside},{outside}",
        f"/dicomweb/projects/{p1}/studies?StudyInstanceUID={inside}&StudyInstanceUID={outside}",
        f"/dicomweb/projects/{p1}/studies?StudyInstanceUID={inside}%5C{outside}",
        f"/dicomweb/projects/{p1}/studies",
        f"/dicomweb/projects/{p1}/series",
        f"/dicomweb/projects/{p1}/studies/{inside};/../{outside}/metadata",
    ]
    for path in attempts:
        r = httpx.get(GATEWAY + path, headers=ra, timeout=10)
        assert r.status_code != 200, path
    # 非讀取方法（STOW）不開放
    assert api.post(f"/dicomweb/projects/{p1}/studies", headers=ra, content=b"x").status_code in (403, 404, 405)


# ---------- TC-B01-09 ----------

def test_tc_b01_09_study_list_pages(api, auth, p1, dicom_imported):
    """研究清單分頁：帶 limit 回 {items, total, offset, limit}；各頁依序接起來＝不分頁的完整清單。"""
    ra = auth("ra01")
    everything = [s["study_instance_uid"] for s in _studies(api, ra, p1)]
    assert len(everything) >= 20
    paged = []
    for offset in range(0, len(everything), 7):
        body = _studies(api, ra, p1, limit=7, offset=offset)
        assert (body["total"], body["offset"], body["limit"]) == (len(everything), offset, 7)
        paged += [s["study_instance_uid"] for s in body["items"]]
    assert paged == everything
    assert api.get(f"/api/projects/{p1}/imaging/studies", headers=ra, params={"limit": 0}).status_code == 422


def test_tc_b01_09_five_field_filters(api, auth, p1, manifest, dicom_imported):
    ra = auth("ra01")
    ours = {s["study_instance_uid"]: s for s in manifest["studies"]}
    first = manifest["studies"][0]
    checks = {
        "modality": (first["modality"], lambda s: s["modality"] == first["modality"]),
        "patient_sex": (first["patient_sex"], lambda s: s["patient_sex"] == first["patient_sex"]),
        "study_description": (first["study_description"],
                              lambda s: first["study_description"].upper() in s["study_description"].upper()),
        "study_date": (first["study_date"], lambda s: s["study_date"] == first["study_date"]),
        "series_description": (first["series_description"],
                               lambda s: first["series_description"].upper() in s["series_description"].upper()),
    }
    mismatches = 0
    for field, (value, pred) in checks.items():
        got = _studies(api, ra, p1, **{field: value})
        got_ours = {s["study_instance_uid"] for s in got if s["study_instance_uid"] in ours}
        expected = {uid for uid, s in ours.items() if pred(s)}
        mismatches += len(got_ours ^ expected)
        for s in got:   # 回傳的每一筆都要符合條件（含非本批資料）
            if field == "modality":
                mismatches += value not in s["modalities"]
            elif field == "series_description":
                mismatches += not any(value.upper() in x["series_description"].upper() for x in s["series"])
            else:
                mismatches += not pred(s)
    assert mismatches == 0


# ---------- TC-SS-05（影像相關內部服務） ----------

@pytest.mark.parametrize("url", ["http://localhost:8042/dicom-web/studies", "http://localhost:4242",
                                 "http://localhost:9000/minio/health/live"])
def test_tc_ss_05_orthanc_and_minio_not_reachable_from_host(url):
    for _ in range(10):
        with pytest.raises(httpx.TransportError):
            httpx.get(url, timeout=2)


def test_tc_ss_05_orthanc_not_reachable_through_gateway_without_auth(api, p1):
    for path in ["/dicom-web/studies", "/instances", f"/dicomweb/projects/{p1}/studies/1.2.3/metadata"] * 3 + [
            "/tools/find"]:
        assert api.get(path).status_code in (401, 404)
