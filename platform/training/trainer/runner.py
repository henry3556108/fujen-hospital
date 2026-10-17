"""Job 容器的進入點：下載資料包 → 執行範本或使用者原始碼 → 上傳產出 → 回報結果。

容器只拿到三個值（環境變數）：
  JOB_IO_URL     平台 API 的工作 I/O 位址（只對應這一次訓練）
  JOB_IO_TOKEN   這一次訓練的一次性 token：只能下載自己的資料包、上傳自己的產出，訓練結束即失效
  RUN_ID         訓練編號（只用於紀錄）

訓練程式在子程序執行，環境變數全部清掉再補上必要的幾個，所以使用者修改的程式連 token 都拿不到。
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import httpx

PACKAGE = Path(__file__).resolve().parent
TEMPLATES = PACKAGE / "templates"
UPLOADS = ("model.h5", "model.pkl", "preprocess.pkl", "metrics.json", "splits.json", "model_card.json",
           "charts.json")
# 子程序可以看到的環境變數：只有執行 Python 所需的
PASS_THROUGH = ("PATH", "LANG", "LC_ALL", "TRAIN_THREADS", "TF_CPP_MIN_LOG_LEVEL", "CUDA_VISIBLE_DEVICES",
                "LD_LIBRARY_PATH", "NVIDIA_VISIBLE_DEVICES", "KERAS_BACKEND", "TF_FORCE_GPU_ALLOW_GROWTH",
                "CUBLAS_WORKSPACE_CONFIG")


class JobIO:
    def __init__(self, http: httpx.Client, url: str, token: str):
        self.http, self.url, self.headers = http, url.rstrip("/"), {"X-Job-Token": token}

    def bundle(self) -> bytes:
        response = self.http.get(f"{self.url}/bundle", headers=self.headers)
        response.raise_for_status()
        return response.content

    def upload(self, name: str, data: bytes) -> None:
        self.http.put(f"{self.url}/artifacts/{name}", headers=self.headers, content=data).raise_for_status()

    def complete(self, status: str, message: str = "") -> None:
        self.http.post(f"{self.url}/complete", headers=self.headers,
                       json={"status": status, "message": clip(message)}).raise_for_status()


def clean_env(workdir: Path) -> dict[str, str]:
    env = {k: os.environ[k] for k in PASS_THROUGH if k in os.environ}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    env |= {"HOME": str(workdir), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
            "PYTHONIOENCODING": "utf-8", "MPLCONFIGDIR": str(workdir)}
    return env


def extract(data: bytes, workdir: Path) -> None:
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall(workdir, filter="data")     # 拒絕絕對路徑、跳出目錄、裝置檔、連結


def entrypoint(config: dict, workdir: Path, templates: Path = TEMPLATES) -> tuple[Path, Path]:
    """回傳（要執行的程式, 工作目錄）。"""
    executor = config.get("executor", "template")
    if executor == "source":
        source = workdir / "source"
        if not (source / "train.py").is_file():
            raise RuntimeError("資料包內沒有使用者原始碼 source/train.py")
        return source / "train.py", source
    if executor == "fake":
        return PACKAGE / "fake_trainer.py", workdir
    local = workdir / "template"
    shutil.copytree(templates, local, ignore=shutil.ignore_patterns("__pycache__"), dirs_exist_ok=True)
    script = local / f"{config['kind']}.py"
    if not script.is_file():
        raise RuntimeError(f"沒有 {config['kind']} 的訓練範本")
    return script, local


def _tail(text: str, lines: int = 12) -> str:
    return "\n".join(text.strip().splitlines()[-lines:])


DETAILS = "\n---\n"      # 訊息格式：第一段是給使用者看的原因，分隔線後是技術細節（網頁收合顯示）
_EXCEPTION = re.compile(r"^(?:[\w.]+\.)?(\w*(?:Error|Exception)): (.+)$")


def clip(message: str, limit: int = 1000) -> str:
    """平台只存 1000 字左右：保留開頭的原因，技術細節只留最後一段。"""
    if len(message) <= limit:
        return message
    reason, sep, details = message.partition(DETAILS)
    if not sep:
        return message[-limit:]
    reason = reason[:limit // 2]
    return reason + sep + details[-(limit - len(reason) - len(sep)):]


def failure_message(code: int, log: str) -> str:
    """訓練程式失敗：從輸出找出最後一個例外訊息當作原因（範本的錯誤都是繁體中文），堆疊放在技術細節。"""
    reason = ""
    for line in reversed(log.strip().splitlines()):
        match = _EXCEPTION.match(line.strip())
        if match:
            reason = match.group(2).strip()
            break
    if code == 124:
        reason = reason or "訓練超過時限，請減少資料量、樹的數量或訓練回合數後再試"
    reason = reason or "訓練程式發生錯誤，請展開技術細節或檢視訓練輸出"
    return f"{reason}{DETAILS}訓練程式以 {code} 結束：\n{_tail(log)}"


def mark_deployable(out: Path) -> None:
    """使用者程式（修改後的原始碼、匯入的環節程式）產生的模型：檢查能不能在平台推論或部署，寫進模型卡。
    平台範本產生的模型不檢查（模型卡與原本相同）。檢查用限制類別的 Unpickler，被擋下的類別不會被建立。"""
    from trainer.predict import model_check

    path = out / "model_card.json"
    try:
        card = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return
    if isinstance(card, dict):
        card.update(model_check(out))
        path.write_text(json.dumps(card, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def run_job(io_: JobIO, workdir: Path, *, python: str = sys.executable, templates: Path = TEMPLATES,
            timeout: float | None = None) -> int:
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    log = ""
    try:
        extract(io_.bundle(), workdir)
        config = json.loads((workdir / "config.json").read_text(encoding="utf-8"))
        script, cwd = entrypoint(config, workdir, templates)
        out = workdir / "out"
        out.mkdir(exist_ok=True)
        try:
            done = subprocess.run(
                [python, str(script), "--config", str(workdir / "config.json"), "--data", str(workdir / "dataset"),
                 "--out", str(out)], cwd=cwd, env=clean_env(workdir), stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, timeout=timeout, text=True, encoding="utf-8", errors="replace")
            log, code = done.stdout, done.returncode
        except subprocess.TimeoutExpired as exc:
            log, code = (exc.stdout or "") + f"\n訓練超過時限 {timeout} 秒", 124
        if (out / "train.log").is_file():            # 範本自己寫的紀錄放前面
            log = (out / "train.log").read_text(encoding="utf-8", errors="replace") + log
        io_.upload("train.log", log.encode("utf-8"))
        if code != 0:
            io_.complete("failed", failure_message(code, log))
            return 1
        missing = [n for n in ("model_card.json",) if not (out / n).is_file()]
        if missing or not any((out / n).is_file() for n in ("model.h5", "model.pkl")):
            io_.complete("failed", "訓練程式結束，但沒有寫出模型（model.h5 或 model.pkl）與 model_card.json")
            return 1
        if config.get("executor") == "source":
            mark_deployable(out)
        for name in UPLOADS:
            if (out / name).is_file():
                io_.upload(name, (out / name).read_bytes())
        io_.complete("succeeded")
        return 0
    except Exception as exc:  # noqa: BLE001  任何錯誤都要回報，否則平台只看得到「工作失敗」
        try:
            io_.complete("failed", f"{type(exc).__name__}: {exc}\n{_tail(log)}")
        except Exception:  # noqa: BLE001
            pass
        print(f"runner 失敗：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


def main() -> int:
    url, token = os.environ.get("JOB_IO_URL"), os.environ.get("JOB_IO_TOKEN")
    if not url or not token:
        print("缺少 JOB_IO_URL 或 JOB_IO_TOKEN", file=sys.stderr)
        return 2
    workdir = Path(os.environ.get("JOB_WORKDIR", "/work"))
    timeout = float(os.environ["JOB_TIMEOUT_SECONDS"]) if os.environ.get("JOB_TIMEOUT_SECONDS") else None
    with httpx.Client(timeout=httpx.Timeout(300.0, connect=30.0),
                      transport=httpx.HTTPTransport(retries=5)) as http:
        return run_job(JobIO(http, url, token), workdir, timeout=timeout)


if __name__ == "__main__":
    raise SystemExit(main())
