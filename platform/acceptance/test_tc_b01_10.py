"""TC-B01-10 CSV 上傳驗證（經 Gateway）。執行方式見 tabular_support.py。"""
from tabular_support import bad_rows, p2, synth, upload  # noqa: F401


def test_tc_b01_10_csv_upload_validation(api, p2, synth):
    pid, pi, _, created = p2
    schema = (synth / "schema.json").read_text()
    accepted = 0
    for i in (1, 2, 3):
        response = upload(api, pid, pi, synth / f"cohort_0{i}.csv", schema, created)
        assert response.status_code == 201, response.text
        report = response.json()["report"]
        assert report["rejected_row_count"] == 0 and report["errors"] == []
        accepted += report["valid_rows"]
    assert accepted == 300

    response = upload(api, pid, pi, synth / "bad.csv", schema, created)
    assert response.status_code == 201, response.text
    report = response.json()["report"]
    expected = bad_rows(synth)
    assert {r["row"] for r in report["rejected"]} == expected  # 攔截 100%
    assert report["valid_rows"] == report["total_rows"] - len(expected)  # 誤放行 0
    listed = api.get(f"/api/projects/{pid}/tabular/datasets", headers=pi).json()
    assert {d["id"] for d in listed} >= set(created)
