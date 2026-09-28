import csv
import io

from sqlalchemy import select

from app.models import AuditLog
from tabular_helpers import PROJECT_ONLY, bad_rows, dataset, member, schema_text, synth, upload  # noqa: F401


def _rows(data: bytes) -> list[dict]:
    return list(csv.DictReader(io.StringIO(data.decode("utf-8"))))


def test_tc_b01_10_three_clean_csvs_all_rows_accepted(client, member, synth, schema_text):
    pid, headers = member("pi01")
    total = 0
    for i in (1, 2, 3):
        response = upload(client, pid, headers, (synth / f"cohort_0{i}.csv").read_bytes(), schema_text,
                          name=f"cohort_0{i}")
        assert response.status_code == 201, response.text
        body = response.json()
        report, ds = body["report"], body["dataset"]
        assert report["valid_rows"] == 100 and report["rejected_row_count"] == 0 and report["errors"] == []
        assert ds["valid_rows"] == 100 and ds["rejected_rows"] == 0 and ds["total_rows"] == 100
        total += report["valid_rows"]
    assert total == 300


def test_tc_b01_10_bad_csv_rejects_exactly_the_broken_rows(client, member, synth, schema_text, store):
    pid, headers = member("pi01")
    response = upload(client, pid, headers, (synth / "bad.csv").read_bytes(), schema_text, name="bad")
    assert response.status_code == 201, response.text
    report = response.json()["report"]
    expected = bad_rows(synth)
    rejected = {r["row"] for r in report["rejected"]}
    assert rejected == expected  # 攔截 100%，且沒有誤殺
    assert all(r["reason"] for r in report["rejected"])
    assert report["valid_rows"] == 30 - len(expected)
    # 誤放行 0：乾淨檔裡沒有任何壞列的病人編號組合
    ds = response.json()["dataset"]
    clean = _rows(store.get(ds["object_key"]))
    original = _rows((synth / "bad.csv").read_bytes())
    kept = [original[i] for i in range(len(original)) if i not in expected]
    assert [r["patient_id"] for r in clean] == [r["patient_id"] for r in kept]
    assert len(clean) == report["valid_rows"]


def test_tc_b01_10_clean_and_original_stored(client, member, synth, schema_text, store):
    pid, headers = member("pi01")
    raw = (synth / "cohort_02.csv").read_bytes()
    ds = upload(client, pid, headers, raw, schema_text, name="c2").json()["dataset"]
    prefix = f"projects/{pid}/tabular/{ds['id']}/"
    assert ds["object_key"] == prefix + "clean.csv"
    assert store.get(prefix + "original.csv") == raw
    clean = _rows(store.get(ds["object_key"]))
    assert len(clean) == 100 and list(clean[0]) == list(_rows(raw)[0])


def test_upload_defaults_name_to_filename(client, member, synth, schema_text):
    pid, headers = member("pi01")
    response = upload(client, pid, headers, (synth / "cohort_01.csv").read_bytes(), schema_text,
                      filename="cohort_01.csv")
    assert response.status_code == 201 and response.json()["dataset"]["name"] == "cohort_01.csv"


def test_upload_audited_with_row_counts(client, member, synth, schema_text, session):
    pid, headers = member("pi01")
    ds = upload(client, pid, headers, (synth / "bad.csv").read_bytes(), schema_text, name="bad").json()["dataset"]
    entry = session.scalars(select(AuditLog).where(AuditLog.action == "tabular_upload")).one()
    assert entry.category == "dataset" and entry.actor == "pi01" and entry.result == "success"
    assert entry.target == f"tabular_dataset:{ds['id']}"
    assert entry.detail["project_id"] == pid
    assert (entry.detail["total_rows"], entry.detail["valid_rows"], entry.detail["rejected_rows"]) == (30, 20, 10)


def test_viewer_with_project_permission_can_upload(client, member, synth, schema_text):
    pid, headers = member("vw01", PROJECT_ONLY)
    assert upload(client, pid, headers, (synth / "cohort_01.csv").read_bytes(), schema_text).status_code == 201


def test_non_member_is_403_and_nothing_stored(client, member, add_user, synth, schema_text, store):
    pid, _ = member("pi01")
    _, outsider = add_user("user01")
    response = upload(client, pid, outsider, (synth / "cohort_01.csv").read_bytes(), schema_text)
    assert response.status_code == 403
    assert store.list("projects/") == []


def test_unauthenticated_is_401(client, member, synth, schema_text):
    pid, _ = member("pi01")
    assert upload(client, pid, {}, b"a\n1\n", schema_text).status_code == 401


def test_invalid_schema_is_422_with_tabular_error(client, member):
    pid, headers = member("pi01")
    response = upload(client, pid, headers, b"a\n1\n", '{"columns": []}')
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "schema_invalid" and "欄位" in detail["message"]


def test_schema_not_json_is_422(client, member):
    pid, headers = member("pi01")
    response = upload(client, pid, headers, b"a\n1\n", "not json")
    assert response.status_code == 422 and response.json()["detail"]["code"] == "schema_invalid"


def test_missing_required_columns_is_422_nothing_stored_and_audited_rejected(
        client, member, schema_text, store, session):
    pid, headers = member("pi01")
    response = upload(client, pid, headers, b"patient_id,age\nP10001,30\n", schema_text, name="x")
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "missing_required_columns" and "缺少必要欄位" in detail["message"]
    assert detail["detail"]["report"]["valid_rows"] == 0
    assert store.list("projects/") == []
    entry = session.scalars(select(AuditLog).where(AuditLog.action == "tabular_upload")).one()
    assert entry.result == "rejected" and entry.detail["valid_rows"] == 0


def test_all_rows_rejected_is_422(client, member, schema_text, store):
    pid, headers = member("pi01")
    csv_text = ("patient_id,age,sex,bmi,sbp,dbp,glucose,smoker,diagnosis,time_to_event,event,study_accession\n"
                "P10001,999,M,20,120,80,100,never,0,100,0,\n")
    response = upload(client, pid, headers, csv_text.encode(), schema_text)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "no_valid_rows"
    assert response.json()["detail"]["detail"]["report"]["rejected_row_count"] == 1
    assert store.list("projects/") == []


def test_upload_over_size_limit_is_413_in_chinese(app, client, member, synth, schema_text, store):
    app.state.tabular_max_upload_bytes = 1024
    pid, headers = member("pi01")
    response = upload(client, pid, headers, (synth / "cohort_01.csv").read_bytes(), schema_text)
    assert response.status_code == 413
    assert "檔案超過上限" in response.json()["detail"]
    assert store.list("projects/") == []


def test_duplicate_name_in_project_is_409(client, member, synth, schema_text):
    pid, headers = member("pi01")
    raw = (synth / "cohort_01.csv").read_bytes()
    assert upload(client, pid, headers, raw, schema_text, name="same").status_code == 201
    assert upload(client, pid, headers, raw, schema_text, name="same").status_code == 409
