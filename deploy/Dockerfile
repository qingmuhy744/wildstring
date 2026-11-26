ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS web
WORKDIR /web
COPY frontend/web/package.json frontend/web/package-lock.json ./
RUN npm ci
COPY frontend/web/ ./
RUN npm run build

FROM ${PYTHON_IMAGE} AS python-build
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /usr/local/bin/

FROM python-build AS requirements
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv export --locked --no-dev --extra community-sources --no-emit-project \
    --no-header --no-annotate --output-file requirements.txt > /dev/null

FROM python-build AS dependencies
COPY --from=requirements /app/requirements.txt ./
# Python isolated mode also loads .pth files from the venv's site-packages.
RUN uv venv \
    && uv pip sync --python .venv/bin/python --require-hashes requirements.txt \
    && printf '/app/app-site\n' > .venv/lib/python3.12/site-packages/wildstring-app.pth

FROM dependencies AS builder
COPY backend/pyproject.toml backend/uv.lock ./
COPY backend/src/ ./src/
RUN uv pip install --no-deps --python .venv/bin/python --target /app/app-site .

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
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=web /usr/local/LICENSE /usr/share/doc/node/LICENSE
COPY --from=dependencies /app/.venv /app/.venv
COPY --from=web /web/dist /app/web
COPY --from=builder /app/app-site /app/app-site
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=6s --start-period=10s --retries=3 \
    CMD ["python", "-m", "wildstring.healthcheck", "--url", "http://127.0.0.1:8000/health/ready"]
# 长保持连接 75 秒：客户端心跳与首次播放复用温热连接，避免频繁重新握手
CMD ["uvicorn", "wildstring.main:create_app", "--factory", "--no-proxy-headers", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "75"]
