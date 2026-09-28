# Build context 是 platform/（需要 libs/tabular）：
#   docker build -f api/Dockerfile platform/    或    docker compose build api
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
# pyproject 以 ../libs/tabular 路徑相依；映像內以一般（非 editable）方式安裝進 .venv
COPY libs/tabular /libs/tabular
COPY api/pyproject.toml api/uv.lock ./
RUN uv sync --frozen --no-dev --no-editable
COPY api/app ./app
RUN useradd --uid 10001 --no-create-home app && mkdir -p /data/objects && chown app /data/objects
USER app
CMD ["/app/.venv/bin/uvicorn", "app.asgi:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
