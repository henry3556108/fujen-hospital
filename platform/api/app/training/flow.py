"""整個流程（一份訓練設定）的專案包：匯出後可在自己的電腦以 run_all.py 重做；也可匯入另一個專案在平台執行。

專案包（zip）：

    flow.json            描述檔（格式版本、平台版本、各檔 sha256、哪些環節是匯入控制）
    README.md            地端執行步驟
    requirements.txt     依訓練種類，版本取自最近一次訓練的模型卡
    run_all.py           依序合併各環節的設定、組好程式後訓練
    config.json          合併後的完整設定（training_settings.config）
    stages/import|labels|preprocess|train|deploy/   各環節的 stage.json、設定檔、程式檔
    lib/                 runtime.py、imagekit.py 或 tabularkit.py、tabular/（結構式）
    dataset/             manifest.json（去識別）、version.json、[blobs/ 只有勾選附資料時]
    tools/build_dataset.py   由自己的 CSV 產生 dataset/（結構式）

資料匯入（import）與部署（deploy）環節只有設定檔（程式檔 load_data.py、predict.py 只供地端）。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from importlib import util as import_util
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.deps import ProjectContext
from app.models import Membership
from app.permissions import AccountType, Role
from app.storage import ObjectNotFound, ObjectStore
from app.training import bundle, config as cfg, snapshot, stages
from app.training.models import DatasetVersion, Deployment, DeploymentTitle, TrainedModel, TrainingRun, TrainingSetting

ALL_STAGES = ("import", "labels", "preprocess", "train", "deploy")
# 匯出前掃描所有文字檔：命中就中止（密碼、金鑰、token 一律不放進專案包）
SECRET_PATTERNS = [re.compile(p) for p in (r"-----BEGIN [A-Z ]*PRIVATE KEY", r"(?i)password\s*[=:]\s*['\"][^'\"]+['\"]",
                                           r"(?i)secret\s*[=:]\s*['\"][^'\"]+['\"]", r"(?i)\btoken=[A-Za-z0-9_\-]{8,}",
                                           r"\bAKIA[0-9A-Z]{16}\b")]
SECRET_ENV = ("POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "S3_SECRET_KEY", "S3_ACCESS_KEY", "KEYCLOAK_CLIENT_SECRET",
              "ORTHANC_PASSWORD", "INFERENCE_ADMIN_TOKEN", "MINIO_ROOT_PASSWORD", "WIKI_ADMIN_PASSWORD")


def _json(data: Any) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _slug(name: str, fallback: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or fallback


def _stage_dir() -> Path:
    return bundle.templates_dir() / "stages"


# ---------------------------------------------------------------- 資料匯入與部署環節的設定（只匯出的部分）

def import_config(session: Session, setting: TrainingSetting, store: ObjectStore | None = None
                  ) -> tuple[dict[str, Any], dict | None]:
    """import.json 的內容與結構式資料集的欄位結構（schema.json）。csv_sha256 是乾淨檔的 sha256，
    匯入專案包時用來在目標專案找同一份資料。"""
    from app.tabular_api.models import TabularDataset

    source = setting.config["source"]
    if source["type"] == "tabular":
        ds = session.get(TabularDataset, source["dataset_id"])
        info = None
        if ds is not None:
            info = {"name": ds.name, "original_filename": ds.original_filename, "valid_rows": ds.valid_rows}
            if store is not None:
                try:
                    info["csv_sha256"] = _sha(store.get(ds.object_key))
                except ObjectNotFound:
                    pass
        return {"source": dict(source), "dataset": info}, (ds.schema if ds is not None else None)
    out = {k: v for k, v in source.items() if k != "label_source"}
    return {"source": out}, None


def latest_run(session: Session, setting: TrainingSetting, *, succeeded: bool = False) -> TrainingRun | None:
    where = [TrainingRun.setting_id == setting.id, TrainingRun.project_id == setting.project_id]
    if succeeded:
        where.append(TrainingRun.status == "succeeded")
    return session.scalar(select(TrainingRun).where(*where).order_by(TrainingRun.id.desc()).limit(1))


def deploy_config(session: Session, setting: TrainingSetting) -> dict[str, Any]:
    """deploy.json：最近一次成功訓練的模型（以 sha256 指定）與它的部署。不寫任何平台內部位址。"""
    run = latest_run(session, setting, succeeded=True)
    model = session.scalar(select(TrainedModel).where(TrainedModel.run_id == run.id)) if run else None
    deployment = None
    if model is not None:
        row = session.scalar(select(Deployment).where(Deployment.model_id == model.id).order_by(Deployment.id.desc())
                             .limit(1))
        if row is not None:
            title = session.scalar(select(DeploymentTitle.title).where(DeploymentTitle.deployment_id == row.id))
            deployment = {"name": row.name, "title": title or model.name, "allowed_users": list(row.allowed_users)}
    return {"model": {"run_id": run.id, "format": model.format, "sha256": model.sha256} if model else None,
            "deployment": deployment, "batch": {"subset": "test"}}


def stage_folder(session: Session, store: ObjectStore, setting: TrainingSetting, stage: str, *,
                 actor: str) -> dict[str, bytes]:
    """環節資料夾的檔案（stage.json、設定檔、程式檔）。"""
    from app.training import flow_stages

    image = setting.kind in cfg.IMAGE_KINDS
    if stage in stages.STAGES:
        files = stages.stage_files(setting, stage, store, session)
        meta = stages.descriptor(setting, stage, files, actor=actor)
        return {**files, "stage.json": _json(meta)}
    files = flow_stages.current_files(session, store, setting, stage)
    meta = flow_stages.descriptor(setting, stage, files, actor=actor)
    local = "predict_local.py" if stage == "deploy" else f"load_data_{'image' if image else 'tabular'}.py"
    return {**files, flow_stages.LOCAL_ONLY[stage]: (_stage_dir() / local).read_bytes(), "stage.json": _json(meta)}


def _meta(setting: TrainingSetting, stage: str, files: dict[str, bytes], actor: str) -> dict[str, Any]:
    return {"format_version": stages.FORMAT_VERSION, "stage": stage, "kind": setting.kind,
            "platform_version": stages.PLATFORM_VERSION, "config_version": cfg.CONFIG_VERSION,
            "exported_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "exported_by": actor,
            "project_id": setting.project_id, "setting": {"id": setting.id, "name": setting.name},
            "files": {name: _sha(body) for name, body in sorted(files.items())}, "template_sha256": {}}


# ---------------------------------------------------------------- 去識別

def deidentify_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    """項目 id、group（SOP UID、Study UID、病例名、資料集名）換成序號；保留 blob sha256、Label、方框。"""
    groups: dict[Any, str] = {}
    items = []
    for no, item in enumerate(manifest["items"], 1):
        group = groups.setdefault(item.get("group"), f"group-{len(groups) + 1:03d}")
        clean = {k: v for k, v in item.items() if k in ("label", "boxes", "files")}
        items.append({"id": f"item-{no:04d}", "group": group, **clean})
    return {k: v for k, v in manifest.items() if k not in ("items", "content_hash")} | {"items": items}


def deidentify_config(config: dict[str, Any]) -> dict[str, Any]:
    """inline 標註的對照鍵（研究 UID、Accession）與指定的研究清單換成序號。"""
    out = json.loads(json.dumps(config))
    source = out.get("source") or {}
    if isinstance(source.get("studies"), list):
        source["studies"] = [f"study-{no:04d}" for no, _ in enumerate(source["studies"], 1)]
    label_source = (out.get("source") or {}).get("label_source") or {}
    if label_source.get("provider") == "inline":
        label_source["values"] = {f"key-{no:04d}": value
                                  for no, value in enumerate(label_source.get("values", {}).values(), 1)}
    return out


def can_include_data(session: Session, ctx: ProjectContext) -> bool:
    """專案包附原始資料：限計畫主持人（與平台管理者）。"""
    if ctx.user.account_type == AccountType.ADMIN:
        return True
    role = session.scalar(select(Membership.role).where(Membership.user_id == ctx.user.id,
                                                        Membership.project_id == ctx.project.id))
    return role == Role.PRINCIPAL_INVESTIGATOR.value


def _data_files(session: Session, state, setting: TrainingSetting, manifest: dict[str, Any]
                ) -> tuple[dict[str, bytes], dict[str, Any]]:
    """結構式原始資料：只含 Target、Feature 與前處理步驟用到的欄位（病歷號等其他欄位不輸出）。"""
    from app.tabular_api.models import TabularDataset
    from app.tabular_api.service import frame_cache

    ds = session.get(TabularDataset, setting.config["source"]["dataset_id"])
    if ds is None:
        raise stages.StageConflict("資料集已不存在，無法附上資料")
    frame = frame_cache(state).load(ds)
    tab = setting.config["tabular"]
    wanted = {tab["target"], *tab["features"]} | {c for s in tab.get("steps") or [] for c in s.get("columns") or []}
    columns = [c for c in frame.columns if c in wanted]
    csv = frame[columns].to_csv(index=False, lineterminator="\n").encode("utf-8")
    schema = {**ds.schema, "columns": [c for c in ds.schema["columns"] if c["name"] in columns]}
    schema_bytes = snapshot.canonical(schema)
    files = {f"dataset/blobs/{_sha(csv)}": csv, f"dataset/blobs/{_sha(schema_bytes)}": schema_bytes}
    item = {"id": "item-0001", "group": "group-001",
            "files": {"csv": {"blob": _sha(csv), "format": "csv", "size": len(csv)},
                      "schema": {"blob": _sha(schema_bytes), "format": "json", "size": len(schema_bytes)}}}
    body = {"version": snapshot.MANIFEST_VERSION, "kind": setting.kind, "label_names": [], "rows": len(frame),
            "items": [item]}
    return files, {**body, "content_hash": _sha(snapshot.canonical(body))}


# ---------------------------------------------------------------- 匯出

def scan_secrets(files: dict[str, bytes]) -> list[str]:
    values = [os.environ[k] for k in SECRET_ENV if len(os.environ.get(k, "")) >= 6]
    hits = []
    for name, body in sorted(files.items()):
        if not name.endswith((".py", ".json", ".md", ".txt")):
            continue
        text = body.decode("utf-8", "replace")
        for no, line in enumerate(text.splitlines(), 1):
            if any(p.search(line) for p in SECRET_PATTERNS) or any(v in line for v in values):
                hits.append(f"{name} 第 {no} 行")
    return hits


def _requirements(session: Session, setting: TrainingSetting) -> bytes:
    image = setting.kind in cfg.IMAGE_KINDS
    run = latest_run(session, setting, succeeded=True)
    model = session.scalar(select(TrainedModel).where(TrainedModel.run_id == run.id)) if run else None
    versions = ((model.card or {}).get("libraries") or {}) if model else {}
    lines = []
    for name in bundle.REQUIREMENTS[image]:
        lines.append(f"{name}=={versions[name]}" if "=" not in name and "<" not in name and versions.get(name)
                     else name)
    return ("\n".join(lines) + "\n").encode()


def _readme(setting: TrainingSetting, locked: list[str], has_data: bool, has_manifest: bool) -> str:
    image = setting.kind in cfg.IMAGE_KINDS
    model = "model.h5" if image else "model.pkl"
    data_step = ("專案包已附資料（dataset/），可以直接執行。" if has_data else
                 ("用自己的 CSV 產生資料夾：\n\n```bash\npython tools/build_dataset.py --csv 我的資料.csv "
                  "--schema stages/import/schema.json --out dataset\n```" if not image else
                  "依 stages/import/load_data.py 說明的格式，自備 dataset/（manifest.json 與 blobs/）。"
                  + ("dataset/manifest.json 是平台這次訓練用的清單（已去識別），可參考它的格式。" if has_manifest else "")))
    locked_text = "、".join(stages.STAGE_NAMES[s] for s in locked) or "無"
    return f"""# {setting.name}：整個流程（專案包）

由平台匯出（{cfg.KIND_NAMES[setting.kind]}）。匯入控制的環節：{locked_text}。

| 資料夾 | 內容 |
|---|---|
| `stages/import/` | 資料匯入：import.json{'' if image else '、schema.json（欄位結構）'}、load_data.py |
| `stages/labels/` | 標註：labels.json、labels.py |
| `stages/preprocess/` | 資料清理與前處理：preprocess.json、preprocess.py |
| `stages/train/` | 訓練：train.json、train.py |
| `stages/deploy/` | 模型匯出與部署：deploy.json、predict.py |
| `lib/` | 共用模組（平台執行時一律用平台的版本） |
| `dataset/` | 資料（manifest.json 已去識別：研究、影像、病例改成序號） |

## 在自己的電腦重做

需要 Python 3.12。

1. 安裝套件：`pip install -r requirements.txt`
2. 準備資料：{data_step}
3. 執行：`python run_all.py --data dataset --out out`
4. 產出在 `out/`：`config.json`、`{model}`、`metrics.json`、`splits.json`、`model_card.json`{'' if image else '、`preprocess.pkl`'}
5. 推論：`python stages/deploy/predict.py --model out --input 新資料{'.dcm' if image else '.csv'}`

各環節的設定檔與程式檔都可以修改，改完重新執行第 3 步。
同一份資料、設定、亂數種子、套件版本：結構式的指標與平台相同；影像在不同的 GPU 上指標可能不同。

## 放回平台

- 單一階段：到「建模管理」→ 訓練設定的「各階段處理程式碼」→ 該階段「上傳階段檔」，上傳 `stages/<階段>/` 壓成的 zip。
- 整包：到「建模管理」→「匯入專案包」，選擇要放進的專案。平台會建立新的訓練設定，並對應目標專案的資料。

平台只接受訓練映像內有的套件，不會安裝 requirements.txt。
"""


def export_package(ctx: ProjectContext, state, setting: TrainingSetting, *, include_data: bool,
                   source_ip: str | None) -> tuple[bytes, str]:
    session, store = ctx.session, state.store
    image = setting.kind in cfg.IMAGE_KINDS
    if include_data and image:
        raise stages.StageConflict("影像專案包不能附原始資料（平台沒有去識別功能，DICOM 標頭含病人資料）")
    if include_data and not can_include_data(session, ctx):
        raise stages.StageError("專案包附原始資料限計畫主持人")
    locked = [row.stage for row in stages.list_overrides(session, setting.id)]
    files: dict[str, bytes] = {"config.json": _json(deidentify_config(setting.config))}
    for stage in ALL_STAGES:
        for name, body in stage_folder(session, store, setting, stage, actor=ctx.user.username).items():
            files[f"stages/{stage}/{name}"] = body
    if "stages/import/import.json" in files:
        body = json.loads(files["stages/import/import.json"])
        body["source"] = deidentify_config({"source": body.get("source") or {}})["source"]
        files["stages/import/import.json"] = _json(body)
    if (files.get("stages/labels/labels.json") and image
            and (setting.config["source"].get("label_source") or {}).get("provider") == "inline"):
        labels = json.loads(files["stages/labels/labels.json"])
        labels["label_source"] = deidentify_config({"source": {"label_source": labels["label_source"]}})["source"][
            "label_source"]
        files["stages/labels/labels.json"] = _json(labels)
    root = bundle.templates_dir()
    for name in bundle.HELPERS[image]:
        files[f"lib/{name}"] = (root / name).read_bytes()
    if not image:
        package = Path(import_util.find_spec("tabular").origin).parent
        for path in sorted(package.glob("*.py")):
            files[f"lib/tabular/{path.name}"] = path.read_bytes()
        files["tools/build_dataset.py"] = (_stage_dir() / "build_dataset.py").read_bytes()
    files["run_all.py"] = (_stage_dir() / "run_all.py").read_bytes()
    files["requirements.txt"] = _requirements(session, setting)

    run = latest_run(session, setting)
    version = session.get(DatasetVersion, run.dataset_version_id) if run else None
    has_manifest = False
    if version is not None:
        try:
            manifest = snapshot.load_manifest(store, version)
        except ObjectNotFound:
            manifest = None
        if manifest is not None:
            has_manifest = True
            files["dataset/version.json"] = _json({
                "content_hash": version.content_hash, "item_count": version.item_count,
                "manifest_version": manifest.get("version", snapshot.MANIFEST_VERSION), "kind": version.kind,
                "summary": {k: v for k, v in version.summary.items() if k in ("rows", "studies", "cases",
                                                                               "label_names", "dataset")}})
            files["dataset/manifest.json"] = _json(deidentify_manifest(manifest))
    if include_data:
        data_files, manifest = _data_files(session, state, setting, {})
        files |= data_files
        files["dataset/manifest.json"] = _json(manifest)
        has_manifest = True
    files["README.md"] = _readme(setting, locked, include_data, has_manifest).encode("utf-8")
    hits = scan_secrets(files)
    if hits:
        raise stages.StageConflict(f"專案包內疑似有密碼或金鑰，已中止匯出：{'、'.join(hits[:10])}")
    flow_meta = {"format_version": stages.FORMAT_VERSION, "platform_version": stages.PLATFORM_VERSION,
                 "config_version": cfg.CONFIG_VERSION, "kind": setting.kind, "setting": {"name": setting.name},
                 "exported_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                 "exported_by": ctx.user.username, "locked": locked,
                 "includes": {"data": include_data, "manifest": has_manifest, "model": False},
                 "files": {name: _sha(body) for name, body in sorted(files.items())}}
    files["flow.json"] = _json(flow_meta)
    data = bundle.write_zip(files)
    digest = _sha(data)
    category = AuditCategory.DATA_EXCHANGE if include_data else AuditCategory.TRAINING
    record(session, actor=ctx.user.username, category=category, action="flow.package_export",
           target=f"training_setting:{setting.id}", source_ip=source_ip,
           detail={"project_id": setting.project_id, "sha256": digest, "files": len(files),
                   "includes": flow_meta["includes"], "locked": locked})
    session.commit()
    date = datetime.now(timezone.utc).strftime("%Y%m%d")
    name = (f"{_slug(ctx.project.name, f'project-{ctx.project.id}')}-{_slug(setting.name, f'setting-{setting.id}')}"
            f"-flow-{date}.zip")
    return data, name
