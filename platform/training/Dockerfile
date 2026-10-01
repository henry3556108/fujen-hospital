# platform-trainer：訓練 Job（python -m trainer.runner）與推論服務（uvicorn trainer.serve:app）共用的映像。
# Build context 是 platform/（需要 libs/tabular）：
#   docker build -f training/Dockerfile -t platform-trainer:dev platform/
#
# 兩階段：建置階段用 uv 安裝鎖定的套件（含 TensorFlow CPU）；最終映像只有 Python 執行環境與 .venv，
# 不含 uv、pip 與套件快取，並在建置時套用 Debian 已發布的安全更新（漏洞掃描見 platform/compliance）。
FROM python:3.12-slim-trixie AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1
COPY libs/tabular /libs/tabular
COPY training/pyproject.toml training/uv.lock training/README.md ./
RUN uv sync --frozen --no-dev --no-editable --extra keras --no-install-project
COPY training/trainer ./trainer
RUN uv sync --frozen --no-dev --no-editable --extra keras

FROM python:3.12-slim-trixie
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
 && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && python -m pip uninstall -y -q pip && rm -rf /root/.cache \
 && useradd --uid 10001 --no-create-home app && mkdir -p /work && chown app /work
WORKDIR /app
ENV TF_CPP_MIN_LOG_LEVEL=2 CUDA_VISIBLE_DEVICES=""
COPY --from=build /app/.venv /app/.venv
COPY training/trainer ./trainer
ENV PATH=/app/.venv/bin:$PATH
USER app
WORKDIR /work
CMD ["python", "-m", "trainer.runner"]
