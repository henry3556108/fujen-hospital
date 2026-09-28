import pytest

from app.imaging.dicom import InvalidDicom, parse_dicom
from imaging_support import accession, make_dicom, series_uid, sop_uid, study_uid


def test_parse_extracts_index_fields():
    info = parse_dicom(make_dicom(2, 3))
    assert info.sop_instance_uid == sop_uid(2, 3)
    assert info.study_instance_uid == study_uid(2)
    assert info.series_instance_uid == series_uid(2)
    assert info.accession_number == accession(2)
    assert (info.modality, info.patient_sex, info.study_date) == ("MR", "M", "20240220")
    assert info.study_description == "MR BRAIN WWO CONTRAST"
    assert info.series_description == "AX T1"
    assert info.patient_id == "PAT0002"


@pytest.mark.parametrize("cut", [0.5, 0.9])
def test_tc_b01_05_truncated_dicom_rejected(cut):
    data = make_dicom(1)
    with pytest.raises(InvalidDicom, match="截斷|不完整"):
        parse_dicom(data[: int(len(data) * cut)])


def test_tc_b01_05_truncated_in_header_rejected():
    with pytest.raises(InvalidDicom):
        parse_dicom(make_dicom(1)[:200])


@pytest.mark.parametrize("data", [b"", b"hello, not a dicom file", b"\x00" * 64])
def test_tc_b01_05_not_dicom_rejected(data):
    with pytest.raises(InvalidDicom, match="不是 DICOM"):
        parse_dicom(data)
