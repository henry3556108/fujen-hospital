"""資料匯入（import）與模型匯出、部署（deploy）環節：只有設定檔，沒有在平台執行的程式。

| 環節 | 設定檔（可匯入） | 只供地端的程式 | 匯入結果 |
|---|---|---|---|
| import | import.json、schema.json（結構式） | load_data.py | 影像：source.studies／cases；結構式：schema.json 改過時用原始檔與新結構建立新資料集，訓練設定改用它 |
| deploy | deploy.json | predict.py | 建立部署，或更新同名部署的顯示名稱與可呼叫帳號 |

鎖定（匯入控制）沿用 training_stage_overrides；deploy 另在 deployment_stage_overrides 記一列，部署頁的
「可呼叫的帳號」因此不能修改。API 內不執行任何使用者程式。
"""
from __future__ import annotations

import io
import json
from datetime import datetime
from typing import Any

from sqlalchemy import select

from app.audit import AuditCategory, record
from app.deps import ProjectContext
from app.models import Membership, User, utcnow
from app.storage import ObjectNotFound, ObjectStore
from app.training import config as cfg, stages
from app.training.models import Deployment, DeploymentStageOverride, DeploymentTitle, StageOverride, TrainedModel, \
    TrainingSetting

CONFIG_STAGES = ("import", "deploy")
FILES = {"import": ("import.json", "schema.json"), "deploy": ("deploy.json",)}
LOCAL_ONLY = {"import": "load_data.py", "deploy": "predict.py"}
SUBSETS = ("train", "validation", "test")


def file_names(setting: TrainingSetting, stage: str) -> list[str]:
    if stage == "import" and setting.config["source"]["type"] != "tabular":
        return ["import.json"]
    return list(FILES[stage])


# ---------------------------------------------------------------- 目前的設定檔

def current_files(session, store: ObjectStore | None, setting: TrainingSetting, stage: str) -> dict[str, bytes]:
    """匯入控制時是匯入的版本，否則由平台目前的設定產生。"""
    from app.training import flow

    row = stages.get_override(session, setting.id, stage)
    if row is not None and store is not None:
        files = stages.override_files(store, row)
        return {name: files[name] for name in file_names(setting, stage) if name in files}
    if stage == "import":
        body, schema = flow.import_config(session, setting, store)
        out = {"import.json": stages._json(body)}
        if setting.config["source"]["type"] == "tabular" and schema is not None:
            out["schema.json"] = stages._json(schema)
        return out
    return {"deploy.json": stages._json(flow.deploy_config(session, setting))}


def descriptor(setting: TrainingSetting, stage: str, files: dict[str, bytes], *, actor: str) -> dict[str, Any]:
    out = stages.descriptor(setting, stage, files, actor=actor)
    out["template_sha256"] = {}
    return out


def readme(setting: TrainingSetting, stage: str) -> str:
    names = "、".join(f"`{n}`" for n in file_names(setting, stage))
    editable = ("影像：`source.studies`（\"all\" 或研究 UID 清單）、`source.cases`；結構式：`schema.json` 的型別、必填、範圍、"
                "允許值、缺值寫法（平台會用原始檔與新結構建立新資料集）" if stage == "import" else
                "`deployment` 的 `name`（服務名稱）、`title`（顯示名稱）、`allowed_users`（可呼叫的帳號）、`batch.subset`")
    return f"""# {setting.name}：{stages.STAGE_NAMES[stage]}環節

由平台匯出（{cfg.KIND_NAMES[setting.kind]}）。

| 檔案 | 說明 |
|---|---|
| {names} | 這個環節的設定（JSON），可修改：{editable} |
| `{LOCAL_ONLY[stage]}` | 只供在自己的電腦使用，匯入平台時不會讀取 |
| `stage.json` | 描述檔，請勿修改 |

修改後整個資料夾重新壓成 zip，到平台「建模管理」→ 訓練設定的「流程程式碼」→「{stages.STAGE_NAMES[stage]}」→「上傳環節檔」。
"""


def stage_zip(setting: TrainingSetting, stage: str, files: dict[str, bytes], *, actor: str) -> bytes:
    from app.training import bundle, flow

    body = dict(files)
    body["stage.json"] = stages._json(descriptor(setting, stage, files, actor=actor))
    body["README.md"] = readme(setting, stage).encode("utf-8")
    body[LOCAL_ONLY[stage]] = (flow._stage_dir() / ("predict_local.py" if stage == "deploy" else
                                                    f"load_data_{'image' if setting.kind in cfg.IMAGE_KINDS else 'tabular'}.py")
                               ).read_bytes()
    return bundle.write_zip(body)


# ---------------------------------------------------------------- 共用：檢查設定檔的鍵

def _keys(values: Any, allowed: set[str], fname: str, stage: str, errors: list[str]) -> dict[str, Any] | None:
    if not isinstance(values, dict):
        errors.append(f"{fname} 必須是 JSON 物件")
        return None
    for key in sorted(set(values) - allowed):
        owner = stages.KEY_STAGE.get(key)
        if owner and owner != stage:
            errors.append(f"{fname}：「{key}」屬於「{stages.STAGE_NAMES[owner]}」環節，請在該環節的檔案修改")
        else:
            errors.append(f"{fname}：不支援的設定「{key}」（可用：{'、'.join(sorted(allowed))}）")
    return values


def _parse(files: dict[str, bytes], name: str, errors: list[str], *, required: bool = True) -> Any:
    if name not in files:
        if required:
            errors.append(f"缺少 {name}")
        return None
    return stages._parse_json(files[name], name, errors)


def _unknown_files(setting: TrainingSetting, stage: str, files: dict[str, bytes], errors: list[str]) -> None:
    for name in sorted(set(files) - set(FILES[stage]) - {LOCAL_ONLY[stage], "stage.json", "README.md"}):
        errors.append(f"不認得的檔案「{name}」：這個環節只有 {'、'.join(file_names(setting, stage))}")


# ---------------------------------------------------------------- 資料匯入（import）

def _unique_dataset_name(session, project_id: int, base: str) -> str:
    from app.tabular_api.models import TabularDataset

    taken = set(session.scalars(select(TabularDataset.name).where(TabularDataset.project_id == project_id)))
    name, n = base, 2
    while name in taken:
        name, n = f"{base} {n}", n + 1
    return name


def check_import(ctx: ProjectContext, state, setting: TrainingSetting, files: dict[str, bytes]
                 ) -> tuple[list[str], dict[str, Any] | None, dict[str, Any] | None]:
    """回傳（錯誤, 新的 source, 需要建立的新資料集：{dataset, raw, schema_text, name}）。"""
    from app.imaging.service import list_studies
    from app.tabular_api.models import TabularDataset

    errors: list[str] = []
    _unknown_files(setting, "import", files, errors)
    values = _keys(_parse(files, "import.json", errors), {"source", "dataset", "studies"}, "import.json", "import",
                   errors) if "import.json" in files else _parse(files, "import.json", errors)
    current = setting.config["source"]
    source = values.get("source") if isinstance(values, dict) else None
    if values is not None and not isinstance(source, dict):
        errors.append("import.json：缺少 source（資料來源）")
        source = None
    new_source: dict[str, Any] | None = None
    new_dataset = None
    if source is not None:
        if source.get("type") != current["type"]:
            errors.append(f"import.json：「source.type」不能修改（由平台對應），這份訓練設定是「{current['type']}」")
        elif current["type"] == "tabular":
            for key in sorted(set(source) - {"type", "dataset_id"}):
                errors.append(f"import.json：不支援的設定「source.{key}」")
            if source.get("dataset_id") != current["dataset_id"]:
                errors.append("import.json：「source.dataset_id」不能修改（由平台對應）；要改用其他資料集請在訓練設定表單選擇")
            new_source = {"type": "tabular", "dataset_id": current["dataset_id"]}
        else:
            allowed = {"type", "studies"} if current["type"] == "dicom" else {"type", "format", "cases"}
            for key in sorted(set(source) - allowed):
                owner = stages.KEY_STAGE.get(key)
                errors.append(f"import.json：「source.{key}」屬於「{stages.STAGE_NAMES[owner]}」環節，請在該環節的檔案修改"
                              if owner and owner != "import" else f"import.json：不支援的設定「source.{key}」")
            merged = {**source}
            if current["type"] == "dicom":
                merged["label_source"] = current["label_source"]
            normal = stages._call(errors, "import.json：", cfg.normalise_source, merged, setting.kind)
            if normal is not None:
                new_source = {k: v for k, v in normal.items() if k != "label_source"}
                if current["type"] == "dicom" and normal["studies"] != "all":
                    known = {s.study_instance_uid for s in list_studies(ctx.session, setting.project_id)}
                    missing = [u for u in normal["studies"] if u not in known]
                    if missing:
                        errors.append(f"import.json：研究不在本專案或不在 Accession 清單內：{'、'.join(missing[:10])}")
    schema = _parse(files, "schema.json", errors, required=False)
    if current["type"] != "tabular" and "schema.json" in files:
        errors.append("schema.json 只用在結構式資料，影像訓練設定不需要")
    elif current["type"] == "tabular" and schema is not None and not errors:
        new_dataset = _schema_dataset(ctx, state, setting, schema, errors)
    ds = ctx.session.get(TabularDataset, current["dataset_id"]) if current["type"] == "tabular" else None
    if current["type"] == "tabular" and ds is None:
        errors.append(f"找不到結構式資料集 {current['dataset_id']}")
    return errors, new_source, new_dataset


def _schema_dataset(ctx: ProjectContext, state, setting: TrainingSetting, schema: Any, errors: list[str]):
    """schema.json 與資料集目前的欄位結構不同時：用原始檔重新驗證，回傳要建立的新資料集。相同時回傳 None。"""
    from tabular.schema import Schema
    from tabular.validate import validate_and_load

    from app.tabular_api.models import TabularDataset
    from app.training.service import Invalid, check_tabular_frame

    ds = ctx.session.get(TabularDataset, setting.config["source"]["dataset_id"])
    if ds is None:
        return None
    try:
        parsed = Schema.from_dict(schema)
    except Exception as exc:  # noqa: BLE001  SchemaError、KeyError 等
        errors.append(f"schema.json：{exc}")
        return None
    if parsed.to_dict() == Schema.from_dict(ds.schema).to_dict():
        return None
    try:
        raw = state.store.get(ds.original_key)
    except ObjectNotFound:
        errors.append(f"資料集「{ds.name}」的原始檔已不存在，無法用新的欄位結構重新驗證")
        return None
    report, frame = validate_and_load(io.BytesIO(raw), parsed)
    if report["errors"] or not report.get("valid_rows"):
        summary = "；".join(e.get("message") or f"第 {e.get('row')} 列 {e.get('column') or ''}{e.get('reason', '')}"
                           for e in (report["errors"] or report.get("rejected") or [])[:3])
        errors.append(f"依新的欄位結構，原始檔 {report.get('total_rows', 0)} 列都不合格，請檢查 schema.json；"
                      f"驗證報告：{summary or '沒有合格的列'}")
        return None
    try:
        check_tabular_frame(frame, setting.config)
    except Invalid as exc:
        errors.append(f"依新的欄位結構：{exc}")
        return None
    name = _unique_dataset_name(ctx.session, setting.project_id,
                                f"{ds.name}（匯入結構 {datetime.now().strftime('%Y-%m-%d')}）")
    return {"dataset": ds, "raw": raw, "schema_text": json.dumps(parsed.to_dict(), ensure_ascii=False), "name": name,
            "valid_rows": report.get("valid_rows")}


def apply_import(ctx: ProjectContext, state, setting: TrainingSetting, files: dict[str, bytes], *,
                 source_ip: str | None, upload: bytes | None = None) -> StageOverride:
    from app.tabular_api import service as tabular_service

    files = {k: v for k, v in files.items() if k != LOCAL_ONLY["import"]}     # load_data.py 只供地端，不讀
    errors, new_source, new_dataset = check_import(ctx, state, setting, files)
    if not errors:
        try:
            normal = cfg.normalise(stages.merge_config(setting.config, "import", new_source))
        except cfg.ConfigError as exc:
            errors.append(f"與其他環節合併後：{exc}")
    raw = upload if upload is not None else b"".join(files.values())
    if errors:
        stages._fail(ctx, setting, "import", raw, errors, source_ip)
        raise stages.StageInvalid(errors)
    extra: dict[str, Any] = {}
    if new_dataset is not None:
        old = new_dataset["dataset"]
        ds, _ = tabular_service.create_dataset(ctx, state.store, raw=new_dataset["raw"],
                                               schema_text=new_dataset["schema_text"], name=new_dataset["name"],
                                               filename=old.original_filename, source_ip=source_ip)
        normal = cfg.normalise(stages.merge_config(setting.config, "import",
                                                   {"type": "tabular", "dataset_id": ds.id}))
        extra = {"new_dataset_id": ds.id, "new_dataset_name": ds.name, "from_dataset_id": old.id}
        setting = ctx.session.get(TrainingSetting, setting.id)       # create_dataset 已 commit
    else:
        problem = stages.field_problem(ctx.session, state, setting.project_id, normal,
                                       stages.custom_stages(ctx.session, setting.id))
        if problem:
            stages._fail(ctx, setting, "import", raw, [f"與其他環節合併後：{problem}"], source_ip)
            raise stages.StageInvalid([f"與其他環節合併後：{problem}"])
    stored_files = {name: files[name] for name in file_names(setting, "import") if name in files}
    return save_override(ctx, state, setting, "import", stored_files, normal, source_ip=source_ip, upload=upload,
                         extra=extra)


# ---------------------------------------------------------------- 部署（deploy）

def _members(session, project_id: int, names: list[str]) -> list[str]:
    rows = session.execute(select(User.username).join(Membership, Membership.user_id == User.id)
                           .where(Membership.project_id == project_id, User.username.in_(names))).all()
    known = {r[0] for r in rows}
    return [n for n in names if n not in known]


def check_deploy(ctx: ProjectContext, setting: TrainingSetting, files: dict[str, bytes]
                 ) -> tuple[list[str], dict[str, Any] | None]:
    """回傳（錯誤, 套用計畫：model、deployment（既有或 None）、name、title、allowed_users、subset）。"""
    from app.training.service import _NAME

    errors: list[str] = []
    _unknown_files(setting, "deploy", files, errors)
    values = _keys(_parse(files, "deploy.json", errors), {"model", "deployment", "batch"}, "deploy.json", "deploy",
                   errors) if "deploy.json" in files else _parse(files, "deploy.json", errors)
    if not isinstance(values, dict):
        return errors, None
    model_ref = values.get("model")
    model = None
    if not isinstance(model_ref, dict) or not isinstance(model_ref.get("sha256"), str) or not model_ref["sha256"]:
        errors.append("deploy.json：缺少 model.sha256（要部署哪一個模型）")
    else:
        sha = model_ref["sha256"]
        model = ctx.session.scalar(select(TrainedModel).where(TrainedModel.project_id == setting.project_id,
                                                              TrainedModel.sha256 == sha)
                                   .order_by(TrainedModel.id.desc()).limit(1))
        if model is None:
            errors.append(f"deploy.json：本專案沒有 sha256 為 {sha[:12]} 的模型，請先匯入或重新訓練")
        elif model.kind != setting.kind:
            errors.append(f"deploy.json：模型的訓練種類是「{cfg.KIND_NAMES.get(model.kind, model.kind)}」，"
                          f"這份訓練設定是「{cfg.KIND_NAMES[setting.kind]}」")
        elif (model.card or {}).get("deployable") is False:
            errors.append("deploy.json：這個模型使用自訂前處理，不能在平台部署，只能下載")
    dep = values.get("deployment")
    plan: dict[str, Any] = {"model": model}
    if not isinstance(dep, dict):
        errors.append("deploy.json：缺少 deployment（服務名稱、顯示名稱、可呼叫的帳號）")
    else:
        for key in sorted(set(dep) - {"name", "title", "allowed_users"}):
            errors.append(f"deploy.json：不支援的設定「deployment.{key}」")
        name = dep.get("name")
        if not isinstance(name, str) or not _NAME.match(name):
            errors.append("deploy.json：服務名稱（deployment.name）只能用小寫英數字與連字號，開頭結尾必須是英數字，最多 63 字")
        title = dep.get("title")
        if title is not None and (not isinstance(title, str) or len(title.strip()) > 128):
            errors.append("deploy.json：顯示名稱（deployment.title）最多 128 字")
        users = dep.get("allowed_users", [])
        if not isinstance(users, list) or not all(isinstance(u, str) and u for u in users):
            errors.append("deploy.json：可呼叫的帳號（deployment.allowed_users）必須是帳號名稱的清單")
            users = []
        missing = _members(ctx.session, setting.project_id, sorted(set(users)))
        if missing:
            errors.append(f"deploy.json：以下帳號不是本專案成員：{'、'.join(missing)}")
        existing = ctx.session.scalar(select(Deployment).where(Deployment.name == name)) if isinstance(name, str) else None
        if existing is not None and existing.project_id != setting.project_id:
            errors.append(f"deploy.json：部署名稱「{name}」已被使用")
        elif existing is not None and model is not None and existing.model_id != model.id:
            errors.append(f"deploy.json：部署「{name}」用的是另一個模型（#{existing.model_id}），請改用新的服務名稱")
        plan |= {"deployment": existing, "name": name, "title": title, "allowed_users": sorted(set(users))}
    batch = values.get("batch")
    subset = (batch or {}).get("subset", "test") if isinstance(batch, dict) or batch is None else None
    if subset not in SUBSETS:
        errors.append(f"deploy.json：batch.subset 必須是 {'、'.join(SUBSETS)}")
    plan["subset"] = subset
    return errors, plan


def deployment_lock(session, deployment_id: int) -> DeploymentStageOverride | None:
    return session.scalar(select(DeploymentStageOverride).where(DeploymentStageOverride.deployment_id == deployment_id))


def _title(session, deployment: Deployment) -> str | None:
    return session.scalar(select(DeploymentTitle.title).where(DeploymentTitle.deployment_id == deployment.id))


def apply_deploy(ctx: ProjectContext, state, setting: TrainingSetting, files: dict[str, bytes], *,
                 source_ip: str | None, upload: bytes | None = None) -> StageOverride:
    from app.training import service

    files = {k: v for k, v in files.items() if k != LOCAL_ONLY["deploy"]}       # predict.py 只供地端，不讀
    errors, plan = check_deploy(ctx, setting, files)
    raw = upload if upload is not None else b"".join(files.values())
    if errors:
        stages._fail(ctx, setting, "deploy", raw, errors, source_ip)
        raise stages.StageInvalid(errors)
    session = ctx.session
    row = stages.get_override(session, setting.id, "deploy")
    deployment: Deployment | None = plan["deployment"]
    before: dict[str, Any] | None = None
    if row is None:
        before = ({"deployment_id": deployment.id, "created": False, "title": _title(session, deployment),
                   "allowed_users": list(deployment.allowed_users)} if deployment is not None else
                  {"deployment_id": None, "created": True})
    if deployment is None:
        try:
            deployment = service.create_deployment(ctx, state, model=plan["model"], name=plan["name"],
                                                   title=plan["title"], allowed_users=plan["allowed_users"],
                                                   source_ip=source_ip)
        except service.TrainingError as exc:
            stages._fail(ctx, setting, "deploy", raw, [f"deploy.json：{exc}"], source_ip)
            raise stages.StageInvalid([f"deploy.json：{exc}"]) from exc
        setting = session.get(TrainingSetting, setting.id)
        row = stages.get_override(session, setting.id, "deploy")
        if before is not None:
            before["deployment_id"] = deployment.id
    else:
        old_users = list(deployment.allowed_users)
        deployment.allowed_users = plan["allowed_users"]
        title_row = session.scalar(select(DeploymentTitle).where(DeploymentTitle.deployment_id == deployment.id))
        if plan["title"] is not None and title_row is not None:
            title_row.title = plan["title"].strip()[:128] or title_row.title
        record(session, actor=ctx.user.username, category=AuditCategory.INFERENCE, action="deployment.access",
               target=f"deployment:{deployment.id}", source_ip=source_ip,
               detail={"project_id": deployment.project_id, "name": deployment.name, "before": old_users,
                       "after": plan["allowed_users"], "via": "flow.stage_import"})
    out = save_override(ctx, state, setting, "deploy", {"deploy.json": files["deploy.json"]}, setting.config,
                        source_ip=source_ip, upload=upload, before=before,
                        extra={"deployment_id": deployment.id, "model_id": plan["model"].id,
                               "created": bool(before and before.get("created")), "subset": plan["subset"]},
                        commit=False)
    # 上一份匯入檔指向另一個部署時，那個部署解除鎖定
    for other in session.scalars(select(DeploymentStageOverride).where(
            DeploymentStageOverride.project_id == setting.project_id,
            DeploymentStageOverride.deployment_id != deployment.id)):
        if (other.config_before or {}).get("setting_id") == setting.id:
            session.delete(other)
    lock = deployment_lock(session, deployment.id)
    fields = {"files_key": out.files_key, "sha256": out.sha256, "files": out.files,
              "config_before": {**(out.config_before or {}), "setting_id": setting.id},
              "imported_by": ctx.user.username, "imported_at": utcnow()}
    if lock is None:
        session.add(DeploymentStageOverride(project_id=setting.project_id, deployment_id=deployment.id, **fields))
    else:
        for key, value in fields.items():
            setattr(lock, key, value)
    session.commit()
    return out


def unlock_deploy(ctx: ProjectContext, state, setting: TrainingSetting, row: StageOverride, *,
                  source_ip: str | None) -> None:
    """改回用介面設定（部署）：刪除匯入檔、解除部署的鎖定。匯入前已存在的部署還原顯示名稱與可呼叫帳號；
    由匯入建立的部署保留（不自動下線正在使用的服務），可在部署頁自行刪除。"""
    session = ctx.session
    before = row.config_before or {}
    deployment = session.get(Deployment, before.get("deployment_id")) if before.get("deployment_id") else None
    restored = False
    if deployment is not None and not before.get("created"):
        deployment.allowed_users = list(before.get("allowed_users") or [])
        title_row = session.scalar(select(DeploymentTitle).where(DeploymentTitle.deployment_id == deployment.id))
        if title_row is not None and before.get("title"):
            title_row.title = before["title"]
        restored = True
    for lock in session.scalars(select(DeploymentStageOverride).where(
            DeploymentStageOverride.project_id == setting.project_id)):
        if (lock.config_before or {}).get("setting_id") == setting.id:
            session.delete(lock)
    key, digest = row.files_key, row.sha256
    session.delete(row)
    record(session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="flow.stage_unlock",
           target=f"training_setting:{setting.id}", source_ip=source_ip,
           detail={"project_id": setting.project_id, "stage": "deploy", "deleted_sha256": digest,
                   "deployment_id": before.get("deployment_id"), "restored": restored})
    session.commit()
    stages._delete(state.store, key)


def drop_deployment_locks(session, store: ObjectStore, deployment: Deployment) -> None:
    """刪除部署時：部署的鎖定與指向它的 deploy 環節匯入檔一併刪除。"""
    lock = deployment_lock(session, deployment.id)
    if lock is None:
        return
    setting_id = (lock.config_before or {}).get("setting_id")
    row = stages.get_override(session, setting_id, "deploy") if setting_id else None
    if row is not None:
        stages._delete(store, row.files_key)
        session.delete(row)
    session.delete(lock)
    session.flush()


def lock_out(session, deployment_id: int) -> dict[str, Any] | None:
    from app.training.service import _iso

    lock = deployment_lock(session, deployment_id)
    if lock is None:
        return None
    setting = session.get(TrainingSetting, (lock.config_before or {}).get("setting_id") or 0)
    return {"sha256": lock.sha256, "files": lock.files, "imported_by": lock.imported_by,
            "imported_at": _iso(lock.imported_at),
            "setting": {"id": setting.id, "name": setting.name} if setting is not None else None}


# ---------------------------------------------------------------- 寫入匯入控制（各環節共用）

def save_override(ctx: ProjectContext, state, setting: TrainingSetting, stage: str, files: dict[str, bytes],
                  normal: dict[str, Any], *, source_ip: str | None, upload: bytes | None,
                  before: dict[str, Any] | None = None, extra: dict[str, Any] | None = None,
                  commit: bool = True) -> StageOverride:
    zipper = stage_zip if stage in CONFIG_STAGES else stages.stage_zip
    stored = zipper(setting, stage, files, actor=ctx.user.username)
    digest = stages._sha(stored)
    key = stages.files_key(setting, stage, digest)
    state.store.put(key, stored)
    changed = stage in stages.STAGES and stages.code_changed(setting.kind, stage, files[stages.code_name(stage)])
    row = stages.get_override(ctx.session, setting.id, stage)
    old_key = row.files_key if row is not None else None
    if row is None:
        row = StageOverride(project_id=setting.project_id, setting_id=setting.id, stage=stage,
                            config_before=before if before is not None else stages.stage_config(setting.config, stage),
                            imported_by=ctx.user.username)
        ctx.session.add(row)
    row.files_key, row.sha256, row.code_changed = key, digest, changed
    row.files = {name: stages._sha(body) for name, body in sorted(files.items())}
    row.imported_by, row.imported_at = ctx.user.username, utcnow()
    setting.config, setting.updated_by = normal, ctx.user.username
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="flow.stage_import",
           target=f"training_setting:{setting.id}", source_ip=source_ip,
           detail={"project_id": setting.project_id, "stage": stage, "sha256": digest, "files": row.files,
                   "code_changed": changed, "config_before_sha256": stages._sha(stages._json(row.config_before)),
                   "via": "upload" if upload is not None else "editor", **(extra or {})})
    if commit:
        ctx.session.commit()
    else:
        ctx.session.flush()
    if old_key and old_key != key:
        stages._delete(state.store, old_key)
    return row
