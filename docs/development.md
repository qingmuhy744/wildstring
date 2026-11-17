# 开发与本地部署

所有命令从仓库根目录执行。可用命令及参数以 `make help` 和 `Makefile` 为准；接口行为以 `contracts/` 为准，验收分工见 `AGENTS.md` §3。

## 本地启动

准备 Python 3.12、uv、Node 22、Make 和 Git；容器部署另需 Docker Compose。版本锁分别保存在 `backend/uv.lock` 与各 `package-lock.json`。

```sh
make setup
make browser-install # 首次运行浏览器测试前
make admin           # 交互式设置本地管理员密码
make dev
# 另一终端
make dev-web
```

API 默认监听 `127.0.0.1:18780`，Web 开发服务器默认监听 `127.0.0.1:18781`。`make setup` 创建本地配置与运行目录、安装锁定依赖和 Git hooks，不覆盖已有配置。模型密钥不要放在会下发浏览器的 `VITE_` 变量中。

## 导入与扫描

在 `.env` 将 `WILDSTRING_MUSIC_DIR` 指向只读导入源。导入源与保存数据库、托管副本的 `WILDSTRING_DATA_DIR` 是两个目录，导入不会移动或修改源文件。

```sh
make import-music
make scan
make scan SCAN_ARGS=--full
```

普通扫描读取变化的托管副本，`--full` 重新读取全部标签。托管规则、自动导入和扫描接口分别见 [托管曲库](../contracts/managed-library.md)、[自动导入](../contracts/automatic-import.md) 与 [曲库 API](../contracts/library-api.md)。

## 检查与测试

```sh
make check                 # 提交前静态检查
make test-affected        # 当前改动影响的后端与 Web 回归
make test-affected-desktop # 较快的桌面浏览器回归
make ci                   # 全量后端、Web 与构建检查
```

原生端、容器和发布验收按 `AGENTS.md` §3 选择对应命令。浏览器测试使用隔离数据库与合成曲库，不读取个人音乐或运行数据；失败产物写入已忽略的 `artifacts/`。

修改依赖后同步对应锁文件：Python 使用 `uv lock --project backend`，Web 在 `frontend/web` 更新 npm 锁文件，Android 使用 `make android-locks`。Gradle 跨平台校验的补充步骤见 `AGENTS.md` §4。

## 容器运行

```sh
make docker-config
make docker-up
make docker-smoke
make docker-status
make docker-logs
make docker-down
```

容器包含后端、已构建 Web 和 FFmpeg。Compose 使用非 root 用户与只读根文件系统，仅持久数据目录和临时目录可写，导入源只读挂载。`make docker-down` 不删除数据卷。

容器内使用 `make docker-import`、`make docker-scan` 和 `make docker-admin` 导入、扫描及设置管理员。使用已发布镜像时，在 `.env` 将 `WILDSTRING_IMAGE` 设为实际发布标签，再运行 `make docker-pull`；版本与发布状态见 `docs/releases/`。

## 代理、备份与 TLS

- 构建代理使用 `.env` 中的 `DOCKER_HTTP_PROXY` 与 `DOCKER_HTTPS_PROXY`，地址必须能从 Docker 构建环境访问，不要使用容器内的 `127.0.0.1` 指向宿主机代理。
- 播客 RSS、封面和音频默认只连接公网地址。fake-ip DNS 与显式放行开关的边界见 [远程播客访问](../contracts/storage-and-podcast-resources.md#远程播客访问)。
- SQLite 使用 WAL。备份须使用 SQLite backup API 获取一致快照，不能在运行时只复制主数据库文件而遗漏 WAL。当前 schema 以 `backend/src/wildstring/database.py` 的 `SCHEMA_VERSION` 为准，旧版本不能自动降级打开较新数据库。
- TLS 反向代理须用 `WILDSTRING_TRUSTED_PROXIES` 明确配置可信代理地址或网段，不要额外启用 Uvicorn 的代理头处理。账号、Cookie 与访问策略见 [账号与访问](../contracts/users-and-access.md)。
