ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS web
WORKDIR /web
COPY frontend/web/package.json frontend/web/package-lock.json ./
RUN npm ci
COPY frontend/web/ ./
RUN npm run build

FROM ${PYTHON_IMAGE} AS builder
ARG UV_VERSION=0.13.1
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /usr/local/bin/
COPY backend/pyproject.toml backend/uv.lock ./
# 步骤 1：仅同步第三方外部依赖，依赖不变时完全缓存命中
RUN uv sync --locked --no-dev --extra community-sources --no-install-project
# 步骤 2：安装项目包元数据，供 entrypoints 与 importlib.metadata 使用
COPY backend/src/ ./src/
RUN uv sync --locked --no-dev --extra community-sources --no-editable

FROM ${PYTHON_IMAGE} AS runtime
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WILDSTRING_ENVIRONMENT=production \
    WILDSTRING_DATA_DIR=/data \
    WILDSTRING_MUSIC_DIR=/music \
    WILDSTRING_PODCASTS_DIR=/podcasts \
    WILDSTRING_WEB_DIR=/app/web
WORKDIR /app
RUN apt-get update --error-on=any \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libchromaprint-tools \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 wildstring \
    && useradd --uid 10001 --gid wildstring --no-create-home wildstring \
    && mkdir /data /music /podcasts \
    && chown wildstring:wildstring /data /podcasts
COPY --from=builder /app/.venv /app/.venv
COPY --from=web /web/dist /app/web
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=web /usr/local/LICENSE /usr/share/doc/node/LICENSE
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=6s --start-period=10s --retries=3 \
    CMD ["python", "-m", "wildstring.healthcheck", "--url", "http://127.0.0.1:8000/health/ready"]
CMD ["uvicorn", "wildstring.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
