"""資料凍結：把訓練要用的資料複製成內容定址的 blob，寫一份 manifest。

- blob      projects/{pid}/training/blobs/{sha256}，寫入後不再修改或刪除
- manifest  projects/{pid}/training/datasets/{content_hash}/manifest.json
- content_hash 由 manifest 內容（項目、blob 雜湊、標註）算出：內容相同就是同一個版本

訓練只讀 manifest 指到的 blob，所以來源之後被刪除、被新增都不影響已送出的訓練。
"""
from __future__ import annotations

import hashlib
import json
from datetime import timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.imaging.dicom import InvalidDicom, parse_dicom
from app.imaging.models import ImagingFile, ImagingInstance, ImagingSeries, ImagingStudy
from app.imaging.orthanc import OrthancClient, OrthancError
from app.imaging.service import list_studies
from app.storage import ObjectNotFound, ObjectStore
from app.tabular_api.models import TabularDataset
from app.training import labels as label_sources
from app.training.config import ConfigError
from app.training.models import DatasetVersion

MANIFEST_VERSION = 1


class SnapshotError(Exception):
    status_code = 409


def blob_key(project_id: int, digest: str) -> str:
    return f"projects/{project_id}/training/blobs/{digest}"


def manifest_key(project_id: int, content_hash: str) -> str:
    return f"projects/{project_id}/training/datasets/{content_hash}/manifest.json"


def canonical(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


class _Blobs:
    def __init__(self, store: ObjectStore, project_id: int):
        self.store, self.project_id, self.total = store, project_id, 0

    def put(self, data: bytes, fmt: str) -> dict[str, Any]:
        digest = hashlib.sha256(data).hexdigest()
        key = blob_key(self.project_id, digest)
        if not self.store.exists(key):
            self.store.put(key, data)
        self.total += len(data)
        return {"blob": digest, "format": fmt, "size": len(data)}


def _tabular(session: Session, store: ObjectStore, project_id: int, source: dict, blobs: _Blobs):
    ds = session.get(TabularDataset, source["dataset_id"])
    if ds is None or ds.project_id != project_id:
        raise ConfigError(f"找不到結構式資料集 {source['dataset_id']}")
    try:
        csv = store.get(ds.object_key)
    except ObjectNotFound:
        raise SnapshotError(f"資料集「{ds.name}」的檔案已不存在，無法凍結") from None
    files = {"csv": blobs.put(csv, "csv"), "schema": blobs.put(canonical(ds.schema), "json")}
    items = [{"id": f"tabular_dataset:{ds.id}", "group": ds.name, "files": files}]
    return items, [], {"rows": ds.valid_rows, "dataset": ds.name, "columns": [c["name"] for c in ds.schema["columns"]]}


def _files(session: Session, store: ObjectStore, project_id: int, source: dict, blobs: _Blobs):
    images = session.scalars(select(ImagingFile).where(
        ImagingFile.project_id == project_id, ImagingFile.format == source["format"],
        ImagingFile.role == "image").order_by(ImagingFile.case, ImagingFile.id)).all()
    masks = {m.paired_file_id: m for m in session.scalars(select(ImagingFile).where(
        ImagingFile.project_id == project_id, ImagingFile.format == source["format"],
        ImagingFile.role == "label", ImagingFile.pairing == "paired"))}
    by_case = {i.case: i for i in images if i.id in masks}
    if source["cases"] != "all":
        missing = [c for c in source["cases"] if c not in by_case]
        if missing:
            raise ConfigError(f"找不到已配對標註的病例：{'、'.join(missing)}")
        by_case = {c: by_case[c] for c in source["cases"]}
    items = []
    for case in sorted(by_case):
        image, mask = by_case[case], masks[by_case[case].id]
        try:
            files = {"image": blobs.put(store.get(image.object_key), source["format"]),
                     "mask": blobs.put(store.get(mask.object_key), source["format"])}
        except ObjectNotFound:
            raise SnapshotError(f"病例「{case}」的檔案已不存在，無法凍結") from None
        items.append({"id": case, "group": case, "files": files})
    return items, [], {"cases": len(items), "unpaired_images": len(images) - len([i for i in images if i.id in masks])}


def _dicom(session: Session, store: ObjectStore, orthanc: OrthancClient | None, state, project_id: int,
           source: dict, kind: str, wanted_labels: list[str] | None, blobs: _Blobs):
    if orthanc is None:
        raise SnapshotError("影像節點尚未設定，無法凍結影像")
    studies = {s.study_instance_uid: s for s in list_studies(session, project_id)}   # 已套用 Accession 清單
    if source["studies"] != "all":
        missing = [u for u in source["studies"] if u not in studies]
        if missing:
            raise ConfigError(f"研究不在本專案或不在 Accession 清單內：{'、'.join(missing)}")
        studies = {u: studies[u] for u in source["studies"]}
    rows = session.execute(
        select(ImagingInstance.sop_instance_uid, ImagingInstance.source_path, ImagingStudy.study_instance_uid,
               ImagingStudy.accession_number)
        .join(ImagingSeries, ImagingInstance.series_id == ImagingSeries.id)
        .join(ImagingStudy, ImagingSeries.study_id == ImagingStudy.id)
        .where(ImagingInstance.project_id == project_id, ImagingStudy.study_instance_uid.in_(list(studies)))).all()
    refs = [label_sources.InstanceRef(sop_instance_uid=r[0], source_path=r[1], study_instance_uid=r[2],
                                      accession_number=r[3]) for r in rows]
    options = source["label_source"]
    provider = label_sources.get_provider(state, options["provider"])
    found, names = provider.labels(session, store, project_id, refs, options)
    names = wanted_labels or names

    by_sop = {r.sop_instance_uid: r for r in refs}
    items, skipped = [], {"unlabelled": 0, "label_not_selected": 0}
    for study_uid in sorted(studies):
        try:
            files = orthanc.study_instances(study_uid)
        except OrthancError as exc:
            raise SnapshotError(f"無法從影像節點取得研究 {study_uid}：{exc}") from exc
        for data in files:
            try:
                sop = parse_dicom(data).sop_instance_uid
            except InvalidDicom:
                continue
            if sop not in by_sop:
                continue                       # 影像節點上有、但不屬於本專案索引的影像
            labels = found.get(sop)
            if labels is None:
                skipped["unlabelled"] += 1
                continue
            item: dict[str, Any] = {"id": sop, "group": study_uid, "files": {"image": blobs.put(data, "dicom")}}
            if kind == "image_classification":
                if labels.label is None or labels.label not in names:
                    skipped["label_not_selected"] += 1
                    continue
                item["label"] = labels.label
            elif kind == "image_detection":
                boxes = [b for b in labels.boxes if b["label"] in names]
                if not boxes:
                    skipped["label_not_selected"] += 1
                    continue
                item["boxes"] = boxes
            else:
                if labels.mask is None:
                    skipped["unlabelled"] += 1
                    continue
                item["files"]["mask"] = blobs.put(labels.mask[0], labels.mask[1])
            items.append(item)
    items.sort(key=lambda i: (i["group"], i["id"]))
    return items, names, {"studies": len({i["group"] for i in items}), "skipped": skipped}


def freeze(session: Session, store: ObjectStore, *, orthanc: OrthancClient | None, state, project_id: int,
           setting: dict[str, Any], actor: str) -> tuple[DatasetVersion, dict[str, Any]]:
    """依訓練設定凍結資料。回傳（資料版本, manifest）。尚未 commit。"""
    kind, source = setting["kind"], setting["source"]
    blobs = _Blobs(store, project_id)
    if source["type"] == "tabular":
        items, names, summary = _tabular(session, store, project_id, source, blobs)
    elif source["type"] == "files":
        items, names, summary = _files(session, store, project_id, source, blobs)
        names = list(setting["image"]["labels"] or [])
    else:
        items, names, summary = _dicom(session, store, orthanc, state, project_id, source, kind,
                                       setting["image"]["labels"], blobs)
    if not items:
        raise SnapshotError("沒有可用於訓練的資料（請確認影像已匯入且已標註，或資料集仍存在）")

    body = {"version": MANIFEST_VERSION, "kind": kind, "label_names": names, "items": items}
    if "rows" in summary:
        body["rows"] = summary["rows"]
    content_hash = hashlib.sha256(canonical(body)).hexdigest()
    manifest = {**body, "content_hash": content_hash}

    version = session.scalar(select(DatasetVersion).where(DatasetVersion.project_id == project_id,
                                                          DatasetVersion.content_hash == content_hash))
    if version is None:
        key = manifest_key(project_id, content_hash)
        store.put(key, json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=1).encode("utf-8"))
        version = DatasetVersion(project_id=project_id, kind=kind, content_hash=content_hash, manifest_key=key,
                                 item_count=len(items), source=source,
                                 summary={**summary, "bytes": blobs.total, "label_names": names}, created_by=actor)
        session.add(version)
        session.flush()
    return version, manifest


def load_manifest(store: ObjectStore, version: DatasetVersion) -> dict[str, Any]:
    return json.loads(store.get(version.manifest_key))


def version_out(version: DatasetVersion) -> dict[str, Any]:
    return {"id": version.id, "project_id": version.project_id, "kind": version.kind,
            "content_hash": version.content_hash, "item_count": version.item_count, "source": version.source,
            "summary": version.summary, "created_by": version.created_by,
            "created_at": (version.created_at if version.created_at.tzinfo
                           else version.created_at.replace(tzinfo=timezone.utc)).isoformat()}
