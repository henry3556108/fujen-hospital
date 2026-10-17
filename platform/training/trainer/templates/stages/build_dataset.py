"""由自己的 CSV 產生訓練用的資料夾（結構式）：依 schema.json 驗證，寫出 manifest.json 與 blobs/<sha256>。

    python tools/build_dataset.py --csv 我的資料.csv --schema stages/import/schema.json --out dataset

格式與平台凍結的資料相同，產生後以 python run_all.py --data dataset --out out 訓練。
不合格的列（型別、必填、範圍、允許值不符）不會放進資料夾，數量會印出來。
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lib"))

from tabular.schema import Schema  # noqa: E402
from tabular.validate import validate_and_load  # noqa: E402


def canonical(data) -> bytes:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="由 CSV 產生訓練資料夾")
    parser.add_argument("--csv", required=True)
    parser.add_argument("--schema", default=str(ROOT / "stages" / "import" / "schema.json"))
    parser.add_argument("--out", default="dataset")
    parser.add_argument("--kind", default=None, help="訓練種類；省略時讀 config.json")
    args = parser.parse_args(argv)
    schema_dict = json.loads(Path(args.schema).read_text(encoding="utf-8"))
    report, frame = validate_and_load(io.BytesIO(Path(args.csv).read_bytes()), Schema.from_dict(schema_dict))
    if report["errors"]:
        print("CSV 無法使用：" + report["errors"][0]["message"], file=sys.stderr)
        return 1
    print(f"合格 {report['valid_rows']} 列，不合格 {report['rejected_row_count']} 列")
    kind = args.kind or json.loads((ROOT / "config.json").read_text(encoding="utf-8"))["kind"]
    out = Path(args.out)
    (out / "blobs").mkdir(parents=True, exist_ok=True)

    def blob(data: bytes, fmt: str) -> dict:
        digest = hashlib.sha256(data).hexdigest()
        (out / "blobs" / digest).write_bytes(data)
        return {"blob": digest, "format": fmt, "size": len(data)}

    files = {"csv": blob(frame.to_csv(index=False, lineterminator="\n").encode("utf-8"), "csv"),
             "schema": blob(canonical(schema_dict), "json")}
    body = {"version": 1, "kind": kind, "label_names": [], "rows": int(report["valid_rows"]),
            "items": [{"id": "item-0001", "group": "group-001", "files": files}]}
    manifest = {**body, "content_hash": hashlib.sha256(canonical(body)).hexdigest()}
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=True),
                                       encoding="utf-8")
    print(f"已寫出 {out / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
