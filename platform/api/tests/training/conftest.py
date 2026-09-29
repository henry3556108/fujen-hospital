import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from conftest_training import *  # noqa: E402,F401,F403  fixtures 與共用函式
