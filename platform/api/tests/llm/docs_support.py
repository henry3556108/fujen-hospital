"""測試用文件：platform/tools/synth 的 6 種格式各 1 份。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools" / "synth"))
from synth import documents as synth_documents  # noqa: E402

FILES = synth_documents.build()
FILENAMES = synth_documents.FILENAMES      # 格式 → 檔名
UNIQUE = synth_documents.UNIQUE            # 格式 → 只出現在這份文件的字句
