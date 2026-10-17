"""訓練流程的環節（M2「錄製巨集」）：使用者在介面點選的設定，平台同時記成每個環節的設定檔＋程式檔。

每個環節可以「檢視程式碼」、匯出成環節檔（zip）、在網頁上修改後套用，或上傳修改過的環節檔。
套用後該環節由匯入的檔案控制（training_stage_overrides 一列）：介面不能再點擊修改，送出訓練時用匯入的程式；
「改回用介面設定」會刪除匯入檔、還原匯入前的設定。

| 環節 | 設定檔 | 程式檔 | 擁有的設定欄位 |
|---|---|---|---|
| labels（標註） | labels.json | labels.py | 影像：source.label_source、image.labels；結構式：tabular.target、tabular.features |
| preprocess（前處理） | preprocess.json | preprocess.py | 影像：image.resize、augmentation、augmentation_copies；結構式：tabular.steps、tabular.missing |
| train（訓練） | train.json | train.py | split、seed、validation、tabular.algorithm、其餘 hyperparameters |

資料匯入（import）與部署（deploy）環節在 flow.py。API 內不執行任何使用者程式：檢核只用 compile 與 ast。
"""
from __future__ import annotations

import ast
import copy
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import AuditCategory, record
from app.deps import ProjectContext
from app.models import utcnow
from app.storage import ObjectNotFound, ObjectStore
from app.training import bundle, config as cfg
from app.training.models import StageOverride, TrainingSetting

FORMAT_VERSION = 1
PLATFORM_VERSION = os.environ.get("PLATFORM_VERSION", "2026.11.0")
MAX_ERRORS = 20
STAGES = ("labels", "preprocess", "train")          # 有程式檔、可在網頁編輯的環節
ALL_STAGES = ("import", "labels", "preprocess", "train", "deploy")   # 可匯入的環節（import、deploy 只有設定檔）
STAGE_NAMES = {"import": "資料匯入", "labels": "標註", "preprocess": "資料清理與前處理", "dataset": "資料版本凍結",
               "train": "訓練", "deploy": "模型匯出與部署"}
# 設定檔的鍵屬於哪個環節：放錯環節時指出應該在哪裡改
KEY_STAGE = {"source": "import", "studies": "import", "cases": "import", "dataset_id": "import", "format": "import",
             "dataset": "import", "label_source": "labels", "labels": "labels", "target": "labels",
             "features": "labels", "resize": "preprocess", "augmentation": "preprocess",
             "augmentation_copies": "preprocess", "steps": "preprocess", "missing": "preprocess", "split": "train",
             "seed": "train", "validation": "train", "algorithm": "train", "hyperparameters": "train",
             "model": "deploy", "deployment": "deploy", "batch": "deploy"}
# 程式檔的進入點：函式名稱 → 位置參數
ENTRYPOINTS = {
    ("labels", True): {"build_labels": ("manifest", "config")},
    ("labels", False): {"build_labels": ("frame", "config")},
    ("preprocess", True): {"prepare_image": ("image", "size", "config"),
                           "augment_training_set": ("samples", "config", "seed")},
    ("preprocess", False): {"fit_transform": ("train", "config")},
    ("train", True): {"train": ("config", "data_dir", "out_dir")},
    ("train", False): {"train": ("config", "data_dir", "out_dir")},
}
# 訓練映像內有的套件（import 白名單）。用來提早發現「平台沒有這個套件」，不是安全邊界（安全邊界是 Job 的隔離）
ALLOWED_IMPORTS = {"numpy", "pandas", "scipy", "sklearn", "statsmodels", "lifelines", "keras", "tensorflow", "pydicom",
                   "nibabel", "SimpleITK", "PIL", "h5py", "tabular", "runtime", "imagekit", "tabularkit", "labels",
                   "preprocess", "train"}


class StageError(Exception):
    status_code = 400


class StageNotFound(StageError):
    status_code = 404


class StageConflict(StageError):
    status_code = 409


class StageInvalid(StageError):
    """不符合框架：列出全部錯誤（最多 20 條）。"""
    status_code = 422

    def __init__(self, errors: list[str], message: str = "檔案不符合平台的流程框架，未套用"):
        super().__init__(message)
        self.errors = errors[:MAX_ERRORS]

    def detail(self) -> dict[str, Any]:
        return {"code": "stage_invalid", "message": str(self), "errors": self.errors}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json(data: Any) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _image(kind: str) -> bool:
    return kind in cfg.IMAGE_KINDS


def code_name(stage: str) -> str:
    return f"{stage}.py"


def config_name(stage: str) -> str:
    return f"{stage}.json"


def check_stage(stage: str) -> str:
    if stage not in ALL_STAGES:
        raise StageNotFound(f"沒有「{stage}」這個環節（可用：{'、'.join(ALL_STAGES)}）")
    return stage


def has_code(stage: str) -> bool:
    return stage in STAGES


# ---------------------------------------------------------------- 設定的切分與合併

def stage_keys(config: dict[str, Any], stage: str) -> tuple[str, ...]:
    image = _image(config["kind"])
    if stage == "labels":
        if image:
            return ("label_source", "labels") if config["source"]["type"] == "dicom" else ("labels",)
        return ("target", "features")
    if stage == "preprocess":
        return ("resize", "augmentation", "augmentation_copies") if image else ("steps", "missing")
    return ("split", "seed", "hyperparameters") if image else ("split", "seed", "validation", "algorithm",
                                                               "hyperparameters")


def stage_config(config: dict[str, Any], stage: str) -> dict[str, Any]:
    """正規化後的訓練設定中屬於這個環節的部分（環節的設定檔內容）。"""
    if stage == "import":       # 資料來源（標註來源屬於標註環節）
        return copy.deepcopy({k: v for k, v in config["source"].items() if k != "label_source"})
    image, tab = _image(config["kind"]), config.get("tabular") or {}
    hyper = config.get("hyperparameters") or {}
    if stage == "labels":
        if image:
            out = {"labels": config["image"]["labels"]}
            if config["source"]["type"] == "dicom":
                out["label_source"] = config["source"]["label_source"]
            return copy.deepcopy(out)
        return copy.deepcopy({"target": tab["target"], "features": tab["features"]})
    if stage == "preprocess":
        if image:
            return copy.deepcopy({"resize": config["image"]["resize"], "augmentation": config["augmentation"],
                                  "augmentation_copies": hyper.get("augmentation_copies")})
        return copy.deepcopy({"steps": tab["steps"], "missing": tab.get("missing")})
    out = {"split": config["split"], "seed": config["seed"],
           "hyperparameters": {k: v for k, v in hyper.items() if k != "augmentation_copies"}}
    if not image:
        out |= {"validation": config["validation"], "algorithm": tab["algorithm"]}
    return copy.deepcopy(out)


def merge_config(config: dict[str, Any], stage: str, values: dict[str, Any]) -> dict[str, Any]:
    """把環節的設定檔寫回完整的訓練設定（尚未正規化）。設定檔沒寫的鍵視為 null（用預設值）。"""
    out = copy.deepcopy(config)
    image = _image(out["kind"])
    hyper = out.setdefault("hyperparameters", {})
    if stage == "import":
        label_source = out["source"].get("label_source")
        out["source"] = {k: v for k, v in values.items() if k != "label_source"}
        if label_source is not None and out["source"].get("type") == "dicom":
            out["source"]["label_source"] = label_source
        return out
    if stage == "labels":
        if image:
            out["image"]["labels"] = values.get("labels")
            if out["source"]["type"] == "dicom":
                out["source"]["label_source"] = values.get("label_source")
        else:
            out["tabular"]["target"], out["tabular"]["features"] = values.get("target"), values.get("features")
    elif stage == "preprocess":
        if image:
            out["image"]["resize"] = values.get("resize", [32, 32])
            out["augmentation"] = values.get("augmentation")
            hyper.pop("augmentation_copies", None)
            if values.get("augmentation_copies") is not None:
                hyper["augmentation_copies"] = values["augmentation_copies"]
        else:
            out["tabular"]["steps"] = values.get("steps") or []
            out["tabular"].pop("missing", None)
            if values.get("missing") is not None:
                out["tabular"]["missing"] = values["missing"]
    else:
        kept = {k: v for k, v in hyper.items() if k == "augmentation_copies"}
        out["hyperparameters"] = {**dict(values.get("hyperparameters") or {}), **kept}
        out["split"], out["seed"] = values.get("split"), values.get("seed", 42)
        if not image:
            out["validation"] = values.get("validation")
            out["tabular"]["algorithm"] = values.get("algorithm")
    return out


# ---------------------------------------------------------------- 平台預設程式

def default_code(kind: str, stage: str) -> bytes:
    root = bundle.templates_dir()
    if stage == "train":
        return (root / f"{kind}.py").read_bytes()
    return (root / "stages" / f"{stage}_{'image' if _image(kind) else 'tabular'}.py").read_bytes()


def _canonical_code(data: bytes) -> bytes:
    """比較程式有沒有改過：換行統一成 \\n、去掉行尾空白與檔尾空行（網頁貼上、Windows 編輯器不算修改）。"""
    text = data.decode("utf-8", "replace").replace("\r\n", "\n").replace("\r", "\n")
    return ("\n".join(line.rstrip() for line in text.split("\n")).strip("\n") + "\n").encode("utf-8")


def code_changed(kind: str, stage: str, code: bytes) -> bool:
    return _canonical_code(code) != _canonical_code(default_code(kind, stage))


# ---------------------------------------------------------------- 匯出

def _readme(setting: TrainingSetting, stage: str) -> str:
    kind = setting.kind
    entry = ENTRYPOINTS[(stage, _image(kind))]
    funcs = "、".join(f"`{name}({', '.join(args)})`" for name, args in entry.items())
    return f"""# {setting.name}：{STAGE_NAMES[stage]}環節

由平台匯出（{cfg.KIND_NAMES[kind]}）。

| 檔案 | 說明 |
|---|---|
| `{config_name(stage)}` | 這個環節的設定（JSON），可修改 |
| `{code_name(stage)}` | 這個環節的程式，進入點 {funcs}，可修改 |
| `stage.json` | 描述檔（環節、訓練種類、各檔 sha256），請勿修改 |

## 修改後放回平台

1. 修改 `{config_name(stage)}` 或 `{code_name(stage)}`。
2. 整個資料夾重新壓成 zip。
3. 到平台「建模管理」→ 這份訓練設定的「流程程式碼」→「{STAGE_NAMES[stage]}」→「上傳環節檔」。
   也可以直接在網頁上「檢視程式碼」，貼上修改後的內容按「套用」。

套用後這個環節改由匯入的檔案控制，介面上的對應欄位會鎖定；要恢復請按「改回用介面設定」。
平台只接受訓練映像內有的套件（numpy、pandas、scikit-learn 等），不會安裝 requirements.txt。

## 在自己的電腦執行

請從平台下載整個流程（專案包），裡面有 `run_all.py` 與執行步驟。
"""


def stage_files(setting: TrainingSetting, stage: str, store: ObjectStore | None = None,
                session: Session | None = None) -> dict[str, bytes]:
    """環節目前的設定檔與程式檔：匯入控制時是匯入的版本，否則是介面設定與平台預設程式。"""
    if not has_code(stage):
        from app.training import flow_stages

        return flow_stages.current_files(session, store, setting, stage)
    row = get_override(session, setting.id, stage) if session is not None else None
    if row is not None and store is not None:
        files = override_files(store, row)
        return {config_name(stage): files[config_name(stage)], code_name(stage): files[code_name(stage)]}
    return {config_name(stage): _json(stage_config(setting.config, stage)),
            code_name(stage): default_code(setting.kind, stage)}


def descriptor(setting: TrainingSetting, stage: str, files: dict[str, bytes], *, actor: str) -> dict[str, Any]:
    return {"format_version": FORMAT_VERSION, "stage": stage, "kind": setting.kind,
            "platform_version": PLATFORM_VERSION, "config_version": cfg.CONFIG_VERSION,
            "exported_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "exported_by": actor,
            "project_id": setting.project_id, "setting": {"id": setting.id, "name": setting.name},
            "files": {name: _sha(body) for name, body in sorted(files.items())},
            "template_sha256": ({code_name(stage): _sha(default_code(setting.kind, stage))} if has_code(stage) else {})}


def stage_zip(setting: TrainingSetting, stage: str, files: dict[str, bytes], *, actor: str) -> bytes:
    body = dict(files)
    body["stage.json"] = _json(descriptor(setting, stage, files, actor=actor))
    body["README.md"] = _readme(setting, stage).encode("utf-8")
    return bundle.write_zip(body)


def export_stage(ctx: ProjectContext, state, setting: TrainingSetting, stage: str, *,
                 source_ip: str | None) -> bytes:
    check_stage(stage)
    files = stage_files(setting, stage, state.store, ctx.session)
    if has_code(stage):
        data = stage_zip(setting, stage, files, actor=ctx.user.username)
    else:
        from app.training import flow_stages

        data = flow_stages.stage_zip(setting, stage, files, actor=ctx.user.username)
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="flow.stage_export",
           target=f"training_setting:{setting.id}", source_ip=source_ip,
           detail={"project_id": setting.project_id, "stage": stage, "sha256": _sha(data),
                   "files": {n: _sha(b) for n, b in files.items()}})
    ctx.session.commit()
    return data


def stage_filename(setting: TrainingSetting, stage: str) -> str:
    return f"{_slug(setting.name)}-{stage}.zip"


def _slug(name: str) -> str:
    import re

    return re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or f"setting"


# ---------------------------------------------------------------- 檢核（不符合框架的全部列出）

def _call(errors: list[str], prefix: str, fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except cfg.ConfigError as exc:
        errors.append(f"{prefix}{exc}")
    except Exception as exc:  # noqa: BLE001  TabularError 等
        errors.append(f"{prefix}{exc}")
    return None


def check_values(config: dict[str, Any], stage: str, values: Any, fname: str) -> list[str]:
    """設定檔的值：只含本環節的鍵、通過現有的正規化函式。每個欄位各自檢查，錯誤全部列出。"""
    from tabular.modeling_config import TargetFeatureConfig
    from tabular.preprocess import validate_steps

    if not isinstance(values, dict):
        return [f"{fname} 必須是 JSON 物件"]
    errors: list[str] = []
    kind, image, p = config["kind"], _image(config["kind"]), f"{fname}："
    allowed = stage_keys(config, stage)
    for key in sorted(set(values) - set(allowed)):
        owner = KEY_STAGE.get(key)
        if owner and owner != stage:
            errors.append(f"{p}「{key}」屬於「{STAGE_NAMES[owner]}」環節，請在該環節的檔案修改")
        else:
            errors.append(f"{p}不支援的設定「{key}」（這個環節可用：{'、'.join(allowed)}）")
    if stage == "labels":
        if image:
            _call(errors, p, cfg.normalise_image, {"resize": config["image"]["resize"], "labels": values.get("labels")},
                  kind)
            if config["source"]["type"] == "dicom":
                _call(errors, p, cfg.normalise_source,
                      {"type": "dicom", "studies": "all", "label_source": values.get("label_source")}, kind)
        else:
            tab = config["tabular"]
            _call(errors, p, TargetFeatureConfig, values.get("target"), values.get("features"), tab.get("steps"),
                  tab.get("missing"))
    elif stage == "preprocess":
        if image:
            _call(errors, p, cfg.normalise_image,
                  {"resize": values.get("resize", [32, 32]), "labels": config["image"]["labels"]}, kind)
            _call(errors, p, cfg.normalise_augmentation, values.get("augmentation"))
            if values.get("augmentation_copies") is not None:
                title, typ, low, high, _ = cfg._IMAGE_HYPER["augmentation_copies"]
                _call(errors, p, cfg._number, values["augmentation_copies"], typ, title, low, high)
        else:
            steps = values.get("steps") or []
            if not isinstance(steps, list):
                errors.append(f"{p}steps 必須是清單")
            else:
                for i, step in enumerate(steps):
                    _call(errors, f"{p}第 {i + 1} 個步驟：", validate_steps, [step])
            if values.get("missing") not in (None, "impute", "drop"):
                errors.append(f"{p}missing 必須是 impute（補上缺值）、drop（不使用有缺值的病人）或 null")
    else:
        _call(errors, p, cfg.normalise_split, values.get("split"))
        _call(errors, p, cfg._number, values.get("seed", 42), int, "亂數種子", 0, 2**31 - 1)
        hyper = values.get("hyperparameters")
        if image:
            if isinstance(hyper, dict) and "augmentation_copies" in hyper:
                errors.append(f"{p}「augmentation_copies」屬於「{STAGE_NAMES['preprocess']}」環節，請在該環節的檔案修改")
                hyper = {k: v for k, v in hyper.items() if k != "augmentation_copies"}
            allowed_hyper = {k: v for k, v in cfg.HYPERPARAMETERS[kind].items() if k != "augmentation_copies"}
            _call(errors, p, cfg.normalise_hyperparameters, hyper, allowed_hyper, fill=False)
        else:
            _call(errors, p, cfg.normalise_validation, values.get("validation"))
            algorithms = cfg.ALGORITHMS[kind]
            algorithm = values.get("algorithm") or next(iter(algorithms))
            if algorithm not in algorithms:
                errors.append(f"{p}{cfg.KIND_NAMES[kind]}可用的演算法：{'、'.join(algorithms)}")
            else:
                _call(errors, p, cfg.normalise_hyperparameters, hyper, algorithms[algorithm], fill=False)
    return errors


def _parse_json(data: bytes, fname: str, errors: list[str]) -> Any:
    try:
        return json.loads(data.decode("utf-8-sig"))
    except UnicodeDecodeError:
        errors.append(f"{fname} 不是 UTF-8 文字檔")
    except json.JSONDecodeError as exc:
        errors.append(f"{fname} 不是合法的 JSON（第 {exc.lineno} 行）：{exc.msg}")
    return None


def _same_function(a: ast.FunctionDef, b: ast.FunctionDef) -> bool:
    def body(node: ast.FunctionDef) -> str:
        stmts = node.body
        if stmts and isinstance(stmts[0], ast.Expr) and isinstance(getattr(stmts[0], "value", None), ast.Constant) \
                and isinstance(stmts[0].value.value, str):
            stmts = stmts[1:]      # 說明文字不算
        return ast.dump(ast.Module(body=stmts, type_ignores=[])) + ast.dump(node.args)
    return body(a) == body(b)


def check_code(kind: str, stage: str, code: bytes) -> list[str]:
    """程式檔：語法正確、有規定的進入點與參數個數、import 的套件在訓練映像內。只解析，不執行。"""
    fname = code_name(stage)
    try:
        text = code.decode("utf-8-sig")
    except UnicodeDecodeError:
        return [f"{fname} 不是 UTF-8 文字檔"]
    try:
        tree = ast.parse(text, filename=fname)
        compile(tree, fname, "exec")
    except SyntaxError as exc:
        return [f"{fname} 第 {exc.lineno} 行語法錯誤：{exc.msg}"]
    errors: list[str] = []
    functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
    for name, args in ENTRYPOINTS[(stage, _image(kind))].items():
        node = functions.get(name)
        if node is None:
            errors.append(f"{fname} 缺少函式 {name}({', '.join(args)})")
        elif len(node.args.posonlyargs) + len(node.args.args) != len(args):
            errors.append(f"{fname} 第 {node.lineno} 行：{name} 的參數必須是 ({', '.join(args)})")
    stdlib = set(sys.stdlib_module_names)
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                errors.append(f"{fname} 第 {node.lineno} 行：不支援相對 import，請直接 import 模組名稱")
                continue
            names = [node.module or ""]
        for name in names:
            top = name.split(".")[0]
            if top not in stdlib and top not in ALLOWED_IMPORTS:
                errors.append(f"{fname} 第 {node.lineno} 行 import 了平台沒有的套件「{top}」；"
                              "平台不會安裝 requirements.txt 內的套件")
    if stage == "train" and not any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "main"
            and isinstance(n.func.value, ast.Name) and n.func.value.id == "runtime" for n in ast.walk(tree)):
        errors.append("train.py 必須在檔尾以 raise SystemExit(runtime.main(train)) 執行訓練")
    if stage == "preprocess" and _image(kind) and "prepare_image" in functions:
        base = ast.parse(default_code(kind, stage).decode("utf-8"))
        original = next(n for n in base.body if isinstance(n, ast.FunctionDef) and n.name == "prepare_image")
        if not _same_function(functions["prepare_image"], original):
            errors.append("preprocess.py 的 prepare_image 不能修改（推論時用平台版本），請只修改 augment_training_set")
    return errors


def check_stage_files(ctx: ProjectContext, state, setting: TrainingSetting, stage: str,
                      files: dict[str, bytes]) -> tuple[list[str], dict[str, Any] | None, dict[str, Any] | None]:
    """回傳（錯誤, 環節設定檔的內容, 合併後正規化的完整設定）。"""
    errors: list[str] = []
    cname, pname = config_name(stage), code_name(stage)
    values = None
    for name in (cname, pname):
        if name not in files:
            errors.append(f"缺少 {name}")
    if cname in files:
        values = _parse_json(files[cname], cname, errors)
        if values is not None:
            errors += check_values(setting.config, stage, values, cname)
    if pname in files:
        errors += check_code(setting.kind, stage, files[pname])
    if errors:
        return errors, values, None
    merged = merge_config(setting.config, stage, values)
    try:
        normal = cfg.normalise(merged)
    except cfg.ConfigError as exc:
        return [f"與其他環節合併後：{exc}"], values, None
    changed = code_changed(setting.kind, stage, files[pname])
    problem = field_problem(ctx.session, state, setting.project_id, normal,
                            custom={**custom_stages(ctx.session, setting.id), stage: changed})
    if problem:
        return [f"與其他環節合併後：{problem}"], values, None
    return [], values, normal


def field_problem(session: Session, state, project_id: int, config: dict[str, Any],
                  custom: dict[str, bool]) -> str | None:
    """結構式：用資料集檢查合併後的 Target、Feature 在前處理後的欄位內（平台預設程式；API 內不執行使用者程式）。
    標註或前處理用了自訂程式時，欄位可能由程式產生，留到訓練時檢查。"""
    if config["kind"] not in cfg.TABULAR_KINDS or custom.get("labels") or custom.get("preprocess"):
        return None
    from app.tabular_api.models import TabularDataset
    from app.tabular_api.service import frame_cache
    from app.training.service import Invalid, check_tabular_frame

    ds = session.get(TabularDataset, config["source"]["dataset_id"])
    if ds is None or ds.project_id != project_id:
        return f"找不到結構式資料集 {config['source']['dataset_id']}"
    try:
        frame = frame_cache(state).load(ds)
    except ObjectNotFound:
        return f"資料集「{ds.name}」的檔案已不存在"
    try:
        check_tabular_frame(frame, config)
    except Invalid as exc:
        return str(exc)
    return None


# ---------------------------------------------------------------- 匯入控制（鎖定）

def get_override(session: Session, setting_id: int, stage: str) -> StageOverride | None:
    return session.scalar(select(StageOverride).where(StageOverride.setting_id == setting_id,
                                                      StageOverride.stage == stage))


def list_overrides(session: Session, setting_id: int) -> list[StageOverride]:
    return list(session.scalars(select(StageOverride).where(StageOverride.setting_id == setting_id)
                                .order_by(StageOverride.id)))


def locked_by_setting(session: Session, project_id: int) -> dict[int, list[str]]:
    """專案內各訓練設定由匯入檔控制的環節（訓練設定清單的標籤用）。"""
    out: dict[int, list[str]] = {}
    for row in session.scalars(select(StageOverride).where(StageOverride.project_id == project_id)):
        out.setdefault(row.setting_id, []).append(row.stage)
    order = list(STAGE_NAMES)
    return {sid: sorted(names, key=order.index) for sid, names in out.items()}


def custom_stages(session: Session, setting_id: int) -> dict[str, bool]:
    """環節 → 程式是否與平台預設不同（只列匯入控制的環節）。"""
    return {row.stage: row.code_changed for row in list_overrides(session, setting_id)}


def override_files(store: ObjectStore, row: StageOverride) -> dict[str, bytes]:
    files = bundle.read_zip(store.get(row.files_key), "stage.json")
    return files


def overrides_out(rows: list[StageOverride]) -> dict[str, dict[str, Any]]:
    from app.training.service import _iso

    return {row.stage: {"stage": row.stage, "name": STAGE_NAMES[row.stage], "sha256": row.sha256,
                        "files": row.files, "code_changed": row.code_changed, "imported_by": row.imported_by,
                        "imported_at": _iso(row.imported_at)} for row in rows}


def setting_problem(session: Session, state, setting: TrainingSetting) -> str | None:
    """整份設定重新檢核（任一環節匯入或改回後）：有問題時匯入控制的環節標示「需要處理」，不能送出訓練。"""
    custom = custom_stages(session, setting.id)
    if not custom:
        return None
    try:
        normal = cfg.normalise(setting.config)
    except cfg.ConfigError as exc:
        return str(exc)
    return field_problem(session, state, setting.project_id, normal, custom)


def overview(session: Session, state, setting: TrainingSetting) -> dict[str, Any]:
    rows = list_overrides(session, setting.id)
    locked = overrides_out(rows)
    problem = setting_problem(session, state, setting) if rows else None
    from app.training import flow_stages

    stages = []
    for stage in ALL_STAGES:
        code = has_code(stage)
        entry = {"stage": stage, "name": STAGE_NAMES[stage], "code": code,
                 "files": [config_name(stage), code_name(stage)] if code else flow_stages.file_names(setting, stage),
                 "entrypoints": ({k: list(v) for k, v in ENTRYPOINTS[(stage, _image(setting.kind))].items()}
                                 if code else {}),
                 "locked": locked.get(stage), "problem": problem if stage in locked and stage != "deploy" else None}
        stages.append(entry)
    return {"setting_id": setting.id, "kind": setting.kind, "stages": stages, "problem": problem,
            "locked": sorted(locked, key=list(STAGE_NAMES).index)}


def stage_view(session: Session, state, setting: TrainingSetting, stage: str) -> dict[str, Any]:
    """「檢視程式碼」：設定檔與程式檔的文字內容。"""
    check_stage(stage)
    files = stage_files(setting, stage, state.store, session)
    row = get_override(session, setting.id, stage)
    return {"setting_id": setting.id, "stage": stage, "name": STAGE_NAMES[stage], "kind": setting.kind,
            "files": {name: body.decode("utf-8", "replace") for name, body in files.items()},
            "default_code": default_code(setting.kind, stage).decode("utf-8") if has_code(stage) else "",
            "code": has_code(stage), "locked": overrides_out([row])[stage] if row else None}


def files_key(setting: TrainingSetting, stage: str, digest: str) -> str:
    return f"projects/{setting.project_id}/training/stages/{setting.id}/{stage}/{digest}.zip"


def _fail(ctx: ProjectContext, setting: TrainingSetting, stage: str, data: bytes, errors: list[str],
          source_ip: str | None) -> None:
    ctx.session.rollback()
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="flow.stage_import",
           target=f"training_setting:{setting.id}", result="failure", source_ip=source_ip,
           detail={"project_id": setting.project_id, "stage": stage, "sha256": _sha(data),
                   "errors": errors[:MAX_ERRORS]})
    ctx.session.commit()


def read_stage_zip(setting: TrainingSetting, stage: str, data: bytes) -> dict[str, bytes]:
    """環節檔 zip 的結構與描述檔（不符合時丟 StageInvalid）。"""
    try:
        files = bundle.read_zip(data, "stage.json")
    except bundle.SourceError as exc:
        raise StageInvalid([str(exc)]) from None
    if "stage.json" not in files:
        raise StageInvalid(["缺少 stage.json，這不是平台匯出的環節檔"])
    errors: list[str] = []
    meta = _parse_json(files["stage.json"], "stage.json", errors)
    if errors:
        raise StageInvalid(errors)
    if not isinstance(meta, dict):
        raise StageInvalid(["stage.json 必須是 JSON 物件"])
    version = meta.get("format_version")
    if version != FORMAT_VERSION:
        hint = "，請用新版的平台匯入" if isinstance(version, int) and version > FORMAT_VERSION else ""
        raise StageInvalid([f"不支援的格式版本 {version}（平台支援 {FORMAT_VERSION}）{hint}"])
    if meta.get("stage") != stage:
        other = STAGE_NAMES.get(str(meta.get("stage")), str(meta.get("stage")))
        raise StageInvalid([f"這個檔案是「{other}」環節，請到「{other}」匯入"])
    if meta.get("kind") != setting.kind:
        a = cfg.KIND_NAMES.get(str(meta.get("kind")), str(meta.get("kind")))
        raise StageInvalid([f"檔案的訓練種類是「{a}」，這份訓練設定是「{cfg.KIND_NAMES[setting.kind]}」，不能匯入"])
    if not has_code(stage):        # 資料匯入、部署：設定檔（load_data.py、predict.py 只供地端，套用時略過）
        return {name: body for name, body in files.items() if name not in ("stage.json", "README.md")}
    return {name: body for name, body in files.items() if name in (config_name(stage), code_name(stage))}


def apply_stage(ctx: ProjectContext, state, setting: TrainingSetting, stage: str, files: dict[str, bytes], *,
                source_ip: str | None, upload: bytes | None = None) -> StageOverride:
    """套用環節檔（網頁編輯後的文字，或上傳的 zip 內容）。符合框架才寫入，否則列出全部錯誤並留失敗稽核。
    套用後這個環節由匯入的檔案控制；再次套用時覆寫，config_before 保留第一次匯入前的設定。"""
    check_stage(stage)
    if not has_code(stage):
        from app.training import flow_stages

        apply = flow_stages.apply_import if stage == "import" else flow_stages.apply_deploy
        return apply(ctx, state, setting, files, source_ip=source_ip, upload=upload)
    files = {config_name(stage): files.get(config_name(stage)), code_name(stage): files.get(code_name(stage))}
    files = {k: v for k, v in files.items() if v is not None}
    errors, _, normal = check_stage_files(ctx, state, setting, stage, files)
    raw = upload if upload is not None else b"".join(files.values())
    if errors:
        _fail(ctx, setting, stage, raw, errors, source_ip)
        raise StageInvalid(errors)
    stored = stage_zip(setting, stage, files, actor=ctx.user.username)
    digest = _sha(stored)
    key = files_key(setting, stage, digest)
    state.store.put(key, stored)
    changed = code_changed(setting.kind, stage, files[code_name(stage)])
    row = get_override(ctx.session, setting.id, stage)
    old_key = row.files_key if row is not None else None
    if row is None:
        before = stage_config(setting.config, stage)
        row = StageOverride(project_id=setting.project_id, setting_id=setting.id, stage=stage,
                            config_before=before, imported_by=ctx.user.username)
        ctx.session.add(row)
    row.files_key, row.sha256, row.code_changed = key, digest, changed
    row.files = {name: _sha(body) for name, body in sorted(files.items())}
    row.imported_by, row.imported_at = ctx.user.username, utcnow()
    setting.config, setting.updated_by = normal, ctx.user.username
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="flow.stage_import",
           target=f"training_setting:{setting.id}", source_ip=source_ip,
           detail={"project_id": setting.project_id, "stage": stage, "sha256": digest, "files": row.files,
                   "code_changed": changed, "config_before_sha256": _sha(_json(row.config_before)),
                   "via": "upload" if upload is not None else "editor"})
    ctx.session.commit()
    if old_key and old_key != key:
        _delete(state.store, old_key)
    return row


def _delete(store: ObjectStore, key: str) -> None:
    try:
        store.delete(key)
    except ObjectNotFound:
        pass


def unlock_stage(ctx: ProjectContext, state, setting: TrainingSetting, stage: str, *,
                 source_ip: str | None) -> TrainingSetting:
    """改回用介面設定：刪除匯入檔（稽核留 sha256），這個環節的設定還原成匯入前的內容。"""
    check_stage(stage)
    row = get_override(ctx.session, setting.id, stage)
    if row is None:
        raise StageConflict(f"「{STAGE_NAMES[stage]}」環節目前不是由匯入的檔案控制")
    if stage == "deploy":
        from app.training import flow_stages

        flow_stages.unlock_deploy(ctx, state, setting, row, source_ip=source_ip)
        return setting
    try:
        normal = cfg.normalise(merge_config(setting.config, stage, row.config_before))
    except cfg.ConfigError as exc:
        raise StageConflict(f"還原匯入前的設定後不合法：{exc}。請先處理其他環節再改回") from exc
    setting.config, setting.updated_by = normal, ctx.user.username
    key, digest = row.files_key, row.sha256
    ctx.session.delete(row)
    record(ctx.session, actor=ctx.user.username, category=AuditCategory.TRAINING, action="flow.stage_unlock",
           target=f"training_setting:{setting.id}", source_ip=source_ip,
           detail={"project_id": setting.project_id, "stage": stage, "deleted_sha256": digest,
                   "config_sha256": _sha(_json(stage_config(normal, stage)))})
    ctx.session.commit()
    _delete(state.store, key)
    return setting


def locked_changes(session: Session, setting: TrainingSetting, new: dict[str, Any]) -> list[str]:
    """介面儲存設定時：匯入控制的環節不能改。回傳被改到的環節名稱。"""
    out = []
    for row in list_overrides(session, setting.id):
        if new.get("kind") != setting.config.get("kind"):
            return [STAGE_NAMES[row.stage]]
        if row.stage != "deploy" and stage_config(new, row.stage) != stage_config(setting.config, row.stage):
            out.append(STAGE_NAMES[row.stage])
    return out


def delete_files(session: Session, store: ObjectStore, setting_id: int) -> None:
    """刪除訓練設定時一併刪除匯入檔。"""
    from app.training.models import DeploymentStageOverride

    for row in list_overrides(session, setting_id):
        _delete(store, row.files_key)
        session.delete(row)
    for lock in session.scalars(select(DeploymentStageOverride)):
        if (lock.config_before or {}).get("setting_id") == setting_id:
            session.delete(lock)


# ---------------------------------------------------------------- 送出訓練：組合原始碼

def compose_source(session: Session, store: ObjectStore, setting: TrainingSetting) -> tuple[bytes | None, dict]:
    """送出訓練時，把平台範本與匯入控制環節的程式組成一份原始碼 zip（以 executor=source 執行）。
    程式都沒改過（只改參數）時回傳 None：用平台範本執行，設定已在訓練設定內。"""
    rows = list_overrides(session, setting.id)
    used = {row.stage: {"sha256": row.sha256, "code_changed": row.code_changed} for row in rows
            if row.stage != "deploy"}            # 部署與這次訓練無關
    code_rows = [row for row in rows if row.code_changed and row.stage in STAGES]
    if not code_rows:
        return None, used
    root = bundle.templates_dir()
    files = {"train.py": default_code(setting.kind, "train")}
    for name in bundle.HELPERS[setting.kind in cfg.IMAGE_KINDS]:
        files[name] = (root / name).read_bytes()          # 共用模組一律用平台目前的版本
    for row in code_rows:
        files[code_name(row.stage)] = override_files(store, row)[code_name(row.stage)]
    return bundle.write_zip(files), used
