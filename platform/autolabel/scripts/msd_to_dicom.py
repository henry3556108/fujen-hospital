"""把 Medical Segmentation Decathlon Task09_Spleen 的 CT（NIfTI）轉成未壓縮的 DICOM 序列，供 B-03 自動標註驗證。

資料來源：http://medicaldecathlon.com/（MONAI 鏡像 https://msd-for-monai.s3-us-west-2.amazonaws.com/Task09_Spleen.tar），
授權 CC-BY-SA 4.0。輸出只放在 repo 外（例如 sample-data/M2/ct-spleen），不進版控。

  cd platform/autolabel/adapter
  uv run python ../scripts/msd_to_dicom.py --msd ~/monai-data/raw/Task09_Spleen --cases 2,3 \
      --out /mnt/c/Users/skyland/Desktop/workspace/sample-data/M2/ct-spleen

每個病例一個研究、一個序列（軸切面，CT Image Storage，Explicit VR Little Endian，MONOCHROME2，16 位元）：
- 影像方向固定為 [1,0,0,0,1,0]（行往病人左、列往病人後），切面沿 +Z（往頭側），InstanceNumber 由腳側起算。
- 偶數病例存 unsigned（PixelRepresentation 0，RescaleIntercept −1024），奇數病例存 signed（PixelRepresentation 1，
  RescaleIntercept 0），兩種常見的 CT 像素格式都涵蓋到（標註工作台的解碼都要能處理）。
- UID 由病例編號決定（同一份輸入產出相同 UID），根為 synth 的測試根 1.2.826.0.1.3680043.10.9999.。
- 同時輸出 MSD 的標準答案（脾臟遮罩）為 labels/spleen_<n>_label.nii.gz 與 manifest.json（每張切面的 SOP UID 與脾臟像素數），
  端對端驗證以它比對推論結果的位置（Dice），確認座標轉換沒有翻轉或錯位。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import nibabel as nib
import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian

UID_ROOT = "1.2.826.0.1.3680043.10.9999."
CT_IMAGE_STORAGE = "1.2.840.10008.5.1.4.1.1.2"
STUDY, SERIES, INSTANCE, FRAME = 11, 12, 13, 14       # 與 synth（1–4）不重疊
SOURCE = "Medical Segmentation Decathlon Task09_Spleen（CC-BY-SA 4.0）"


README = """# CT 腹部測試資料（MSD Spleen → DICOM）

B-03 自動標註（MONAI Label 脾臟分割）的驗證資料。由 `platform/autolabel/scripts/msd_to_dicom.py` 產生，請勿手動修改。

- 來源：Medical Segmentation Decathlon Task09_Spleen（http://medicaldecathlon.com/），
  下載位址 https://msd-for-monai.s3-us-west-2.amazonaws.com/Task09_Spleen.tar
- 授權：**CC-BY-SA 4.0**（https://creativecommons.org/licenses/by-sa/4.0/）。轉檔後的 DICOM 同樣以 CC-BY-SA 4.0 提供；
  引用：Antonelli et al., "The Medical Segmentation Decathlon", Nature Communications 13, 4128 (2022)。
- 病人資料全部是假的（PatientID `MSD-SPLEEN-<n>`），原始資料本身已去識別化。

| 病例 | 資料夾 | 切面數 | 大小 | 切面厚度 | 像素格式 | StudyInstanceUID |
|---|---|---|---|---|---|---|
{rows}

- `labels/`：MSD 的標準答案（脾臟遮罩，NIfTI），端對端驗證用來比對推論結果的位置（Dice）。不要匯入平台。
- `manifest.json`：每張切面的 SOP Instance UID、該切面標準答案的脾臟像素數、所有檔案的 SHA-256。

匯入平台：

```bash
cd platform/tools/importer
uv run python -m importer upload --project <專案> --exclude 'labels/*' --exclude manifest.json --exclude README.md <這個資料夾>
```
"""


def uid(kind: int, case: int, n: int = 0) -> str:
    return f"{UID_ROOT}{kind}.{case}.{n}"


def to_lps(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """NIfTI → (資料[i, j, k], LPS affine)，軸重排為 i 往病人左、j 往病人後、k 往頭側。"""
    image = nib.as_closest_canonical(nib.load(str(path)))      # RAS+
    data = np.asanyarray(image.dataobj)
    ras = image.affine.copy()
    nx, ny, _ = data.shape
    flip = np.array([[-1, 0, 0, nx - 1], [0, -1, 0, ny - 1], [0, 0, 1, 0], [0, 0, 0, 1]], dtype=float)
    data = data[::-1, ::-1, :]
    lps = np.diag([-1.0, -1.0, 1.0, 1.0]) @ ras @ flip
    return np.ascontiguousarray(data), lps


def _ds(case: int, k: int, n_slices: int, lps: np.ndarray, pixels: np.ndarray, signed: bool) -> Dataset:
    sop_uid = uid(INSTANCE, case, k + 1)
    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = CT_IMAGE_STORAGE
    fm.MediaStorageSOPInstanceUID = sop_uid
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    fm.ImplementationClassUID = UID_ROOT + "0.2"
    fm.ImplementationVersionName = "MSD2DICOM_1_0"

    spacing_col = float(np.linalg.norm(lps[:3, 0]))     # 行與行的距離
    spacing_row = float(np.linalg.norm(lps[:3, 1]))     # 列與列的距離
    thickness = float(np.linalg.norm(lps[:3, 2]))
    position = lps @ np.array([0.0, 0.0, float(k), 1.0])

    ds = Dataset()
    ds.file_meta = fm
    ds.SpecificCharacterSet = "ISO_IR 100"
    ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
    ds.SOPClassUID = CT_IMAGE_STORAGE
    ds.SOPInstanceUID = sop_uid
    ds.StudyDate = ds.SeriesDate = ds.ContentDate = "20180806"
    ds.StudyTime = ds.SeriesTime = ds.ContentTime = "090000"
    ds.AccessionNumber = f"MSDSPL{case:04d}"
    ds.Modality = "CT"
    ds.Manufacturer = "MSD2DICOM"
    ds.InstitutionName = "MEDICAL SEGMENTATION DECATHLON"
    ds.ReferringPhysicianName = ""
    ds.StudyDescription = "CT ABDOMEN (MSD Spleen)"
    ds.SeriesDescription = f"AXIAL {thickness:g}MM (MSD Task09 spleen_{case})"
    ds.PatientName = f"MSD^SPLEEN{case:03d}"
    ds.PatientID = f"MSD-SPLEEN-{case:03d}"
    ds.PatientBirthDate = ""
    ds.PatientSex = "O"
    ds.BodyPartExamined = "ABDOMEN"
    ds.KVP = "120"
    ds.SliceThickness = f"{thickness:g}"
    ds.StudyInstanceUID = uid(STUDY, case)
    ds.SeriesInstanceUID = uid(SERIES, case)
    ds.FrameOfReferenceUID = uid(FRAME, case)
    ds.PositionReferenceIndicator = ""
    ds.StudyID = str(case)
    ds.SeriesNumber = 1
    ds.InstanceNumber = k + 1
    ds.ImagePositionPatient = [f"{v:.6g}" for v in position[:3]]
    row_dir = lps[:3, 0] / spacing_col
    col_dir = lps[:3, 1] / spacing_row
    ds.ImageOrientationPatient = [f"{v:.6g}" for v in (*row_dir, *col_dir)]
    ds.SliceLocation = f"{position[2]:.6g}"
    ds.PixelSpacing = [f"{spacing_row:.6g}", f"{spacing_col:.6g}"]
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.Rows, ds.Columns = pixels.shape
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.WindowCenter = "40"
    ds.WindowWidth = "400"
    ds.RescaleType = "HU"
    ds.RescaleSlope = "1"
    if signed:
        ds.PixelRepresentation = 1
        ds.RescaleIntercept = "0"
        stored = pixels.astype(np.int16)
    else:
        ds.PixelRepresentation = 0
        ds.RescaleIntercept = "-1024"
        stored = np.clip(pixels + 1024, 0, 65535).astype(np.uint16)
    ds.PixelData = np.ascontiguousarray(stored).astype(stored.dtype.newbyteorder("<")).tobytes()
    return ds


def convert(msd: Path, case: int, out: Path) -> dict:
    data, lps = to_lps(msd / "imagesTr" / f"spleen_{case}.nii.gz")
    label, label_lps = to_lps(msd / "labelsTr" / f"spleen_{case}.nii.gz")
    if label.shape != data.shape or not np.allclose(label_lps, lps, atol=1e-3):
        raise SystemExit(f"spleen_{case} 的影像與標準答案大小或座標不同")
    hu = np.rint(data).astype(np.int32)
    signed = case % 2 == 1
    series_dir = out / "dicom" / f"spleen_{case:03d}"
    series_dir.mkdir(parents=True, exist_ok=True)
    slices = []
    for k in range(data.shape[2]):
        pixels = hu[:, :, k].T                                    # [列, 行]
        ds = _ds(case, k, data.shape[2], lps, pixels, signed)
        name = f"IM{k + 1:04d}.dcm"
        ds.save_as(series_dir / name, enforce_file_format=True)
        slices.append({"file": f"dicom/spleen_{case:03d}/{name}", "sop_instance_uid": ds.SOPInstanceUID,
                       "instance_number": k + 1, "spleen_pixels": int((label[:, :, k] > 0).sum())})
    labels_dir = out / "labels"
    labels_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(msd / "labelsTr" / f"spleen_{case}.nii.gz", labels_dir / f"spleen_{case}_label.nii.gz")
    return {
        "case": f"spleen_{case}",
        "patient_id": f"MSD-SPLEEN-{case:03d}",
        "accession_number": f"MSDSPL{case:04d}",
        "study_instance_uid": uid(STUDY, case),
        "series_instance_uid": uid(SERIES, case),
        "rows": int(data.shape[1]), "columns": int(data.shape[0]), "slices": int(data.shape[2]),
        "pixel_spacing_mm": [round(float(np.linalg.norm(lps[:3, 1])), 6), round(float(np.linalg.norm(lps[:3, 0])), 6)],
        "slice_thickness_mm": round(float(np.linalg.norm(lps[:3, 2])), 6),
        "pixel_representation": "signed" if signed else "unsigned",
        "label_file": f"labels/spleen_{case}_label.nii.gz",
        "instances": slices,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--msd", type=Path, required=True, help="Task09_Spleen 資料夾（含 imagesTr、labelsTr）")
    parser.add_argument("--cases", default="2,3", help="病例編號，逗號分隔（spleen_<n>）")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    cases = [convert(args.msd, int(c), args.out) for c in args.cases.split(",")]
    files = sorted(p for p in args.out.rglob("*") if p.is_file() and p.name not in ("manifest.json", "README.md"))
    digest = hashlib.sha256()
    for p in files:
        digest.update(p.relative_to(args.out).as_posix().encode() + b"\0" + p.read_bytes())
    manifest = {
        "source": SOURCE,
        "source_url": "https://msd-for-monai.s3-us-west-2.amazonaws.com/Task09_Spleen.tar",
        "licence": "CC-BY-SA 4.0（https://creativecommons.org/licenses/by-sa/4.0/）",
        "generator": "platform/autolabel/scripts/msd_to_dicom.py",
        "studies": cases,
        "files": len(files),
        "bytes": sum(p.stat().st_size for p in files),
        "sha256": digest.hexdigest(),
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rows = "\n".join(f"| {c['case']} | `dicom/spleen_{int(c['case'].split('_')[1]):03d}/` | {c['slices']} | "
                     f"{c['columns']}×{c['rows']} | {c['slice_thickness_mm']:g} mm | {c['pixel_representation']} | "
                     f"`{c['study_instance_uid']}` |" for c in cases)
    (args.out / "README.md").write_text(README.format(rows=rows), encoding="utf-8")
    print(f"完成：{len(cases)} 個研究、{len(files)} 個檔案、{manifest['bytes'] / 1e6:.1f} MB → {args.out}")


if __name__ == "__main__":
    main()
