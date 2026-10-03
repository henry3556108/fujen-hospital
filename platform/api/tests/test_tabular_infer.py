"""上傳免寫 JSON：推斷欄位結構與預檢（QOCA 改善 A1），並維持 TC-B01-10。"""
import csv
import io
import json

from sqlalchemy import select

from app.models import AuditLog
from app.scanning import FakeScanner, eicar
from app.tabular_api.models import TabularDataset
from tabular_helpers import bad_rows, member, synth, upload  # noqa: F401


def infer(client, pid, headers, csv_bytes: bytes, missing_values=None, filename="data.csv"):
    data = {} if missing_values is None else {"missing_values": missing_values}
    return client.post(f"/api/projects/{pid}/tabular/schema/infer", headers=headers,
                       files={"file": (filename, csv_bytes, "text/csv")}, data=data)


def check(client, pid, headers, csv_bytes: bytes, schema: str):
    return client.post(f"/api/projects/{pid}/tabular/schema/check", headers=headers,
                       files={"file": ("data.csv", csv_bytes, "text/csv")}, data={"schema": schema})


def _rows(data: bytes) -> list[dict]:
    return list(csv.DictReader(io.StringIO(data.decode("utf-8"))))


def _require(schema: dict, *names: str) -> dict:
    for c in schema["columns"]:
        if c["name"] in names:
            c["required"] = True
    return schema


def test_infer_returns_schema_column_summary_and_dry_run_without_writing(client, member, synth, store, session):
    pid, headers = member("pi01")
    response = infer(client, pid, headers, (synth / "bad.csv").read_bytes())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["row_count"] == 30 and body["encoding"] == "utf-8"
    names = [c["name"] for c in body["schema"]["columns"]]
    assert names == [c["name"] for c in body["columns"]] and names[0] == "patient_id"
    types = {c["name"]: c["type"] for c in body["schema"]["columns"]}
    assert types["age"] == "int" and types["bmi"] == "float" and types["sex"] == "category"
    # 0／1 欄位維持整數，摘要標成是／否（網頁顯示「整數（0／1，是／否）」，與資料頁一致）
    binary = {c["name"]: c["binary01"] for c in body["columns"]}
    assert types["diagnosis"] == "int" and binary["diagnosis"] is True and binary["age"] is False
    patient = body["columns"][0]
    assert patient["identifier"] is True and patient["distinct"] == 28 and len(patient["examples"]) == 3
    assert body["report"]["total_rows"] == 30
    assert {r["row"] for r in body["report"]["rejected"]} <= bad_rows(synth)
    # 預檢不建立資料集、不寫物件、不寫稽核
    assert store.list("") == []
    assert session.scalars(select(TabularDataset)).all() == []
    assert session.scalars(select(AuditLog).where(AuditLog.category == "dataset")).all() == []


def test_tc_b01_10_bad_csv_with_inferred_schema_rejects_every_bad_row(client, member, synth, store):
    pid, headers = member("pi01")
    raw = (synth / "bad.csv").read_bytes()
    schema = infer(client, pid, headers, raw).json()["schema"]
    # 唯一要使用者確認的：sbp 在這份檔案有空白，推斷為選填，使用者在欄位表勾選「必填」
    response = upload(client, pid, headers, raw, json.dumps(_require(schema, "sbp")), name="bad-inferred")
    assert response.status_code == 201, response.text
    report, ds = response.json()["report"], response.json()["dataset"]
    expected = bad_rows(synth)
    assert {r["row"] for r in report["rejected"]} == expected  # 攔截 100%
    assert all(r["reason"] for r in report["rejected"])
    assert report["valid_rows"] == 30 - len(expected)  # 誤放行 0
    original = _rows(raw)
    kept = [original[i]["patient_id"] for i in range(len(original)) if i not in expected]
    assert [r["patient_id"] for r in _rows(store.get(ds["object_key"]))] == kept


def test_tc_b01_10_inferred_schema_alone_never_rejects_a_good_bad_csv_row(client, member, synth):
    pid, headers = member("pi01")
    raw = (synth / "bad.csv").read_bytes()
    schema = infer(client, pid, headers, raw).json()["schema"]
    report = upload(client, pid, headers, raw, json.dumps(schema), name="bad-raw").json()["report"]
    rejected = {r["row"] for r in report["rejected"]}
    assert rejected <= bad_rows(synth)
    assert bad_rows(synth) - rejected == {7, 25}  # 兩格 sbp 空白，需勾選必填


def test_tc_b01_10_three_cohorts_with_inferred_schema_accept_all_300_rows(client, member, synth):
    pid, headers = member("pi01")
    total = 0
    for i in (1, 2, 3):
        raw = (synth / f"cohort_0{i}.csv").read_bytes()
        result = infer(client, pid, headers, raw).json()
        assert result["report"]["rejected_row_count"] == 0
        response = upload(client, pid, headers, raw, json.dumps(result["schema"]), name=f"c{i}")
        assert response.status_code == 201, response.text
        report = response.json()["report"]
        assert report["rejected_row_count"] == 0 and report["errors"] == []
        total += report["valid_rows"]
    assert total == 300


def test_custom_missing_values(client, member):
    pid, headers = member("pi01")
    raw = "id,bmi\n1,999\n2,20.5\n3,21.5\n".encode()
    body = infer(client, pid, headers, raw, missing_values=json.dumps(["999"])).json()
    bmi = body["schema"]["columns"][1]
    assert bmi["missing_values"] == ["999"] and bmi["required"] is False and body["columns"][1]["missing"] == 1
    bad = infer(client, pid, headers, raw, missing_values="NA,N/A")
    assert bad.status_code == 422 and "缺值" in bad.json()["detail"]["message"]


def test_chinese_column_names_work_from_upload_to_analysis(client, member):
    pid, headers = member("pi01")
    rows = ["病歷號,年齡,性別,收縮壓 (mmHg),是否糖尿病"]
    rows += [f"A{i:04d},{40 + i % 40},{'男' if i % 2 else '女'},{110 + i % 30},{i % 2}" for i in range(60)]
    raw = ("\n".join(rows) + "\n").encode("utf-8")
    result = infer(client, pid, headers, raw).json()
    assert [c["name"] for c in result["schema"]["columns"]] == ["病歷號", "年齡", "性別", "收縮壓 (mmHg)", "是否糖尿病"]
    ds = upload(client, pid, headers, raw, json.dumps(result["schema"]), name="中文資料").json()["dataset"]
    base = f"/api/projects/{pid}/tabular/datasets/{ds['id']}"
    detail = client.get(base, headers=headers).json()
    assert [c["name"] for c in detail["columns"]][3] == "收縮壓 (mmHg)"
    assert {c["name"]: c["unique"] for c in detail["columns"]}["性別"] == 2
    describe = client.get(f"{base}/describe", headers=headers).json()
    assert next(c for c in describe["columns"] if c["name"] == "年齡")["count"] == 60
    steps = [{"id": "onehot", "columns": ["性別"], "params": {}}]
    saved = client.put(f"{base}/target-feature", headers=headers,
                       json={"target": "是否糖尿病", "features": ["年齡", "收縮壓 (mmHg)", "性別_女", "性別_男"],
                             "steps": steps})
    assert saved.status_code == 200, saved.text


def test_big5_csv_from_excel_is_accepted(client, member):
    pid, headers = member("pi01")
    raw = "病歷號,年齡\nA1,60\nA2,61\n".encode("cp950")
    body = infer(client, pid, headers, raw).json()
    assert body["encoding"] == "cp950" and body["schema"]["columns"][0]["name"] == "病歷號"
    response = upload(client, pid, headers, raw, json.dumps(body["schema"]), name="big5")
    assert response.status_code == 201
    assert response.json()["report"]["warnings"][0]["code"] == "big5_encoding"


def test_check_validates_an_edited_schema_without_writing(client, member, synth, store):
    pid, headers = member("pi01")
    raw = (synth / "bad.csv").read_bytes()
    schema = _require(infer(client, pid, headers, raw).json()["schema"], "sbp")
    response = check(client, pid, headers, raw, json.dumps(schema))
    assert response.status_code == 200
    assert {r["row"] for r in response.json()["report"]["rejected"]} == bad_rows(synth)
    assert store.list("") == []
    assert check(client, pid, headers, raw, '{"columns": []}').status_code == 422


def test_file_problems_are_422_in_chinese(client, member):
    pid, headers = member("pi01")
    for raw, code, words in [
        (b"", "empty_file", "空的"),
        (b"a,b\n", "empty_file", "只有標題列"),
        (b"a,,c\n1,2,3\n", "blank_column_name", "第 2 欄沒有欄名"),
        (b"a,b,a\n1,2,3\n", "duplicate_columns", "欄名重複"),
        (b"a\n\xff\xfe\xfa\n", "bad_encoding", "編碼"),
    ]:
        response = infer(client, pid, headers, raw)
        assert response.status_code == 422, raw
        detail = response.json()["detail"]
        assert detail["code"] == code and words in detail["message"]


def test_auth_and_membership(client, member, add_user):
    pid, _ = member("pi01")
    _, outsider = add_user("user01")
    assert infer(client, pid, {}, b"a\n1\n").status_code == 401
    assert infer(client, pid, outsider, b"a\n1\n").status_code == 403
    assert check(client, pid, outsider, b"a\n1\n", '{"columns":[{"name":"a","type":"int"}]}').status_code == 403


def test_viewer_with_project_permission_can_infer(client, member):
    pid, headers = member("vw01", ["project"])
    assert infer(client, pid, headers, b"a\n1\n2\n").status_code == 200


def test_over_size_limit_is_413(app, client, member, synth):
    app.state.tabular_max_upload_bytes = 1024
    pid, headers = member("pi01")
    for response in (infer(client, pid, headers, (synth / "cohort_01.csv").read_bytes()),
                     check(client, pid, headers, (synth / "cohort_01.csv").read_bytes(), "{}")):
        assert response.status_code == 413 and "檔案超過上限" in response.json()["detail"]


def test_tc_d01_06_infer_and_check_are_scanned(app, client, member, synth, session):
    scanner = app.state.scanner = FakeScanner()
    pid, headers = member("pi01")
    infected = (synth / "cohort_01.csv").read_bytes() + b"\n" + eicar()
    response = infer(client, pid, headers, infected, filename="infected.csv")
    assert response.status_code == 422 and response.json()["detail"]["code"] == "malware_detected"
    response = check(client, pid, headers, infected, '{"columns":[{"name":"age","type":"int"}]}')
    assert response.status_code == 422 and response.json()["detail"]["code"] == "malware_detected"
    rows = session.scalars(select(AuditLog).where(AuditLog.action == "malware_blocked")).all()
    assert len(rows) == 2 and all(r.category == "dataset" for r in rows)
    assert infer(client, pid, headers, (synth / "cohort_01.csv").read_bytes(), filename="ok.csv").status_code == 200
    assert "ok.csv" in scanner.scanned
