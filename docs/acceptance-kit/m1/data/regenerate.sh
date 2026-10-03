#!/usr/bin/env bash
# 重新產生 M1 驗收示範資料包（全部為合成資料，不含任何真實病人資料）。
# 用法：在 repo 根目錄執行  bash docs/acceptance-kit/m1/data/regenerate.sh
# 同一個 seed 產出的檔案逐位元相同；重跑前會先刪除本資料夾內產生的子資料夾。
set -euo pipefail

SEED=42          # 主資料（DICOM 20 個研究、NIfTI、ITK、makesense、CSV）
PACS_SEED=7      # 放進 PACS 的 2 個研究（UID 與主資料不同）

HERE="$(cd "$(dirname "$0")" && pwd)"
SYNTH="$(cd "$HERE/../../../../platform/tools/synth" && pwd)"
run() { (cd "$SYNTH" && uv run --quiet python -m synth "$@"); }

rm -rf "$HERE"/{dicom,nifti,itk,makesense,tabular,pacs,bad-files,pairing}

# 1. 合成資料產生器
run dicom     --out "$HERE/dicom"     --seed $SEED --studies 20
run nifti     --out "$HERE/nifti"     --seed $SEED --count 3
run itk       --out "$HERE/itk"       --seed $SEED --count 3
run makesense --out "$HERE/makesense" --seed $SEED --count 3
run tabular   --out "$HERE/tabular"   --seed $SEED
run dicom     --out "$HERE/pacs"      --seed $PACS_SEED --studies 2

# 2. Accession 清單（取自 dicom/manifest.json 的 accession_allowlist，一行一筆）
python3 - "$HERE" <<'PY'
import json, sys, pathlib
here = pathlib.Path(sys.argv[1])
m = json.loads((here / "dicom" / "manifest.json").read_text())
(here / "accession_allowlist.txt").write_text("\n".join(m["accession_allowlist"]) + "\n")
PY

# 3. TC-B01-05 壞檔資料夾：2 張正常影像（研究 1 的前 2 張）+ 截斷的 DICOM + 副檔名錯誤 + 不支援的副檔名
mkdir -p "$HERE/bad-files"
cp "$HERE/dicom/study_0001/series_001/IM0001.dcm" "$HERE/bad-files/good_01.dcm"
cp "$HERE/dicom/study_0001/series_001/IM0002.dcm" "$HERE/bad-files/good_02.dcm"
python3 - "$HERE" <<'PY'
import sys, pathlib
here = pathlib.Path(sys.argv[1])
src = (here / "dicom" / "study_0001" / "series_001" / "IM0003.dcm").read_bytes()
(here / "bad-files" / "truncated.dcm").write_bytes(src[: len(src) // 2])          # 截斷一半
(here / "bad-files" / "wrong_ext.dcm").write_bytes(
    (here / "nifti" / "case_001_image.nii.gz").read_bytes())                         # NIfTI 檔被改名成 .dcm
(here / "bad-files" / "notes.txt").write_text("this is not an image\n")              # 不支援的副檔名
PY

# 4. TC-B01-04 同時匯入 makesense 與它對應的 DICOM（研究 1–3）
mkdir -p "$HERE/pairing/makesense_with_dicom"
for i in 0001 0002 0003; do cp -r "$HERE/dicom/study_$i" "$HERE/pairing/makesense_with_dicom/"; done
cp "$HERE"/makesense/makesense_00{1,2,3}.json "$HERE/pairing/makesense_with_dicom/"

# 5. TC-B04-08 全空欄位：cohort_01.csv 加一欄 note，每列都是空白
python3 - "$HERE" <<'PY'
import csv, sys, pathlib
here = pathlib.Path(sys.argv[1])
rows = list(csv.reader((here / "tabular" / "cohort_01.csv").open(newline="")))
with (here / "tabular" / "cohort_01_empty_note.csv").open("w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    for i, r in enumerate(rows):
        w.writerow(r + ["note" if i == 0 else ""])
PY

# 6. TC-B04-06 文件清單：前處理方法 66 種（取自 platform/libs/tabular/README.md 的清單）
python3 - "$HERE" <<'PY'
import csv, re, sys, pathlib
here = pathlib.Path(sys.argv[1])
readme = (here / "../../../../platform/libs/tabular/README.md").resolve().read_text()
block = readme.split("<!-- catalogue:start -->")[1].split("<!-- catalogue:end -->")[0]
rows = [[c.strip().strip("`") for c in line.strip("|").split("|")] for line in block.splitlines()
        if line.startswith("| `")]
with (here / "preprocessing_methods.csv").open("w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(["no", "id", "name", "category", "column_types"])
    for n, r in enumerate(rows, 1):
        w.writerow([n, *r])
PY

echo "完成：$(du -sh "$HERE" | cut -f1)"
