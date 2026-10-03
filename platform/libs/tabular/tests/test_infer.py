"""Schema inference for upload without hand-written JSON (QOCA UX A1).

Inference is conservative: the type comes from the majority (>= 95%) of values, and the few cells
that do not fit are rejected at validation and listed instead of loosening the type (TC-B01-10).
"""

import io
import json
from pathlib import Path

import pytest

from fixtures.generate import CSV_PATH, load_schema
from tabular.errors import TabularError
from tabular.infer import DEFAULT_MISSING_VALUES, infer_schema
from tabular.schema import Schema
from tabular.validate import validate_csv

WEB_FIXTURES = Path(__file__).resolve().parents[3] / "web" / "tests" / "fixtures" / "tabular"


def _infer(text: str, **kw) -> dict:
    return infer_schema(io.BytesIO(text.encode("utf-8")), **kw)


def _col(result: dict, name: str) -> dict:
    return next(c for c in result["schema"]["columns"] if c["name"] == name)


def _summary(result: dict, name: str) -> dict:
    return next(c for c in result["columns"] if c["name"] == name)


def _csv(header: list[str], rows: list[list[object]]) -> str:
    return "\n".join([",".join(header), *(",".join(str(v) for v in r) for r in rows)]) + "\n"


# --- 型態：多數值決定 ---

def test_majority_integer_column_stays_integer_and_odd_cell_is_rejected():
    rows = [[i, 100 + i] for i in range(40)]
    rows[5][1] = "12O"  # 字母 O
    result = _infer(_csv(["id", "sbp_value"], rows))
    assert _col(result, "sbp_value")["type"] == "int"
    s = _summary(result, "sbp_value")
    assert s["non_conforming"] == 1 and any("12O" in n for n in s["notes"])
    assert [(r["row"], r["column"]) for r in result["report"]["rejected"]] == [(5, "sbp_value")]
    assert "不是整數" in result["report"]["rejected"][0]["reason"]


def test_type_order_and_threshold():
    rows = [[f"{i}.5", i, "2024-01-%02d" % (i % 28 + 1), "是" if i % 2 else "否", f"w{i}"] for i in range(40)]
    result = _infer(_csv(["f", "i", "d", "b", "t"], rows))
    assert [c["type"] for c in result["schema"]["columns"]] == ["float", "int", "date", "bool", "str"]


def test_mixed_ints_and_decimals_are_float():
    result = _infer(_csv(["x"], [[v] for v in ["1", "2.5", "3", "4.25"] * 10]))
    assert _col(result, "x")["type"] == "float"


def test_below_threshold_falls_back_to_text():
    values = [str(i) for i in range(16)] + ["a", "b", "c", "d"]  # 80% 數字
    result = _infer(_csv(["x"], [[v] for v in values]))
    assert _col(result, "x")["type"] == "str"
    assert result["report"]["rejected"] == []


def test_zero_one_codes_are_integers_not_booleans():
    result = _infer(_csv(["event"], [[i % 2] for i in range(30)]))
    col = _col(result, "event")
    assert col["type"] == "int" and col["min"] == 0


# --- 缺值寫法 ---

def test_default_missing_tokens_are_missing_and_listed_in_schema():
    rows = [[i, "NA" if i == 3 else ("n/a" if i == 4 else ("-" if i == 5 else 20.5 + i))] for i in range(30)]
    result = _infer(_csv(["id", "bmi"], rows))
    col = _col(result, "bmi")
    assert col["type"] == "float" and col["required"] is False
    assert col["missing_values"] == DEFAULT_MISSING_VALUES
    assert _summary(result, "bmi")["missing"] == 3
    assert result["report"]["rejected"] == []
    assert result["missing_values"] == DEFAULT_MISSING_VALUES


def test_custom_missing_tokens():
    rows = [[i, "999" if i < 2 else 20 + i] for i in range(30)]
    result = _infer(_csv(["id", "bmi"], rows), missing_values=["999"])
    assert _summary(result, "bmi")["missing"] == 2 and _col(result, "bmi")["missing_values"] == ["999"]
    with pytest.raises(TabularError, match="缺值"):
        _infer(_csv(["id"], [[1]]), missing_values="NA")


# --- 必填 ---

def test_required_only_when_no_missing():
    rows = [[i, 100 + i, "" if i == 2 else 1] for i in range(30)]
    result = _infer(_csv(["id", "a", "b"], rows))
    assert _col(result, "a")["required"] is True
    assert _col(result, "b")["required"] is False
    assert any("必填" in n for n in _summary(result, "b")["notes"])


def test_all_blank_column_is_optional_text():
    result = _infer(_csv(["id", "note"], [[i, ""] for i in range(10)]))
    assert _col(result, "note")["type"] == "str" and _col(result, "note")["required"] is False
    assert any("空白" in n for n in _summary(result, "note")["notes"])


# --- 文字：格式、識別碼、類別 ---

def test_identifier_with_fixed_format_is_unique_with_pattern():
    rows = [[f"P{90000 + i}", i % 3] for i in range(30)]
    rows[10][0] = rows[0][0]
    result = _infer(_csv(["patient_id", "g"], rows))
    col = _col(result, "patient_id")
    assert col["type"] == "str" and col["unique"] is True and col["pattern"] == r"^P\d{5}$"
    assert _summary(result, "patient_id")["identifier"] is True
    assert [(r["row"], r["column"]) for r in result["report"]["rejected"]] == [(10, "patient_id")]


def test_integer_id_by_name_is_unique():
    result = infer_schema(CSV_PATH)
    assert _col(result, "patient_id")["unique"] is True and _col(result, "patient_id")["type"] == "int"


def test_category_allowed_values_exclude_rare_values():
    values = ["M", "F"] * 15 + ["unknown"]
    values.insert(10, "unknown")  # 出現 2 次仍算罕見
    result = _infer(_csv(["sex"], [[v] for v in values]))
    col = _col(result, "sex")
    assert col["type"] == "category" and col["allowed"] == ["F", "M"]
    assert _summary(result, "sex")["rare_values"] == ["unknown"]
    assert [r["row"] for r in result["report"]["rejected"]] == [10, 31]


def test_small_files_keep_every_category_value():
    result = _infer(_csv(["sex"], [["M"], ["F"], ["M"], ["X"], ["F"], ["M"]]))
    assert _col(result, "sex")["allowed"] == ["F", "M", "X"]


def test_codes_with_digits_keep_pattern_but_no_allowed_list():
    values = [f"ACC{i % 20 + 1:04d}" for i in range(15)] + [""] * 15
    result = _infer(_csv(["id", "acc"], [[i, v] for i, v in enumerate(values)]))
    col = _col(result, "acc")
    assert col["pattern"] == r"^ACC\d{4}$" and col["allowed"] is None and col["unique"] is False


def test_free_text_is_str_without_rules():
    result = _infer(_csv(["note"], [[f"note {i} words{'x' * i}"] for i in range(30)]))
    col = _col(result, "note")
    assert col["type"] == "str" and col["allowed"] is None and col["unique"] is False


# --- 範圍 ---

def test_known_clinical_names_get_a_plausible_range():
    rows = [[30 + i, 22.5, 120] for i in range(30)]
    rows[3][0] = 150
    result = _infer(_csv(["年齡", "BMI", "收縮壓 (mmHg)"], rows))
    assert (_col(result, "年齡")["min"], _col(result, "年齡")["max"]) == (0, 120)
    assert (_col(result, "BMI")["min"], _col(result, "BMI")["max"]) == (10, 80)
    assert (_col(result, "收縮壓 (mmHg)")["min"], _col(result, "收縮壓 (mmHg)")["max"]) == (40, 300)
    assert _summary(result, "年齡")["range_source"] == "name"
    assert [(r["row"], r["column"]) for r in result["report"]["rejected"]] == [(3, "年齡")]


def test_name_range_not_applied_when_data_disagrees():
    # 體溫用華氏記錄：大多數值超出 30–45，不套用（避免整欄被拒）
    result = _infer(_csv(["體溫"], [[97 + i % 4] for i in range(30)]))
    assert _col(result, "體溫")["max"] is None and _summary(result, "體溫")["range_source"] != "name"


def test_non_negative_numbers_get_minimum_zero_and_no_maximum():
    rows = [[i * 10] for i in range(30)]
    rows[4][0] = -5
    result = _infer(_csv(["time_to_event"], rows))
    col = _col(result, "time_to_event")
    assert col["min"] == 0 and col["max"] is None
    assert [r["row"] for r in result["report"]["rejected"]] == [4]


def test_mostly_negative_column_has_no_minimum():
    result = _infer(_csv(["delta"], [[i - 15] for i in range(30)]))
    assert _col(result, "delta")["min"] is None


# --- 欄名 ---

def test_chinese_names_with_spaces_and_symbols_are_kept():
    header = ["病歷號", " 收縮壓 (mmHg) ", "是否吸菸?", "a,b"]
    text = '病歷號, 收縮壓 (mmHg) ,是否吸菸?,"a,b"\n' + "".join(f"P{i:03d},{110 + i},是,x\n" for i in range(5))
    result = _infer(text)
    assert [c["name"] for c in result["schema"]["columns"]] == [h.strip() for h in header]
    assert result["report"]["valid_rows"] == 5


def test_blank_and_duplicate_header_names_are_explained():
    with pytest.raises(TabularError, match="第 2 欄沒有欄名") as err:
        _infer("a,,c\n1,2,3\n")
    assert err.value.code == "blank_column_name"
    with pytest.raises(TabularError, match="欄名重複：a") as err:
        _infer("a,b,a\n1,2,3\n")
    assert err.value.code == "duplicate_columns"


def test_empty_and_header_only_files():
    with pytest.raises(TabularError, match="空的"):
        _infer("")
    with pytest.raises(TabularError, match="只有標題列"):
        _infer("a,b\n")


def test_big5_file_is_inferred_with_warning():
    raw = "姓名,年齡\n王,60\n李,61\n".encode("cp950")
    result = infer_schema(io.BytesIO(raw))
    assert result["encoding"] == "cp950" and [c["name"] for c in result["schema"]["columns"]] == ["姓名", "年齡"]
    assert any(w["code"] == "big5_encoding" for w in result["report"]["warnings"])


def test_result_is_json_and_schema_round_trips():
    result = infer_schema(CSV_PATH)
    json.dumps(result)
    assert Schema.from_dict(result["schema"]).to_dict() == result["schema"]
    assert result["row_count"] == 100 and result["report"]["valid_rows"] == 100


def test_lib_fixture_types_match_hand_written_schema():
    hand = {c["name"]: c["type"] for c in load_schema()["columns"]}
    inferred = {c["name"]: c["type"] for c in infer_schema(CSV_PATH)["schema"]["columns"]}
    # 手寫結構把 diagnosis 寫成 str、outcome/event 寫成 int；推斷結果相同或更嚴（category）
    assert {k: v for k, v in inferred.items() if hand[k] != v} == {"diagnosis": "category"}


# --- TC-B01-10：推斷結構仍然攔截 bad.csv 的錯誤列 ---

def _bad_rows() -> set[int]:
    return {r["row"] for r in json.loads((WEB_FIXTURES / "bad_rows.json").read_text())["rows"]}


def test_bad_csv_inferred_schema_never_lets_a_type_error_through_and_never_rejects_a_good_row():
    result = infer_schema(WEB_FIXTURES / "bad.csv")
    rejected = {r["row"] for r in result["report"]["rejected"]}
    expected = _bad_rows()
    assert rejected <= expected  # 不誤殺正常列
    # 只有 sbp 的 2 格空白需要使用者勾選必填（這份檔案中 sbp 有空白，推斷為選填）
    assert expected - rejected == {7, 25}


def test_bad_csv_inferred_schema_with_required_confirmed_rejects_exactly_the_bad_rows():
    result = infer_schema(WEB_FIXTURES / "bad.csv")
    schema = result["schema"]
    for c in schema["columns"]:
        if c["name"] == "sbp":
            c["required"] = True  # 使用者在欄位表勾選「必填」
    report = validate_csv(WEB_FIXTURES / "bad.csv", Schema.from_dict(schema))
    assert {r["row"] for r in report["rejected"]} == _bad_rows()
    assert report["valid_rows"] == report["total_rows"] - len(_bad_rows())
    assert all(r["reason"] for r in report["rejected"])


def test_valid_cohort_inferred_schema_accepts_every_row():
    result = infer_schema(WEB_FIXTURES / "cohort_01.csv")
    assert result["report"]["valid_rows"] == 100 and result["report"]["rejected"] == []
