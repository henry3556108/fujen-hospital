# platform-autolabel：MONAI Label 轉接服務（自動標註規格 1.0）。平台 API 的 AUTOLABEL_URL 指向它。
#   docker build -t platform-autolabel:dev platform/autolabel/adapter
#
# 兩階段（與 platform/api 相同）：uv 安裝鎖定的套件；最終映像只有 Python、.venv 與程式，
# 不含 uv、pip 與套件快取，並套用建置時 Debian 已發布的安全更新。
FROM python:3.12-slim-trixie AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.12-slim-trixie
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
 && apt-get clean && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && python -m pip uninstall -y -q pip && rm -rf /root/.cache \
 && useradd --uid 10001 --no-create-home app
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PORT=8102
COPY --from=build /app/.venv /app/.venv
COPY autolabel_adapter ./autolabel_adapter
EXPOSE 8102
USER app
CMD ["/app/.venv/bin/python", "-m", "autolabel_adapter"]
