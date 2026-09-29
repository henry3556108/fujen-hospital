"""標註來源。資料凍結時向 LabelProvider 取得每張影像的 Label、方框、遮罩。

內建兩種：
- makesense  匯入的 makesense（COCO）標註：方框與類別；分類 Label 取該影像面積最大的方框的類別。
- inline     訓練設定內直接給「研究、Accession 或 SOP → Label」的對照（分類用）。

其他工作包（例如影像標註平台）可以註冊自己的來源：

    from app.training.labels import providers
    providers(app.state)["annotations"] = MyProvider()
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.imaging.models import ImagingFile
from app.imaging.service import _match_sop
from app.storage import ObjectNotFound, ObjectStore
from app.training.config import ConfigError


@dataclass(frozen=True)
class InstanceRef:
    sop_instance_uid: str
    study_instance_uid: str
    accession_number: str
    source_path: str


@dataclass
class ItemLabels:
    label: str | None = None
    boxes: list[dict[str, Any]] = field(default_factory=list)     # {"label": str, "bbox": [x, y, 寬, 高]}
    mask: tuple[bytes, str] | None = None                         # (檔案內容, 格式)


class LabelProvider(Protocol):
    def labels(self, session: Session, store: ObjectStore, project_id: int, instances: list[InstanceRef],
               options: dict[str, Any]) -> tuple[dict[str, ItemLabels], list[str]]:
        """回傳（SOP Instance UID → 標註, Label 名稱清單）。沒有標註的影像不放進結果。"""


def _largest(boxes: list[dict]) -> str:
    return sorted(boxes, key=lambda b: (-b["bbox"][2] * b["bbox"][3], b["label"], b["bbox"]))[0]["label"]


class MakesenseLabels:
    def labels(self, session, store, project_id, instances, options):
        sources = [(i.source_path, i.sop_instance_uid) for i in instances]
        wanted = {i.sop_instance_uid for i in instances}
        out: dict[str, ItemLabels] = {}
        names: list[str] = []
        files = session.scalars(select(ImagingFile).where(
            ImagingFile.project_id == project_id, ImagingFile.format == "makesense").order_by(ImagingFile.id)).all()
        for file in files:
            try:
                coco = json.loads(store.get(file.object_key))
            except (ObjectNotFound, ValueError):
                continue
            categories = {c["id"]: str(c["name"]) for c in coco.get("categories", [])}
            for name in categories.values():
                if name not in names:
                    names.append(name)
            by_image: dict[Any, list[dict]] = {}
            for a in coco.get("annotations", []):
                if a.get("category_id") in categories and len(a.get("bbox") or []) == 4:
                    by_image.setdefault(a["image_id"], []).append(
                        {"label": categories[a["category_id"]], "bbox": [float(v) for v in a["bbox"]]})
            for image in coco.get("images", []):
                sops = _match_sop(sources, str(image.get("file_name", "")))
                boxes = by_image.get(image.get("id"))
                if len(sops) == 1 and sops[0] in wanted and boxes:
                    item = out.setdefault(sops[0], ItemLabels())
                    item.boxes.extend(boxes)
        for item in out.values():
            item.boxes.sort(key=lambda b: (b["label"], b["bbox"]))
            item.label = _largest(item.boxes)
        return out, names


class InlineLabels:
    def labels(self, session, store, project_id, instances, options):
        key = {"study": "study_instance_uid", "accession": "accession_number", "sop": "sop_instance_uid"}[options["by"]]
        values = options["values"]
        out = {i.sop_instance_uid: ItemLabels(label=values[getattr(i, key)])
               for i in instances if getattr(i, key) in values}
        return out, sorted(set(values.values()))


def providers(state) -> dict[str, LabelProvider]:
    registry = getattr(state, "label_providers", None)
    if registry is None:
        registry = state.label_providers = {"makesense": MakesenseLabels(), "inline": InlineLabels()}
    return registry


def get_provider(state, name: str) -> LabelProvider:
    registry = providers(state)
    if name not in registry:
        raise ConfigError(f"找不到標註來源「{name}」（可用：{'、'.join(registry)}）")
    return registry[name]
