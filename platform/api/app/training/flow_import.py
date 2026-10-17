"""匯入專案包（整個流程）：檢核 → 資料對應 → 建立新的訓練設定（M2 第二階段）。

| 步驟 | 規則 |
|---|---|
| 檢核 | flow.json 的格式版本與各檔 sha256；config.json 正規化；標註、前處理、訓練環節做與單一環節匯入相同的檢查 |
| 結構式資料 | 包內有資料 → 用包內的 schema 驗證後建立新資料集；否則找目標專案內乾淨 CSV sha256 相同的資料集；都沒有 → 使用者選 |
| 影像資料 | 目標專案有內容相同（content_hash）的資料版本 → 沿用它的資料來源；否則使用者選全部研究或指定研究 |
| 專案邊界 | 只對應目標專案內的資料 |
| 鎖定 | 包內是匯入控制的環節，在新設定同樣是匯入控制（部署環節除外：模型不隨專案包匯入） |
| 名稱 | 沿用包內名稱，重名時加「（匯入 2）」 |

API 內不執行包內任何程式；包內 lib/ 只供地端，平台執行時用平台目前的共用模組。
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
from typing import Any

from sqlalchemy import select

from app.audit import AuditCategory, record
from app.deps import ProjectContext
from app.storage import ObjectNotFound
from app.training import bundle, config as cfg, flow_stages, stages
from app.training.models import DatasetVersion, TrainingSetting

PACKAGE_MAX_BYTES = int(os.environ.get("TRAINING_PACKAGE_MAX_BYTES", str(100 * 1024 * 1024)))
BLOB = re.compile(r"^dataset/blobs/[0-9a-f]{64}$")
DEIDENTIFIED_KEY = re.compile(r"^key-\d{4}$")
DEIDENTIFIED_STUDY = re.compile(r"^study-\d{4}$")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_package(data: bytes) -> dict[str, bytes]:
    try:
        return bundle.read_zip(data, "flow.json", max_bytes=PACKAGE_MAX_BYTES, allow=BLOB)
    except bundle.SourceError as exc:
        raise stages.StageInvalid([str(exc)], "專案包不符合平台的格式，未匯入") from None


def _json(files: dict[str, bytes], name: str, errors: list[str]) -> Any:
    if name not in files:
        errors.append(f"缺少 {name}")
        return None
    return stages._parse_json(files[name], name, errors)


def _unique_setting_name(session, project_id: int, base: str) -> str:
    taken = set(session.scalars(select(TrainingSetting.name).where(TrainingSetting.project_id == project_id)))
    if base not in taken:
        return base
    n = 2
    while f"{base}（匯入 {n}）" in taken:
        n += 1
    return f"{base}（匯入 {n}）"


def _stage_files(files: dict[str, bytes], stage: str) -> dict[str, bytes]:
    prefix = f"stages/{stage}/"
    return {name[len(prefix):]: body for name, body in files.items() if name.startswith(prefix)}


def _clean_sha(state, ds) -> str | None:
    try:
        return _sha(state.store.get(ds.object_key))
    except ObjectNotFound:
        return None


# ---------------------------------------------------------------- 資料對應

def _map_tabular(ctx: ProjectContext, state, files: dict[str, bytes], import_json: dict[str, Any] | None,
                 dataset_id: int | None, errors: list[str]) -> dict[str, Any]:
    from tabular.schema import Schema
    from tabular.validate import validate_and_load

    from app.tabular_api.models import TabularDataset

    session, pid = ctx.session, ctx.project.id
    candidates = [{"id": d.id, "name": d.name, "valid_rows": d.valid_rows}
                  for d in session.scalars(select(TabularDataset).where(TabularDataset.project_id == pid)
                                           .order_by(TabularDataset.id))]
    manifest = None
    if "dataset/manifest.json" in files:
        manifest = stages._parse_json(files["dataset/manifest.json"], "dataset/manifest.json", errors)
    item = (manifest or {}).get("items", [{}])[0] if isinstance(manifest, dict) and manifest.get("items") else {}
    csv_ref, schema_ref = (item.get("files") or {}).get("csv"), (item.get("files") or {}).get("schema")
    if csv_ref and f"dataset/blobs/{csv_ref.get('blob')}" in files:
        raw = files[f"dataset/blobs/{csv_ref['blob']}"]
        schema_blob = files.get(f"dataset/blobs/{(schema_ref or {}).get('blob')}")
        if schema_blob is None:
            errors.append("專案包附的資料缺少欄位結構（schema）")
            return {"mode": "package", "candidates": candidates}
        try:
            schema = Schema.from_dict(json.loads(schema_blob))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"專案包附的資料欄位結構不正確：{exc}")
            return {"mode": "package", "candidates": candidates}
        report, frame = validate_and_load(io.BytesIO(raw), schema)
        if report["errors"] or not report.get("valid_rows"):
            errors.append("專案包附的資料沒有任何一列通過欄位結構驗證")
        return {"mode": "package", "raw": raw, "schema": schema.to_dict(), "frame": frame,
                "rows": report.get("valid_rows"), "candidates": candidates}
    wanted = ((import_json or {}).get("dataset") or {}).get("csv_sha256")
    if dataset_id is None and wanted:
        for d in session.scalars(select(TabularDataset).where(TabularDataset.project_id == pid)):
            if _clean_sha(state, d) == wanted:
                return {"mode": "matched", "dataset_id": d.id, "dataset_name": d.name, "candidates": candidates}
    if dataset_id is not None:
        ds = session.get(TabularDataset, dataset_id)
        if ds is None or ds.project_id != pid:
            errors.append(f"本專案沒有結構式資料集 {dataset_id}")
            return {"mode": "choose", "candidates": candidates}
        return {"mode": "chosen", "dataset_id": ds.id, "dataset_name": ds.name, "candidates": candidates}
    return {"mode": "choose", "candidates": candidates}


def _map_image(ctx: ProjectContext, files: dict[str, bytes], source: dict[str, Any], studies: Any,
               errors: list[str]) -> dict[str, Any]:
    from app.imaging.service import list_studies

    session, pid = ctx.session, ctx.project.id
    version_meta = None
    if "dataset/version.json" in files:
        version_meta = stages._parse_json(files["dataset/version.json"], "dataset/version.json", errors)
    content_hash = (version_meta or {}).get("content_hash") if isinstance(version_meta, dict) else None
    if content_hash and studies is None:
        version = session.scalar(select(DatasetVersion).where(DatasetVersion.project_id == pid,
                                                              DatasetVersion.content_hash == content_hash))
        if version is not None and version.source.get("type") == source["type"]:
            return {"mode": "version", "version_id": version.id, "source": dict(version.source)}
    if source["type"] == "files":
        cases = studies if studies is not None else "all"
        if cases != "all" and not (isinstance(cases, list) and all(isinstance(c, str) for c in cases)):
            errors.append("病例必須是 all 或病例名稱清單")
        return {"mode": "studies", "source": {"type": "files", "format": source["format"], "cases": cases}}
    if studies is None:
        return {"mode": "choose", "studies_available": len(list_studies(session, pid))}
    if studies != "all":
        if not isinstance(studies, list) or not all(isinstance(s, str) for s in studies) or not studies:
            errors.append("請選擇「全部研究」或至少一個研究")
            return {"mode": "choose"}
        known = {s.study_instance_uid for s in list_studies(session, pid)}
        missing = [s for s in studies if s not in known]
        if missing:
            errors.append(f"研究不在本專案或不在 Accession 清單內：{'、'.join(missing[:10])}")
    return {"mode": "studies", "source": {"type": "dicom", "studies": studies,
                                          "label_source": source.get("label_source")}}


# ---------------------------------------------------------------- 檢核

def check_package(ctx: ProjectContext, state, data: bytes, *, dataset_id: int | None = None,
                  studies: Any = None) -> dict[str, Any]:
    """回傳匯入計畫：errors（全部列出）、ready（資料已對應好）、name、kind、locked、mapping、warnings、config。"""
    files = read_package(data)
    errors: list[str] = []
    warnings: list[str] = []
    meta = _json(files, "flow.json", errors)
    if errors:
        raise stages.StageInvalid(errors + ["這不是平台匯出的專案包"], "專案包不符合平台的格式，未匯入")
    if not isinstance(meta, dict):
        raise stages.StageInvalid(["flow.json 必須是 JSON 物件"], "專案包不符合平台的格式，未匯入")
    version = meta.get("format_version")
    if version != stages.FORMAT_VERSION:
        hint = f"，請用 {version} 版以上的平台匯入" if isinstance(version, int) and version > stages.FORMAT_VERSION else ""
        raise stages.StageInvalid([f"不支援的專案包格式版本 {version}（平台支援 {stages.FORMAT_VERSION}）{hint}"],
                                  "專案包不符合平台的格式，未匯入")
    listed = meta.get("files") if isinstance(meta.get("files"), dict) else {}
    for name, digest in sorted(listed.items()):
        if name not in files:
            errors.append(f"專案包缺少 {name}（flow.json 有列出）")
        elif _sha(files[name]) != digest:
            errors.append(f"{name} 的內容與 flow.json 記錄的 sha256 不同；修改環節檔後請用「上傳環節檔」單獨匯入，"
                          "或刪掉 flow.json 的 files 內這一行")
    kind = meta.get("kind")
    if kind not in cfg.KIND_NAMES:
        errors.append(f"不支援的訓練種類「{kind}」")
        raise stages.StageInvalid(errors, "專案包不符合平台的格式，未匯入")
    if meta.get("platform_version") and meta["platform_version"] != stages.PLATFORM_VERSION:
        warnings.append(f"專案包由平台 {meta['platform_version']} 匯出，目前平台是 {stages.PLATFORM_VERSION}")
    image = kind in cfg.IMAGE_KINDS
    root = bundle.templates_dir()
    changed_lib = [name for name in bundle.HELPERS[image]
                   if f"lib/{name}" in files and files[f"lib/{name}"] != (root / name).read_bytes()]
    if changed_lib:
        warnings.append(f"共用模組版本不同（{'、'.join(changed_lib)}），自訂程式若呼叫了已變更的函式可能失敗；"
                        "平台執行時一律用平台目前的共用模組")

    config = _json(files, "config.json", errors)
    if isinstance(config, dict) and config.get("kind") != kind:
        errors.append("config.json 的訓練種類與 flow.json 不同")
    locked = [s for s in (meta.get("locked") or []) if s in flow_stages.CONFIG_STAGES + stages.STAGES]
    if "deploy" in locked:
        warnings.append("部署環節沒有匯入：模型不隨專案包匯入，請在平台訓練完成後再匯入 deploy.json")
    name = _unique_setting_name(ctx.session, ctx.project.id,
                                str((meta.get("setting") or {}).get("name") or "匯入的訓練設定")[:100])
    plan: dict[str, Any] = {"name": name, "kind": kind, "kind_name": cfg.KIND_NAMES[kind], "locked": locked,
                            "platform_version": meta.get("platform_version"), "warnings": warnings,
                            "includes": meta.get("includes") or {}, "ready": False, "errors": errors}
    if not isinstance(config, dict) or errors:
        return plan

    # 資料對應
    source = config.get("source") or {}
    import_files = _stage_files(files, "import")
    import_json = stages._parse_json(import_files["import.json"], "stages/import/import.json", errors) \
        if "import.json" in import_files else None
    if source.get("type") == "tabular":
        mapping = _map_tabular(ctx, state, files, import_json if isinstance(import_json, dict) else None,
                               dataset_id, errors)
        new_source = {"type": "tabular", "dataset_id": mapping.get("dataset_id", 0)}
    else:
        mapping = _map_image(ctx, files, source, studies, errors)
        new_source = mapping.get("source") or {}
    plan["mapping"] = {k: v for k, v in mapping.items() if k not in ("raw", "frame", "schema")}
    if mapping["mode"] == "choose" or errors:
        return plan

    # 合併各環節的設定檔（環節檔為準），檢查程式
    if image and new_source.get("type") == "dicom":
        labels_json = _stage_files(files, "labels").get("labels.json")
        label_source = _deidentified_labels(mapping, labels_json, source, errors)
        if label_source is not None:
            new_source["label_source"] = label_source
    merged = {**config, "source": new_source}
    try:
        normal = cfg.normalise(merged)
    except cfg.ConfigError as exc:
        errors.append(f"config.json：{exc}")
        return plan
    probe = TrainingSetting(id=None, project_id=ctx.project.id, name=name, kind=kind, config=normal)
    stage_files: dict[str, dict[str, bytes]] = {}
    custom: dict[str, bool] = {}
    for stage in stages.STAGES:
        folder = _stage_files(files, stage)
        body = {n: folder[n] for n in (stages.config_name(stage), stage + ".py") if n in folder}
        if image and stage == "labels" and "labels.json" in body and new_source.get("type") == "dicom":
            values = json.loads(body["labels.json"])
            values["label_source"] = new_source["label_source"]
            body["labels.json"] = stages._json(values)
        stage_errors, values, _ = _check_stage(ctx, probe, stage, body)
        errors += [f"stages/{stage}/{e}" if e.startswith(stage) else f"「{stages.STAGE_NAMES[stage]}」：{e}"
                   for e in stage_errors]
        if not stage_errors:
            probe.config = stages.merge_config(probe.config, stage, values)
            stage_files[stage] = body
            custom[stage] = stages.code_changed(kind, stage, body[stages.code_name(stage)])
    if errors:
        return plan
    try:
        normal = cfg.normalise(probe.config)
    except cfg.ConfigError as exc:
        errors.append(f"各環節合併後：{exc}")
        return plan
    if source.get("type") == "tabular" and not (custom.get("labels") or custom.get("preprocess")):
        problem = _tabular_problem(ctx, state, mapping, normal)
        if problem:
            errors.append(f"資料對應後：{problem}")
            return plan
    plan |= {"ready": True, "config": normal, "stage_files": stage_files, "custom": custom,
             "import_files": import_files, "_mapping": mapping}
    return plan


def _deidentified_labels(mapping: dict[str, Any], labels_json: bytes | None, source: dict[str, Any],
                         errors: list[str]) -> dict[str, Any] | None:
    """影像的 inline 標註對照表在匯出時已去識別：沿用目標專案資料版本的標註來源，否則要求改用其他標註來源。"""
    values = None
    if labels_json is not None:
        try:
            values = json.loads(labels_json).get("label_source")
        except (ValueError, AttributeError):
            values = None
    label_source = values or source.get("label_source")
    if not isinstance(label_source, dict):
        return label_source
    keys = list((label_source.get("values") or {}).keys())
    if label_source.get("provider") == "inline" and keys and all(DEIDENTIFIED_KEY.match(k) for k in keys):
        if mapping["mode"] == "version":
            return mapping["source"].get("label_source")
        errors.append("stages/labels/labels.json：inline 標註對照表已去識別，不能直接使用；請把 label_source 改成 "
                      "{\"provider\": \"annotations\"}（本專案的標註）或 {\"provider\": \"makesense\"} 後重新壓縮匯入")
        return None
    return label_source


def _check_stage(ctx: ProjectContext, probe: TrainingSetting, stage: str, files: dict[str, bytes]):
    errors: list[str] = []
    cname, pname = stages.config_name(stage), stages.code_name(stage)
    values = None
    for name in (cname, pname):
        if name not in files:
            errors.append(f"缺少 {name}")
    if cname in files:
        values = stages._parse_json(files[cname], cname, errors)
        if values is not None:
            errors += stages.check_values(probe.config, stage, values, cname)
    if pname in files:
        errors += stages.check_code(probe.kind, stage, files[pname])
    return errors, values, None


def _tabular_problem(ctx: ProjectContext, state, mapping: dict[str, Any], config: dict[str, Any]) -> str | None:
    from app.training.service import Invalid, check_tabular_frame

    if mapping["mode"] == "package":
        try:
            check_tabular_frame(mapping["frame"], config)
        except Invalid as exc:
            return str(exc)
        return None
    return stages.field_problem(ctx.session, state, ctx.project.id, config, {})


def plan_out(plan: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in plan.items() if k not in ("config", "stage_files", "custom", "import_files", "_mapping")}


# ---------------------------------------------------------------- 匯入

def import_package(ctx: ProjectContext, state, data: bytes, *, dataset_id: int | None, studies: Any,
                   source_ip: str | None) -> tuple[TrainingSetting, dict[str, Any]]:
    from app.tabular_api import service as tabular_service
    from app.training import service

    digest = _sha(data)

    def fail(errors: list[str]) -> None:
        ctx.session.rollback()
        record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="flow.package_import",
               target=f"project:{ctx.project.id}", result="failure", source_ip=source_ip,
               detail={"project_id": ctx.project.id, "sha256": digest, "errors": errors[:stages.MAX_ERRORS]})
        ctx.session.commit()

    try:
        plan = check_package(ctx, state, data, dataset_id=dataset_id, studies=studies)
    except stages.StageInvalid as exc:
        fail(exc.errors)
        raise
    if plan["errors"]:
        fail(plan["errors"])
        raise stages.StageInvalid(plan["errors"], "專案包不符合平台的流程框架，未匯入")
    if not plan["ready"]:
        raise stages.StageConflict("請先選擇要對應的資料（結構式資料集，或全部研究／指定研究）")
    mapping, config = plan["_mapping"], plan["config"]
    if mapping["mode"] == "package":
        name = flow_stages._unique_dataset_name(ctx.session, ctx.project.id, f"{plan['name']}（專案包資料）")
        ds, _ = tabular_service.create_dataset(ctx, state.store, raw=mapping["raw"],
                                               schema_text=json.dumps(mapping["schema"], ensure_ascii=False),
                                               name=name, filename=f"{name}.csv", source_ip=source_ip)
        config = cfg.normalise({**config, "source": {"type": "tabular", "dataset_id": ds.id}})
        plan["mapping"] |= {"dataset_id": ds.id, "dataset_name": ds.name}
    setting = service.create_setting(ctx, name=plan["name"], config=config, source_ip=source_ip,
                                     detail={"via": "flow.package_import", "package_sha256": digest})
    for stage in plan["locked"]:
        if stage in stages.STAGES:
            files = plan["stage_files"][stage]
        elif stage == "import":
            body, schema = _import_body(ctx, state, setting, plan["import_files"])
            files = {"import.json": body, **({"schema.json": schema} if schema is not None else {})}
        else:
            continue                                   # deploy：模型不隨專案包匯入
        flow_stages.save_override(ctx, state, setting, stage, files, setting.config, source_ip=source_ip,
                                  upload=data, before=stages.stage_config(setting.config, stage), commit=False,
                                  extra={"via_package": True})
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="flow.package_import",
           target=f"training_setting:{setting.id}", source_ip=source_ip,
           detail={"project_id": ctx.project.id, "sha256": digest, "platform_version": plan["platform_version"],
                   "mapping": plan["mapping"], "locked": [s for s in plan["locked"] if s != "deploy"],
                   "warnings": plan["warnings"]})
    ctx.session.commit()
    return setting, plan_out(plan)


def _import_body(ctx: ProjectContext, state, setting: TrainingSetting, import_files: dict[str, bytes]
                 ) -> tuple[bytes, bytes | None]:
    """資料匯入環節的匯入檔：source 換成目標專案對應後的資料（dataset_id、研究由平台對應）。"""
    from app.training import flow

    body, schema = flow.import_config(ctx.session, setting, state.store)
    original = import_files.get("schema.json")
    if setting.config["source"]["type"] == "tabular" and schema is not None:
        return stages._json(body), stages._json(schema)
    return stages._json(body), original if setting.config["source"]["type"] == "tabular" else None
