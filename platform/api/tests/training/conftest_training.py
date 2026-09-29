"""WP5b 測試共用：專案、成員、合成資料、記憶體版的排程／影像節點／推論／MLflow。"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from app.imaging.orthanc import InMemoryOrthanc
from app.models import Membership, Project
from app.permissions import DEFAULT_ROLE_PERMISSIONS, AccountType, Role
from app.scheduling.backend import FakeJobBackend
from app.training.inference import FakeInferenceBackend
from app.training.tracking import InMemoryTracker

PLATFORM = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PLATFORM / "training"))

SPLIT = {"train": 0.6, "validation": 0.2, "test": 0.2}
AUGMENT = {"rotation_range": 15, "width_shift_range": 0.1, "height_shift_range": 0.2, "shear_range": 5,
           "zoom_range": 0.15, "horizontal_flip": True, "vertical_flip": False}


@pytest.fixture(scope="session")
def synth(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("synth-training")
    subprocess.run(["uv", "run", "-q", "python", "-m", "synth", "all", "--out", str(out)],
                   cwd=PLATFORM / "tools" / "synth", check=True, capture_output=True)
    return out


@pytest.fixture
def backend(app):
    app.state.job_backend = FakeJobBackend()
    return app.state.job_backend


@pytest.fixture
def orthanc(app):
    app.state.orthanc = InMemoryOrthanc()
    return app.state.orthanc


@pytest.fixture
def inference(app):
    app.state.inference_backend = FakeInferenceBackend()
    return app.state.inference_backend


@pytest.fixture
def tracker(app):
    app.state.tracker = InMemoryTracker()
    return app.state.tracker


@pytest.fixture
def admin(add_user):
    return add_user("admin01", AccountType.ADMIN)[1]


@pytest.fixture
def project(session):
    p = Project(name="P1-lung-ct", gpu_group="gpu-exclusive")
    session.add(p)
    session.commit()
    return p


@pytest.fixture
def member(session, add_user, project):
    """加入 P1 並回傳 headers。預設角色 Principal Investigator（5 項權限都有）。"""
    def _member(username, role=Role.PRINCIPAL_INVESTIGATOR, target=None):
        user, headers = add_user(username)
        session.add(Membership(user_id=user.id, project_id=(target or project).id, role=role.value,
                               permissions=sorted(p.value for p in DEFAULT_ROLE_PERMISSIONS[role])))
        session.commit()
        return headers
    return _member


@pytest.fixture
def pi(member):
    return member("pi01")


# ---------- 資料 ----------

def upload_dicom(client, headers, pid, synth, studies=range(1, 21)):
    files = []
    for no in studies:
        for path in sorted((synth / "dicom" / f"study_{no:04d}").rglob("*.dcm")):
            files.append(("files", (path.relative_to(synth / "dicom").as_posix(), path.read_bytes())))
    response = client.post(f"/api/projects/{pid}/imaging/dicom", headers=headers, files=files)
    assert response.status_code == 201, response.text
    return response.json()


def upload_files(client, headers, pid, paths):
    response = client.post(f"/api/projects/{pid}/imaging/files", headers=headers,
                           files=[("files", (p.name, p.read_bytes())) for p in paths])
    assert response.status_code == 201, response.text
    return response.json()


def upload_csv(client, headers, pid, synth, name="cohort_01"):
    tab = synth / "tabular"
    response = client.post(f"/api/projects/{pid}/tabular/datasets", headers=headers,
                           data={"schema": (tab / "schema.json").read_text(), "name": name},
                           files={"file": (f"{name}.csv", (tab / f"{name}.csv").read_bytes(), "text/csv")})
    assert response.status_code == 201, response.text
    return response.json()["dataset"]["id"]


def study_uids(synth, studies=range(1, 21)) -> dict[int, dict]:
    manifest = json.loads((synth / "dicom" / "manifest.json").read_text())
    return {i + 1: s for i, s in enumerate(manifest["studies"]) if i + 1 in set(studies)}


@pytest.fixture
def images(client, pi, project, orthanc, synth):
    """P1 內有 20 個研究（100 張切片）與 3 份 makesense 標註（研究 1–3）。"""
    upload_dicom(client, pi, project.id, synth)
    upload_files(client, pi, project.id, sorted((synth / "makesense").glob("makesense_*.json")))
    return synth


@pytest.fixture
def volumes(client, pi, project, synth):
    """P1 內有 3 個 NIfTI 病例（影像＋標註）。"""
    upload_files(client, pi, project.id, sorted((synth / "nifti").glob("*.nii.gz")))
    return synth


@pytest.fixture
def table(client, pi, project, synth):
    return upload_csv(client, pi, project.id, synth)


# ---------- 設定 ----------

def modality_labels(synth) -> dict[str, str]:
    return {s["study_instance_uid"]: s["modality"] for s in study_uids(synth).values()}


def setting_body(kind, synth=None, dataset_id=None, **overrides):
    if kind == "image_classification":
        labels = modality_labels(synth) if synth else {"1.2.3": "CT", "1.2.4": "MR"}
        config = {"kind": kind, "source": {"type": "dicom", "studies": "all", "label_source": {
            "provider": "inline", "by": "study", "values": labels}},
            "image": {"resize": [32, 32], "labels": ["CT", "MR"]}, "augmentation": AUGMENT,
            "hyperparameters": {"epochs": 2, "batch_size": 8}}
    elif kind == "image_detection":
        config = {"kind": kind, "source": {"type": "dicom", "studies": "all",
                                           "label_source": {"provider": "makesense"}},
                  "image": {"resize": [32, 32], "labels": ["nodule", "organ"]}, "augmentation": AUGMENT,
                  "hyperparameters": {"epochs": 2, "max_boxes": 2}}
    elif kind == "image_segmentation":
        config = {"kind": kind, "source": {"type": "files", "format": "nifti", "cases": "all"},
                  "image": {"resize": [32, 32], "labels": ["class_1", "class_2"]}, "augmentation": AUGMENT,
                  "hyperparameters": {"epochs": 2}}
    elif kind == "tabular_classification":
        config = {"kind": kind, "source": {"type": "tabular", "dataset_id": dataset_id},
                  "tabular": {"target": "diagnosis", "features": ["age", "bmi", "glucose", "sbp"],
                              "steps": [{"id": "impute_mean", "columns": ["glucose"]},
                                        {"id": "scale_standard", "columns": ["age", "bmi"]}],
                              "algorithm": "random_forest"},
                  "hyperparameters": {"n_estimators": 20}}
    else:
        config = {"kind": kind, "source": {"type": "tabular", "dataset_id": dataset_id},
                  "tabular": {"target": "sbp", "features": ["age", "bmi", "glucose"],
                              "steps": [{"id": "impute_mean", "columns": ["glucose"]}],
                              "algorithm": "linear_regression"}}
    name = overrides.pop("name", None) or f"{kind} 設定"
    return {"name": name, "config": config | {"split": SPLIT, "seed": 42} | overrides}


def ok(response, status=200):
    assert response.status_code == status, f"{response.status_code} {response.text[:500]}"
    return response.json() if response.content else None
