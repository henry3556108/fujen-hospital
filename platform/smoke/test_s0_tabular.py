"""S0 smoke：合成資料產生器與平台 CSV 驗證器必須講同一種 schema 格式（TC-B01-10）。

各子專案有自己的 venv，所以用 `uv run --project` 分別執行，驗證的是兩者之間的契約。
"""
import json
import subprocess
from pathlib import Path

PLATFORM = Path(__file__).resolve().parents[1]

VALIDATE = """
import json, sys
from tabular.schema import Schema
from tabular.validate import validate_csv
out = sys.argv[1]
schema = Schema.from_dict(json.load(open(f"{out}/schema.json")))
result = {name: validate_csv(f"{out}/{name}", schema)
          for name in ["cohort_01.csv", "cohort_02.csv", "cohort_03.csv", "bad.csv"]}
print(json.dumps(result, ensure_ascii=False))
"""


def run(project: str, *args: str) -> str:
    return subprocess.run(["uv", "run", "-q", "--project", str(PLATFORM / project), *args],
                          check=True, capture_output=True, text=True, cwd=PLATFORM / project).stdout


def test_s0_synth_csv_passes_platform_validator(tmp_path):
    run("tools/synth", "python", "-m", "synth", "tabular", "--out", str(tmp_path))
    reports = json.loads(run("libs/tabular", "python", "-c", VALIDATE, str(tmp_path)))

    for name in ["cohort_01.csv", "cohort_02.csv", "cohort_03.csv"]:
        assert reports[name]["errors"] == []
        assert reports[name]["valid_rows"] == 100, reports[name]["rejected"][:3]

    expected = sorted(r["row"] for r in json.loads((tmp_path / "bad_rows.json").read_text())["rows"])
    got = sorted({r["row"] for r in reports["bad.csv"]["rejected"]})
    assert got == expected  # 攔截 100%、誤放行 0、也不誤殺好資料
