"""標註環節（影像）：決定訓練要用哪些標註、Label 名稱與順序。

平台預設：manifest 原樣傳回；訓練時只用 labels.json 的 labels 清單內的 Label。
可以修改 build_labels，例如把兩個 Label 合併成一個：

    for item in manifest["items"]:
        if item.get("label") == "肺炎（輕度）":
            item["label"] = "肺炎"
    manifest["label_names"] = sorted({i["label"] for i in manifest["items"] if i.get("label")})

改了 Label 名稱時，labels.json 的 labels 也要一起改，否則改名後的影像不會參與訓練。

限制（訓練時檢查，不符合時訓練失敗）：
  - 只能刪除項目、改名或合併 Label
  - 不能新增影像項目，也不能改動項目的 files
"""


def build_labels(manifest: dict, config: dict) -> dict:
    """manifest：凍結的資料清單（items 每項含 label／boxes／files）；config：{"labels": [...]}。"""
    return manifest
