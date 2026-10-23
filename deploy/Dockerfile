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
# 仅同步第三方依赖，不安装 project 本身，使巨型依赖层最大化利用 Docker 构建缓存
RUN uv sync --locked --no-dev --extra community-sources --no-install-project

FROM ${PYTHON_IMAGE} AS runtime
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app/src" \
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
# 1. 缓存层：第三方虚拟环境（依赖不变时永不重新构建与传输）
COPY --from=builder /app/.venv /app/.venv
# 2. 外部运行环境
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=web /usr/local/LICENSE /usr/share/doc/node/LICENSE
# 3. 前端编译输出（前端代码变动时仅更新此层）
COPY --from=web /web/dist /app/web
# 4. 后端应用源码（高频变动，极轻量，秒级拷贝）
COPY backend/src/ /app/src/
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=6s --start-period=10s --retries=3 \
    CMD ["python", "-m", "wildstring.healthcheck", "--url", "http://127.0.0.1:8000/health/ready"]
CMD ["uvicorn", "wildstring.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
