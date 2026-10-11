"""安裝時準備預設模型：依清單登記白名單 → 申請下載 → 核准 → 下載（線上或離線預載）→ 設定並載入。可重複執行。

  python -m app.llm.model_setup /opt/llm-models.json [--token hf_xxx] [--no-load]

清單（JSON 陣列）每項：name、source、repo、revision、sha256、files、license、requires_token、note、
load（quantization、cpu、memory_gb、gpu_type、gpu_count）。sha256 是審核時以 /api/admin/llm/whitelist/inspect
取得的值；來源內容若與登記的不同，下載會被拒絕。所有步驟都以 actor（預設 system-setup）寫進稽核。
"""
import argparse
import json
import sys
from pathlib import Path

from sqlalchemy import select

from app.llm import registry
from app.llm.errors import LlmServiceError
from app.llm.models import InstalledModel, ModelDownload, ModelWhitelist

LOAD_KEYS = ("quantization", "cpu", "memory_gb", "gpu_type", "gpu_count")


def setup_model(session, services, spec: dict, *, actor: str, token: str | None, load: bool) -> str:
    name = spec["name"]
    if session.scalar(select(ModelWhitelist).where(ModelWhitelist.name == name)) is None:
        registry.add_whitelist(session, actor=actor, source_ip=None, name=name, source=spec["source"],
                               repo=spec["repo"], revision=spec["revision"], sha256=spec["sha256"],
                               license=spec.get("license", ""), requires_token=spec.get("requires_token", False),
                               has_remote_code=spec.get("has_remote_code", False), note=spec.get("note", ""),
                               files=spec.get("files", []))
    if session.scalar(select(InstalledModel).where(InstalledModel.name == name)) is None:
        download = session.scalar(select(ModelDownload).where(
            ModelDownload.name == name, ModelDownload.status.in_(("pending", "approved", "downloading"))))
        if download is None:
            download = registry.request_download(session, actor=actor, source_ip=None, project_id=None, name=name)
        if download.status == "pending":
            registry.review_download(session, actor=actor, source_ip=None, download_id=download.id, approve=True,
                                     reason="安裝時預載")
        services.session_factory = None        # 命令列：等下載完成
        download = registry.execute_download(session, services=services, actor=actor, is_admin=True,
                                             source_ip=None, download_id=download.id, token=token)
        print(f"{name}：下載完成（{download.mode}，commit {download.commit[:12]}）", flush=True)
    if load and spec.get("load"):
        registry.put_load_config(session, actor=actor, source_ip=None, name=name,
                                 **{k: spec["load"][k] for k in LOAD_KEYS})
        result = registry.load_model(session, runtime=services.runtime, actor=actor, source_ip=None, name=name)
        runtime = result.get("runtime") or {}
        print(f"{name}：已載入（{runtime.get('quantization_level') or runtime.get('quantization')}，"
              f"{runtime.get('processor')}）", flush=True)
    return name


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="依清單準備預設模型（白名單、下載、載入）")
    parser.add_argument("config", type=Path)
    parser.add_argument("--token", default=None, help="Hugging Face Token（需要授權的模型才要）")
    parser.add_argument("--actor", default="system-setup")
    parser.add_argument("--no-load", action="store_true")
    args = parser.parse_args(argv)

    from types import SimpleNamespace

    import app.main  # noqa: F401  載入所有資料表定義
    from app.db import make_engine, make_sessionmaker
    from app.llm.services import services_from_env
    from app.settings import Settings
    sessions = make_sessionmaker(make_engine(Settings.from_env().database_url))
    services = services_from_env(SimpleNamespace(state=SimpleNamespace(sessionmaker=sessions)))
    specs = json.loads(args.config.read_text())
    failed = 0
    with sessions() as session:
        for spec in specs:
            try:
                setup_model(session, services, spec, actor=args.actor, token=args.token, load=not args.no_load)
            except LlmServiceError as exc:
                failed += 1
                session.rollback()
                print(f"{spec.get('name')}：失敗：{exc}", file=sys.stderr, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
