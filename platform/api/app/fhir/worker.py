"""排程 worker：python -m app.fhir.worker

環境變數：DATABASE_URL、FHIR_URL（必填）；FHIR_WORKER_POLL_SECONDS（預設 5）。
"""
import logging
import os
import signal
import threading

from app.db import make_engine, make_sessionmaker
from app.fhir import scheduler
from app.fhir.client import fhir_from_env
from app.models import Base

log = logging.getLogger("fhir.worker")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    client = fhir_from_env()
    if client is None or not os.environ.get("DATABASE_URL"):
        log.error("缺少環境變數 FHIR_URL 或 DATABASE_URL")
        return 2
    import app.main  # noqa: F401  載入所有資料表定義
    engine = make_engine(os.environ["DATABASE_URL"])
    Base.metadata.create_all(engine)
    make_session = make_sessionmaker(engine)
    poll = float(os.environ.get("FHIR_WORKER_POLL_SECONDS", "5"))
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    log.info("排程 worker 啟動，每 %.0f 秒檢查一次", poll)
    while not stop.is_set():
        try:
            for run_id in scheduler.run_due(make_session, client):
                log.info("排程執行完成 run_id=%s", run_id)
        except Exception:   # 資料庫或 FHIR 暫時連不上：記錄後下一輪再試
            log.exception("排程檢查失敗")
        stop.wait(poll)
    log.info("排程 worker 結束")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
