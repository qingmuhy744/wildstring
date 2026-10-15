# 开发与本地部署

## 环境与入口

使用 Python 3.12、uv 0.9.18、Node 22.12+、Make 和 Git；容器需要 Docker Compose。uv 可自动安装缺少的 Python。所有命令从仓库根目录执行。

```sh
make setup
make browser-install # 首次准备 Chromium
make admin           # 本地设置 admin 密码
make dev
# 另一终端
make dev-web
```

## 只读曲库扫描

在 `.env` 将 `WILDSTRING_MUSIC_DIR` 指向音乐目录。仓库根目录 `data/` 用于本地测试音乐，已从 Git 和 Docker 构建上下文排除；它与存放 SQLite 和托管副本的 `WILDSTRING_DATA_DIR` 是两个目录。

```sh
make import-music
make docker-import
make scan            # 只重扫托管副本
make scan SCAN_ARGS=--full
make docker-scan
```

源目录只读，导入先复制到托管库并按标签整理目录，默认本地 `runtime/library/`、容器 `/data/library/`。见 [托管规则](../contracts/managed-library.md)。

扫描托管副本时，默认依据文件大小与纳秒修改时间做增量扫描；`--full` 强制重新读取标签。缺失记录保留，坏文件单独记录错误；根目录不可读、扫描中根目录身份变化或目录遍历不完整时，不批量标记文件缺失。外部重命名目前不自动识别为同一曲目。

扫描进程使用跨进程文件锁，只有一个扫描可运行。运行记录与已导入文件逐步持久化；中断后重扫可跳过已导入且未变化的文件，旧运行标为 interrupted。当前不是通用后台任务队列，也没有网页扫描按钮。

CLI 输出 JSON。模块退出码：0 完成、1 根目录失败、2 完成但存在文件/遍历错误、3 已有扫描运行；Make 会将非零结果报告为失败。扫描报告和计数可以通过 [曲库 API](../contracts/library-api.md) 查询。

API 默认 `127.0.0.1:18780`，React 默认 `127.0.0.1:18781`。开发配置开放 `/docs`，容器生产配置关闭开发文档。开发代理读取 `.env` 中的 API 端口；模型密钥不要放在 `VITE_` 变量中。

`make setup` 创建 `.env`、`runtime/`、默认 `music/`，安装锁定依赖和 pre-commit hook，保留已有配置。音乐目录可在 `.env` 更改，不移动原文件。

工具缓存默认位于忽略的 `.cache/`。运行 Git hook 前先完成一次 `make setup`。

## 检查

- `make check`：检查已跟踪及新增文件；含格式、语法、密钥、文件大小、Ruff、Bandit 与前端类型检查。
- `make test`：隔离的后端测试，不使用其他项目的数据库或模型服务。
- `make build-web`：TypeScript 检查与 Vite 构建。
- `make ci`：提交检查、后端测试、Web 构建、桌面/手机 Chromium 集成测试和 Python 锁文件核验。首次先 `make browser-install`。
- `make format`：主动格式化 Python 与前端源码。

`make test-web` 可单独运行浏览器集成测试：使用 18782 端口，临时创建独立数据库与合成音频；不读取 `.env` 的个人曲库。失败截图与播放预览输出到已忽略的 `artifacts/`。GitHub Actions 安装 Chromium 系统依赖后执行同一组 `make ci`。

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

多阶段镜像包含已编译 Web、Python 运行依赖和 FFmpeg，使用非 root 用户。Compose 根文件系统只读，仅 `/data` 持久卷和 `/tmp` 临时目录可写，导入源只读挂载；托管副本位于持久卷 `/data/library`，后续修改仅针对副本。

默认项目名 `wildstring`，数据卷 `wildstring_data`。停止不会删除数据卷。音乐目录需预先存在并允许 UID 10001 读取，错误挂载会使就绪检查失败。

如果宿主机需要代理联网，在本地 `.env` 设置 `DOCKER_HTTP_PROXY` 与 `DOCKER_HTTPS_PROXY`，地址使用 Docker 可访问的宿主机网关，例如 `http://host.docker.internal:7890`。它们仅作为构建参数传入，不配置为运行容器环境变量。不要在容器内使用宿主机的 `127.0.0.1` 代理地址。

运行目录保存 `wildstring.sqlite3` 和扫描锁，SQLite 使用 WAL。数据库启动时逐步迁移到 v4（v2 认证、v3 专辑索引、v4 导入记录和映射），保留原曲库与曲目 ID；不支持更高版本数据库自动降级。备份应使用 SQLite backup API 获取一致快照，不在运行时仅复制主文件并遗漏 WAL。

首次启动后执行 `make docker-admin`，或仅首次通过 `.env` 中 `WILDSTRING_ADMIN_PASSWORD` 初始化管理员。现有管理员不会被启动配置覆盖；重置密码会撤销全部会话。Cookie 默认为本机 HTTP 配置，通过 HTTPS 访问时设置 `WILDSTRING_COOKIE_SECURE=true`。

网页已提供登录、曲库搜索与原文件播放；详见 [接口与播放边界](../contracts/playback-auth-api.md)。艺人浏览、普通/规则歌单、收藏和收听统计见 [个人曲库](../contracts/personal-library.md)。封面、歌曲/专辑视图和本地歌词已接入，见 [本地资源规则](../contracts/local-library-assets.md)。管理页与 AI API 连接配置见 [管理接口](../contracts/library-management.md)。批量整理、标签写回、转码与 Agent 尚未实现，健康检查不代表完整 MVP 完成。写回方案见 [服务端修复](architecture/metadata-repair.md)。

## 发布镜像

在 `.env` 设置实际已发布的 `WILDSTRING_IMAGE=ghcr.io/qingmuhy744/wildstring:v0.1.0` 后执行 `make docker-pull`，会拉取并启动，不从本地源码构建。私有 GHCR 包需要先完成 Docker 登录。

目前仅配置本机部署，未接入远程服务器自动更新。

## 图标

网页品牌和 SVG favicon 共用 `frontend/web/public/favicon.svg` 的橙色三道波纹；`favicon.ico` 包含 16、24、32、48、64、128、256 像素的透明帧。修改 SVG 后执行 `make icons` 重新生成 ICO，需要先安装项目依赖和 Chromium（`make browser-install`）；生成脚本会核验透明像素。Web 构建会把两个图标打包到静态根目录。
