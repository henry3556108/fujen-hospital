"""MONAI Label 轉接服務（B-03）。

平台以自動標註規格 1.0（docs/specs/autolabel-io-format.md）呼叫這個服務：
  GET  /info/                              → 由 MONAI Label 的 /info/ 轉成規格欄位
  POST /infer/{model}?image=<SOP Instance UID>
       → 向平台 DICOM 節點（DICOMweb）找出這張影像所屬的序列、組成 3D 體積、送 MONAI Label 推論，
         取回整個序列的標籤體積（依（模型, 序列）快取），回傳這一張切面的 RLE 遮罩。
"""
__version__ = "1.0.0"
