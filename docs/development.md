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

扫描进程使用跨进程文件锁，只有一个扫描可运行。运行记录与已导入文件逐步持久化；中断后重扫可跳过已导入且未变化的文件，旧运行标为 interrupted。网页任务与 CLI 复用同一文件锁，自动发现与待整理见 [自动导入](../contracts/automatic-import.md)。

CLI 输出 JSON。模块退出码：0 完成、1 根目录失败、2 完成但存在文件/遍历错误、3 已有扫描运行；Make 会将非零结果报告为失败。扫描报告和计数可以通过 [曲库 API](../contracts/library-api.md) 查询。

API 默认 `127.0.0.1:18780`，React 默认 `127.0.0.1:18781`。开发配置开放 `/docs`，容器生产配置关闭开发文档。开发代理读取 `.env` 中的 API 端口；模型密钥不要放在 `VITE_` 变量中。

`make setup` 创建 `.env`、`runtime/`、默认 `music/`，安装锁定依赖和 pre-commit hook，保留已有配置。音乐目录可在 `.env` 更改，不移动原文件。

工具缓存默认位于忽略的 `.cache/`。运行 Git hook 前先完成一次 `make setup`。

## 检查与多端测试

- `make check`：检查已跟踪及新增文件；含格式、语法、密钥、文件大小、Ruff、Bandit、前端类型、多语言键对齐，以及 **Web 过期测试断言静态扫描**（自动拦截已从源码/语言包删除但仍残留在 `frontend/web/tests/*.spec.ts` 中的旧文案断言）。
- `make test-affected` / `make test-affected-desktop`：根据当前 `git diff` 自动反查受影响的后端 `pytest` 用例与前端 `Playwright` 用例，并按各自所需环境变量分组执行（避免只跑单个 spec 漏掉跨文件回归，无需每次等待全量 `make ci`）。
- `make test`：隔离的后端测试，不使用其他项目的数据库或模型服务。
- `make test-agent` / `make test-network` / `make test-research`：验证 Agent 受控工具、草案、通知、诊断、MCP 协议、出站代理与模型检索摘要。
- `make test-native-plugin` / `make source-plugins`：编译测试 Nuitka 原生插件扩展与独立社区数据源 ZIP 包。
- `make test-large-web` / `make test-browse-web` / `make test-catalog-web` / `make test-podcast-web` / `make test-libraries-web`：分别验证大曲库分页续播、拼音跳转、多碟排序、播客目录与多库权限的真实浏览器端到端回归。
- `make build-web`：TypeScript 检查与 Vite 构建。
- `make ci`：提交检查、插件打包、依赖审计、后端测试、Web 构建、全部 Chromium 浏览器端到端测试和 Python 锁文件核验。首次先 `make browser-install`。
- `make android-ci`：使用 JDK 21 编译、单测、Lint 检查并打包原生 Android APK（`frontend/android`）。
- `make macos-build` / `make macos-test` / `make macos-dmg`：通过 XcodeGen 生成并构建、测试、打包原生 macOS 客户端（`frontend/macos`）。
- `make ios-test` / `make ios-build`：运行 `WildStringKit` 核心包单测并构建原生 iOS 模拟器包（`frontend/ios`）。
- `make format`：主动格式化 Python 与前端源码。

`make test-web` 可单独运行浏览器集成测试：默认使用 18782 端口（可用 `WILDSTRING_WEB_TEST_PORT=18783 make test-web` 避开其他测试服务），临时创建独立数据库与合成音频；不读取 `.env` 的个人曲库。失败截图与播放预览输出到已忽略的 `artifacts/`。GitHub Actions 安装 Chromium 系统依赖后执行同一组 `make ci`。

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

播客 RSS、封面和音频只连接公网地址。宿主机或容器的 DNS 若由 Clash/mihomo 的 fake-ip 模式接管（域名解析到 `198.18.0.0/15`），订阅会返回 `remote_url_fake_ip`。优先在 `HTTP_PROXY` / `HTTPS_PROXY` 或网页联网设置中配置出站代理，此时目标域名由代理解析；无法配置代理时可在 `.env` 设置 `WILDSTRING_PODCAST_ALLOW_FAKE_IP=true` 并重启。该开关只放行 DNS 解析得到的 `198.18.0.0/15`，URL 中直接写出的 IP 和其他私有、回环、链路本地地址仍拒绝；详见 [远程播客访问](../contracts/storage-and-podcast-resources.md#远程播客访问)。

运行目录保存 `wildstring.sqlite3` 和扫描锁，SQLite 使用 WAL。数据库启动时逐步迁移到最新 schema（当前 `SCHEMA_VERSION = 48`，覆盖多音乐库与库授权、四角色用户、歌词覆盖与洗版扫描、Host 白名单、转码缓存、元数据来源与发行锁定、播客订阅/目录搜索/共享清理、跨设备快照、个人推荐、Agent/MCP 草案与诊断日志等），保留原曲库与曲目 ID；不支持更高版本数据库自动降级。备份应使用 SQLite backup API 获取一致快照，不在运行时仅复制主文件并遗漏 WAL。

首次启动后执行 `make docker-admin`，或仅首次通过 `.env` 中 `WILDSTRING_ADMIN_PASSWORD` 初始化管理员。现有管理员不会被启动配置覆盖；重置密码会撤销目标用户全部会话。升级前 Cookie 配置保留。新部署可在管理中心 → 服务器 → 访问设置选择 HTTP + HTTPS 或仅 HTTPS；新策略按访问协议自动设置 Secure。页面保存值优先于 `WILDSTRING_CONNECTION_POLICY` / `WILDSTRING_SERVER_NAME`，清除覆盖后恢复环境默认。TLS 反向代理须用 `WILDSTRING_TRUSTED_PROXIES` 明确配置代理地址或网段，应用不默认信任转发协议头；不要额外启用 Uvicorn 的代理头处理。

网页及各原生客户端已提供登录、多库切换、曲库搜索、原文件播放、播客订阅与探索、每日推荐及 AI 音乐助手；详见 [接口与播放边界](../contracts/playback-auth-api.md)、[个人曲库](../contracts/personal-library.md)、[本地资源规则](../contracts/local-library-assets.md)、[管理接口](../contracts/library-management.md) 与 [Agent 平台契约](../contracts/agent-platform.md)。已提供 WAV/CUE 到 FLAC 的导入转换及专辑批量差异核对；已有文件标签的物理写回仍后置为显式操作（详见 [服务端修复](architecture/metadata-repair.md)）。

## 发布镜像

在 `.env` 设置实际已发布的 `WILDSTRING_IMAGE=ghcr.io/qingmuhy744/wildstring:v0.8.7` 后执行 `make docker-pull`，会拉取并启动，不从本地源码构建。私有 GHCR 包需要先完成 Docker 登录。

目前仅配置本机部署，未接入远程服务器自动更新。

## 图标

网页品牌和 SVG favicon 共用 `frontend/web/public/favicon.svg` 的橙色三道波纹；`favicon.ico` 包含 16、24、32、48、64、128、256 像素的透明帧。修改 SVG 后执行 `make icons` 重新生成 ICO，需要先安装项目依赖和 Chromium（`make browser-install`）；生成脚本会核验透明像素。Web 构建会把两个图标打包到静态根目录。

### 转换测试

主机没有 FFmpeg 时，`make test` 会明确跳过转换用例；使用 `make docker-test` 完整运行。测试镜像复用生产 FFmpeg 和固定版本 uv，再按同一 `backend/uv.lock` 安装开发依赖，网络关闭、根目录只读、非 root 运行，不挂载用户曲库。可指定 `PROJECT=wildstring-check TEST_RUNTIME_IMAGE=wildstring:check TEST_BUILDER_IMAGE=wildstring-builder:check TEST_IMAGE=wildstring-tests:check`，同时隔离测试项目与镜像标签；运行容器还需单独选择空闲端口与测试源目录。设置构建代理仍使用 `.env` 的 `DOCKER_HTTP_PROXY` / `DOCKER_HTTPS_PROXY`。源 WAV 与 CUE 均由测试动态生成，不使用私人音乐。

账号与域名恢复见 [账号与访问](../contracts/users-and-access.md)，歌词编辑与打点见 [歌词接口](../contracts/lyrics-editing.md)。Host 白名单只校验实际请求 Host，代理部署请保留该标头，并在启用前记录数据库恢复命令。用户数据通过请求对应的 Database 实例绑定 active_user，不在共享仓库对象上改写当前用户；后台扫描使用共享曲库，不覆盖个人统计。

AAC 使用现有服务内的 FFmpeg；无需新容器。缓存位于持久运行目录 `cache/transcoding/`，可在管理设置清理。安装 FFmpeg 后 `make test-transcoding-web` 用合成 FLAC 验证真实浏览器转码与跳转；CI 已安装 FFmpeg。接口见 [播放转码](../contracts/playback-transcoding.md)。
