"""S0 smoke：10 個使用情境的主幹（s0/test_scenarios.py）。

情境測試直接 import 平台 API，所以借用 platform/api 的 venv 執行；這裡只負責呼叫並回報結果。
"""
import subprocess
from pathlib import Path

PLATFORM = Path(__file__).resolve().parents[1]


def test_s0_ten_scenarios_backbone():
    result = subprocess.run(
        ["uv", "run", "-q", "--project", str(PLATFORM / "api"), "pytest", str(PLATFORM / "smoke" / "s0"),
         "-q", "-rs", "-p", "no:cacheprovider", "-W", "ignore::DeprecationWarning"],
        cwd=PLATFORM / "api", capture_output=True, text=True)
    print(result.stdout[-4000:])
    assert result.returncode == 0, result.stdout[-6000:] + result.stderr[-2000:]
