# Fake model services for smoke / E2E tests. NEVER deploy to a customer production environment.
#
#   docker build -t ai-platform-fakes platform/fakes
#   docker run -e FAKE_SERVICE=llm       -p 8101:8101 ai-platform-fakes
#   docker run -e FAKE_SERVICE=autolabel -p 8102:8102 ai-platform-fakes
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY fakes ./fakes

# FAKE_SERVICE: llm | autolabel. PORT (optional) defaults to 8101 (llm) / 8102 (autolabel).
ENV FAKE_SERVICE=llm
EXPOSE 8101 8102
RUN useradd --create-home --uid 10001 fakes
USER fakes
CMD ["sh", "-c", "exec /app/.venv/bin/python -m fakes.${FAKE_SERVICE} --host 0.0.0.0 ${PORT:+--port $PORT}"]
