# Fake model services for smoke / E2E tests. NEVER deploy to a customer production environment.
#
#   docker build -t ai-platform-fakes platform/fakes
#   docker run -e FAKE_SERVICE=llm       -p 8101:8101 ai-platform-fakes
#   docker run -e FAKE_SERVICE=autolabel -p 8102:8102 ai-platform-fakes
#
# Two stages: uv installs the locked dependencies; the final image holds only Python, the .venv and the code
# (no uv, pip or package caches) and applies the Alpine security updates available at build time.
# Alpine (musl): every dependency ships a musllinux wheel, and the base has no known HIGH/CRITICAL vulnerabilities.
FROM python:3.12-alpine AS build
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_NO_CACHE=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.12-alpine
RUN apk upgrade --no-cache \
 && python -m pip uninstall -y -q pip && rm -rf /root/.cache \
 && adduser -D -u 10001 fakes
WORKDIR /app
ENV PYTHONUNBUFFERED=1
COPY --from=build /app/.venv /app/.venv
COPY fakes ./fakes

# FAKE_SERVICE: llm | autolabel. PORT (optional) defaults to 8101 (llm) / 8102 (autolabel).
ENV FAKE_SERVICE=llm
EXPOSE 8101 8102
USER fakes
CMD ["sh", "-c", "exec /app/.venv/bin/python -m fakes.${FAKE_SERVICE} --host 0.0.0.0 ${PORT:+--port $PORT}"]
