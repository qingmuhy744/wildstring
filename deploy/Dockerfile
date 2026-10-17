ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS web
WORKDIR /web
COPY frontend/web/package.json frontend/web/package-lock.json ./
RUN npm ci
COPY frontend/web/ ./
RUN npm run build

FROM ${PYTHON_IMAGE} AS builder
ARG UV_VERSION=0.9.18
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
WORKDIR /app
RUN python -m pip install --no-cache-dir "uv==${UV_VERSION}"
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-dev --extra community-sources --no-install-project
COPY backend/src/ ./src/
RUN uv sync --locked --no-dev --extra community-sources --no-editable

FROM ${PYTHON_IMAGE} AS runtime
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WILDSTRING_ENVIRONMENT=production \
    WILDSTRING_DATA_DIR=/data \
    WILDSTRING_MUSIC_DIR=/music \
    WILDSTRING_WEB_DIR=/app/web
WORKDIR /app
RUN apt-get update --error-on=any \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libchromaprint-tools \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 wildstring \
    && useradd --uid 10001 --gid wildstring --no-create-home wildstring \
    && mkdir /data /music \
    && chown wildstring:wildstring /data
COPY --from=builder /app/.venv /app/.venv
COPY --from=web /web/dist /app/web
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=6s --start-period=10s --retries=3 \
    CMD ["python", "-m", "wildstring.healthcheck", "--url", "http://127.0.0.1:8000/health/ready"]
CMD ["uvicorn", "wildstring.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
