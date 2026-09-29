import pytest

from imaging_support import (STUDIES, member, orthanc, project, series_uid, sop_uid, study_files,  # noqa: F401
                             study_uid, upload)


@pytest.fixture
def lab(client, orthanc, project, member):
    """P1 已匯入 4 個研究（各 3 張）；md01 有 labeling、vw01 只有 project。"""
    p1 = project("P1")
    md = member("md01", p1, ("project", "labeling", "prediction"))
    vw = member("vw01", p1, ("project", "prediction"))
    assert upload(client, md, p1.id, [f for no in STUDIES for f in study_files(no)]).status_code == 201

    class Lab:
        pid = p1.id
        project = p1
        doctor = md
        viewer = vw
        base = f"/api/projects/{p1.id}/labels"

        @staticmethod
        def target(no: int, s: int | None = 1) -> dict:
            t = {"study_instance_uid": study_uid(no)}
            if s is not None:
                t |= {"series_instance_uid": series_uid(no), "sop_instance_uid": sop_uid(no, s)}
            return t

    return Lab


def seg_payload(seed: int = 0, size: int = 8) -> dict:
    lung = 1 + seed % (size * size - 2)
    return {"shape": [size, size], "encoding": "rle", "rle": [[0, size * size - lung - 1], [1, lung], [2, 1]],
            "label_names": {"background": 0, "lung": 1, "nodule": 2}}


def det_payload(seed: int = 0, size: int = 8) -> dict:
    x = seed % (size - 2)
    return {"shape": [size, size], "box_format": "xyxy",
            "boxes": [{"label": "nodule", "box": [x, 1, x + 2, 4], "score": 0.75}, {"label": "lung", "box": [0, 0, size, size]}]}
