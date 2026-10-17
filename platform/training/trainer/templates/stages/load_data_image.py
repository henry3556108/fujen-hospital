"""資料匯入環節（影像）：列出資料夾 manifest.json 內的項目。只供地端使用，平台匯入時不讀這個檔。

資料夾格式：manifest.json 加上 blobs/<sha256>（與平台凍結的資料相同）。manifest 的 items 每項有
id、group（同一個研究或病例）、label（分類）、boxes（偵測）、files（image、mask 指到 blobs 內的檔案）。

平台上要改用哪些研究或病例時，修改 import.json 的 source.studies（"all" 或研究 UID 清單）或 source.cases
後匯入「資料匯入」環節。
"""
import json
from pathlib import Path


def list_items(data_dir: str) -> list[dict]:
    manifest = json.loads((Path(data_dir) / "manifest.json").read_text(encoding="utf-8"))
    return manifest["items"]
