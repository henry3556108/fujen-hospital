"""端對端檢查：以平台自己的用戶端（app.labeling.autolabel.HttpAutolabel）與格式驗證（formats）呼叫轉接服務。

兩個步驟：
  call  在平台 api 容器內執行（用 AUTOLABEL_URL，與平台完全相同的呼叫方式）：/info/ 一次、指定的切面各推論一次，
        每次驗證格式（validate_info、to_payload），記錄耗時；結果寫到 --out 資料夾（info.json、infer_<n>.json）。
          docker compose exec -T api /app/.venv/bin/python - call --out /tmp/recorded --model segmentation_spleen \\
            --images <SOP UID>... < platform/autolabel/scripts/e2e_check.py
  dice  在主機執行（需要 nibabel，用 adapter 的環境）：把錄製的遮罩與 MSD 標準答案比對（Dice），確認位置沒有翻轉或錯位。
          cd platform/autolabel/adapter && uv run python ../scripts/e2e_check.py dice --recorded <資料夾> --data <ct-spleen>
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path


def call(args) -> int:
    from app.labeling import formats
    from app.labeling.autolabel import autolabel_from_env

    client = autolabel_from_env(os.environ)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    info = client.info()
    models = formats.validate_info(info)
    (out / "info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"/info/ {time.monotonic() - started:.2f}s 模型：{', '.join(models)}")
    failures = 0
    for n, image in enumerate(args.images, start=1):
        started = time.monotonic()
        try:
            body = client.infer(args.model, image)
            payload = formats.to_payload(models[args.model]["type"], body, model=args.model, image=image)
        except Exception as exc:                 # 記錄失敗，繼續下一張
            failures += 1
            print(f"#{n} {image} 失敗：{type(exc).__name__} {exc}")
            continue
        elapsed = time.monotonic() - started
        fg = sum(run for value, run in payload["rle"] if value != 0)
        print(f"#{n} {image} {elapsed:.2f}s shape={payload['shape']} 前景像素={fg}")
        record = {"model": args.model, "image": image, "seconds": round(elapsed, 3), "response": body}
        (out / f"infer_{n}.json").write_text(json.dumps(record, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"成功 {len(args.images) - failures}／{len(args.images)}")
    return 1 if failures else 0


def dice(args) -> int:
    import numpy as np

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from msd_to_dicom import to_lps

    data = Path(args.data)
    manifest = json.loads((data / "manifest.json").read_text(encoding="utf-8"))
    where = {}
    for study in manifest["studies"]:
        for i in study["instances"]:
            where[i["sop_instance_uid"]] = (study, i["instance_number"] - 1)
    scores = []
    for path in sorted(Path(args.recorded).glob("infer_*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        body = record["response"]
        study, k = where[record["image"]]
        truth, _ = to_lps(data / study["label_file"])
        truth = truth[:, :, k].T > 0                                   # [列, 行]，與 DICOM 像素相同方向
        flat = np.concatenate([np.full(run, value, dtype=np.uint8) for value, run in body["rle"]])
        spleen = body["label_names"].get("spleen")
        pred = (flat.reshape(body["shape"]) == spleen)
        score = 2 * (pred & truth).sum() / max(1, pred.sum() + truth.sum())
        scores.append(score)
        print(f"{path.name} 切面 {k + 1}：預測 {int(pred.sum())}、答案 {int(truth.sum())} 像素，Dice {score:.3f}")
    print(f"平均 Dice {np.mean(scores):.3f}")
    return 0 if scores and min(scores) > args.min_dice else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("call")
    c.add_argument("--out", required=True)
    c.add_argument("--model", required=True)
    c.add_argument("--images", nargs="+", required=True)
    d = sub.add_parser("dice")
    d.add_argument("--recorded", required=True)
    d.add_argument("--data", required=True)
    d.add_argument("--min-dice", type=float, default=0.5)
    args = parser.parse_args()
    return call(args) if args.cmd == "call" else dice(args)


if __name__ == "__main__":
    sys.exit(main())
