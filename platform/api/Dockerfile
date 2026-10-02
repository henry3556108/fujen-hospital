# Build context 是 platform/（需要 libs/tabular）：
#   docker build -f api/Dockerfile platform/    或    docker compose build api
#
# 兩階段：建置階段用 uv 安裝鎖定的套件；最終映像只有 Python 執行環境、.venv 與程式，
# 不含 uv、pip 與套件快取，並在建置時套用 Debian 已發布的安全更新（漏洞掃描見 platform/compliance）。
FROM python:3.12-slim-trixie AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1
# pyproject 以 ../libs/tabular 路徑相依；映像內以一般（非 editable）方式安裝進 .venv
COPY libs/tabular /libs/tabular
COPY api/pyproject.toml api/uv.lock ./
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.12-slim-trixie
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
 && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && python -m pip uninstall -y -q pip && rm -rf /root/.cache \
 && useradd --uid 10001 --no-create-home app && mkdir -p /data/objects && chown app /data/objects
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY api/app ./app
# WP5b：匯出訓練原始碼時打包的範本
COPY training/trainer/templates /app/training-templates
ENV TRAINING_TEMPLATES_DIR=/app/training-templates
USER app
CMD ["/app/.venv/bin/uvicorn", "app.asgi:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
