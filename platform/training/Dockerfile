# platform-trainer：訓練 Job（python -m trainer.runner）與推論服務（uvicorn trainer.serve:app）共用的映像。
# Build context 是 platform/（需要 libs/tabular）：
#   docker build -f training/Dockerfile -t platform-trainer:dev platform/
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy TF_CPP_MIN_LOG_LEVEL=2 CUDA_VISIBLE_DEVICES=""
COPY libs/tabular /libs/tabular
COPY training/pyproject.toml training/uv.lock training/README.md ./
RUN uv sync --frozen --no-dev --no-editable --extra keras --no-install-project
COPY training/trainer ./trainer
RUN uv sync --frozen --no-dev --no-editable --extra keras \
 && useradd --uid 10001 --no-create-home app && mkdir -p /work && chown app /work
ENV PATH=/app/.venv/bin:$PATH
USER app
WORKDIR /work
CMD ["python", "-m", "trainer.runner"]
