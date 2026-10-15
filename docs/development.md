# 开发与本地部署

## 环境与入口

使用 Python 3.12、uv 0.9.18、Node 22.12+、Make 和 Git；容器需要 Docker Compose。uv 可自动安装缺少的 Python。所有命令从仓库根目录执行。

```sh
make setup
make dev
# 另一终端
make dev-web
```

API 默认 `127.0.0.1:18780`，React 默认 `127.0.0.1:18781`。开发配置开放 `/docs`，容器生产配置关闭开发文档。开发代理读取 `.env` 中的 API 端口；模型密钥不要放在 `VITE_` 变量中。

`make setup` 创建 `.env`、`runtime/`、默认 `music/`，安装锁定依赖和 pre-commit hook，保留已有配置。音乐目录可在 `.env` 更改，不移动原文件。

工具缓存默认位于忽略的 `.cache/`。运行 Git hook 前先完成一次 `make setup`。

## 检查

- `make check`：检查已跟踪及新增文件；含格式、语法、密钥、文件大小、Ruff、Bandit 与前端类型检查。
- `make test`：隔离的后端测试，不使用其他项目的数据库或模型服务。
- `make build-web`：TypeScript 检查与 Vite 构建。
- `make ci`：提交检查、测试、Web 构建和 Python 锁文件核验。
- `make format`：主动格式化 Python 与前端源码。

更新 Python 依赖后运行 `uv lock --project backend`。npm 依赖在 `frontend/web` 更新并提交锁文件。历史原始讨论与已有 LICENSE 不参与空白自动改写。

## Docker

```sh
make docker-config
make docker-up
make docker-smoke
make docker-status
make docker-logs
make docker-down
```

多阶段镜像包含已编译 Web、Python 运行依赖和 FFmpeg，使用非 root 用户。Compose 根文件系统只读，仅 `/data` 持久卷和 `/tmp` 临时目录可写，音乐目录只读挂载。

默认项目名 `wildstring`，数据卷 `wildstring_data`。停止不会删除数据卷。音乐目录需预先存在并允许 UID 10001 读取，错误挂载会使就绪检查失败。

如果宿主机需要代理联网，在本地 `.env` 设置 `DOCKER_HTTP_PROXY` 与 `DOCKER_HTTPS_PROXY`，地址使用 Docker 可访问的宿主机网关，例如 `http://host.docker.internal:7890`。它们仅作为构建参数传入，不配置为运行容器环境变量。不要在容器内使用宿主机的 `127.0.0.1` 代理地址。

当前基座尚无数据库迁移、账号或音乐处理，健康检查不代表完整 MVP 完成。数据库落地时补充迁移、备份和恢复步骤。

## 发布镜像

在 `.env` 设置实际已发布的 `WILDSTRING_IMAGE=ghcr.io/qingmuhy744/wildstring:v0.1.0` 后执行 `make docker-pull`，会拉取并启动，不从本地源码构建。私有 GHCR 包需要先完成 Docker 登录。

目前仅配置本机部署，未接入远程服务器自动更新。
