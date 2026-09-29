import pytest

from app.fhir import hl7v2


def test_parse_adt_a01_to_flat_record(hl7_messages):
    record = hl7v2.to_record(hl7_messages[0])
    assert record["message_control_id"] == "MSG42-0001"
    assert record["message_type"] == "ADT^A01" and record["event"] == "A01"
    assert record["patient_id"] == "SYN-42-0001" and record["assigning_authority"] == "SYNTH"
    assert (record["family"], record["given"]) == ("TSAI", "JACK")
    assert record["birth_date"] == "1965-03-20" and record["sex"] == "M"
    assert record["patient_class"] == "I" and record["visit_number"] == "VN0001"
    assert record["admit_datetime"] == "2024-09-12T11:08:00+08:00"
    assert (record["ward"], record["room"], record["bed"]) == ("W01", "100", "1")
    assert record["city"] == "TAIPEI" and record["country"] == "TW"


def test_all_twenty_synthetic_messages_parse(hl7_messages):
    records = [hl7v2.to_record(m) for m in hl7_messages]
    assert len(records) == 20
    assert len({r["patient_id"] for r in records}) == 20


def test_bytes_and_newline_separators_are_accepted(hl7_messages):
    raw = hl7_messages[0].replace("\r", "\n").encode("ascii")
    assert hl7v2.to_record(raw)["visit_number"] == "VN0001"


def test_tc_c03_13_missing_pid3_rejected_with_reason(invalid_hl7):
    with pytest.raises(hl7v2.Hl7Rejected) as exc:
        hl7v2.to_record(invalid_hl7["adt_a01_missing_pid3.hl7"])
    assert exc.value.control_id == "MSG42-INV1"
    assert any("PID-3" in r for r in exc.value.reasons)


def test_tc_c03_13_bad_sex_code_rejected_with_reason(invalid_hl7):
    with pytest.raises(hl7v2.Hl7Rejected) as exc:
        hl7v2.to_record(invalid_hl7["adt_a01_bad_sex_code.hl7"])
    assert any("PID-8" in r and "Q" in r for r in exc.value.reasons)


@pytest.mark.parametrize("mutate, expected", [
    (lambda m: m.replace("ADT^A01^ADT_A01", "ORU^R01"), "不支援的訊息類型"),
    (lambda m: m.replace("|MSG42-0001|", "||"), "MSH-10"),
    (lambda m: m.replace("|19650320|", "|19651340|"), "PID-7"),
    (lambda m: "\r".join(s for s in m.split("\r") if not s.startswith("PV1")), "缺少 PV1"),
    (lambda m: "\r".join(s for s in m.split("\r") if not s.startswith("PID")), "缺少 PID"),
    (lambda m: m.replace("|IP|VN0001", "|IP|"), "PV1-19"),
    (lambda m: m.replace("PV1|1|I|", "PV1|1|Z|"), "PV1-2"),
    (lambda m: m[4:], "MSH 區段開頭"),
])
def test_tc_c03_13_other_invalid_messages(hl7_messages, mutate, expected):
    with pytest.raises(hl7v2.Hl7Rejected) as exc:
        hl7v2.to_record(mutate(hl7_messages[0]))
    assert any(expected in r for r in exc.value.reasons), exc.value.reasons


def test_all_reasons_are_reported_together(hl7_messages):
    bad = hl7_messages[0].replace("SYN-42-0001^^^SYNTH^MR", "").replace("|M|", "|Q|")
    with pytest.raises(hl7v2.Hl7Rejected) as exc:
        hl7v2.to_record(bad)
    assert len(exc.value.reasons) == 2


def test_split_messages(hl7_messages):
    joined = "\n".join(m.replace("\r", "\n") for m in hl7_messages[:3])
    parts = hl7v2.split_messages(joined)
    assert len(parts) == 3 and all(p.startswith("MSH|") for p in parts)
    assert hl7v2.to_record(parts[2])["message_control_id"] == "MSG42-0003"


def test_parse_ts_variants():
    assert hl7v2.parse_ts("20240105") == ("2024-01-05", False)
    assert hl7v2.parse_ts("202401051032") == ("2024-01-05T10:32:00+08:00", True)
    assert hl7v2.parse_ts("20240105103200+0900") == ("2024-01-05T10:32:00+09:00", True)
    with pytest.raises(ValueError):
        hl7v2.parse_ts("2024-01-05")
