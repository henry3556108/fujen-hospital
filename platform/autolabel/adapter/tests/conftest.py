"""共用的合成 DICOM 序列與平台程式路徑（格式驗證直接用平台的 app.labeling.formats，不另抄一份）。"""
import sys
from pathlib import Path

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

PLATFORM = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PLATFORM / "api"))      # app.labeling.formats / payloads 只依賴標準函式庫
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def make_series(n: int = 10, *, rows: int = 6, cols: int = 5, normal_sign: float = 1.0, signed: bool = True,
                tilt: bool = False, study: str = "1.2.3", series: str = "1.2.3.4") -> list[Dataset]:
    """n 張切面；第 k 張（幾何順序）的像素值全為 100+k（HU）。回傳順序故意打亂。"""
    if tilt:
        a = np.deg2rad(20)
        row_dir = np.array([1.0, 0.0, 0.0])
        col_dir = np.array([0.0, np.cos(a), -np.sin(a)])
    else:
        row_dir, col_dir = np.array([1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0])
    normal = np.cross(row_dir, col_dir) * normal_sign
    out = []
    for k in range(n):
        pos = np.array([-100.0, -80.0, 30.0]) + normal * 2.5 * k
        ds = Dataset()
        ds.file_meta = FileMetaDataset()
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
        ds.SOPInstanceUID = generate_uid(entropy_srcs=[series, str(k)])
        ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series
        ds.Modality = "CT"
        ds.Rows, ds.Columns = rows, cols
        ds.ImageOrientationPatient = [*map(float, row_dir), *map(float, col_dir)]
        ds.ImagePositionPatient = [float(v) for v in pos]
        ds.PixelSpacing = [0.8, 0.7]
        ds.SliceThickness = 2.5
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.BitsAllocated = ds.BitsStored = 16
        ds.HighBit = 15
        hu = np.full((rows, cols), 100 + k, dtype=np.int32)
        hu[0, 0] = -1000                       # 每張的左上角是空氣，確認列／行沒有轉置
        if signed:
            ds.PixelRepresentation, ds.RescaleIntercept, ds.RescaleSlope = 1, 0, 1
            ds.PixelData = hu.astype("<i2").tobytes()
        else:
            ds.PixelRepresentation, ds.RescaleIntercept, ds.RescaleSlope = 0, -1024, 1
            ds.PixelData = (hu + 1024).astype("<u2").tobytes()
        out.append(ds)
    rng = np.random.default_rng(7)
    return [out[i] for i in rng.permutation(n)]
