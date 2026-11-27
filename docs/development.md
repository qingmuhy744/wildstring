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

### 本地 AI 测试

运行 `make test-ai-local` 并打开命令显示的回环地址。首次启动时按提示设置 `admin` 的密码，也可在 `.env.test.local` 预填 `WILDSTRING_TEST_ADMIN_PASSWORD`。测试账号、模型连接和合成曲库存放在已忽略的 `runtime/ai-test/`。在「个人设置 → 助手与通知 → 模型连接」手动保存的连接，重启后用同一账号登录即可继续使用。用 `make test-ai-local AI_TEST_PORT=新端口` 可调整监听端口，复用同一份数据。

要从文件自动配置连接，在仓库根目录创建已忽略的 `.env.test.local`，权限设为 `600`，填入测试用的模型地址、模型 ID 和密钥。

```dotenv
WILDSTRING_TEST_AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
WILDSTRING_TEST_AI_MODEL=gemini-2.5-flash
WILDSTRING_TEST_AI_API_KEY=your-test-key
WILDSTRING_TEST_AI_PROTOCOL=gemini
# WILDSTRING_TEST_AI_PROVIDER=gemini          # gemini 协议默认自动选 gemini；兼容接口默认 generic
# WILDSTRING_TEST_AI_REASONING_EFFORT=auto    # auto / none / low / medium / high / xhigh
# WILDSTRING_TEST_AI_NATIVE_SEARCH=true       # 仅 responses(openai/deepseek/qwen) 与 gemini 原生支持
# WILDSTRING_TEST_AI_PROXY=http://127.0.0.1:7890  # 可选 HTTP 代理（或 direct）；不填则跟随环境变量代理
```

启动时会为 `admin` 同步名为 `Local test AI` 的个人连接（以及可选的代理设置）。同名连接的地址、模型、协议、供应商、推理强度、原生搜索开关与密钥以文件为准，可以改文件后重启来轮换密钥。免密端点可留空密钥。也可以只用界面配置，省略配置文件。

`make test-ai-live` 读取同一份文件，在临时数据库里运行模型连接探测。它报告当前代理模式以及文本、结构化输出、工具调用和回传的探测结果，失败时输出 `error_code` 并退出非零。此命令会调用配置的提供方，统一代理仅支持 `http://` 地址（HTTPS 请求走 `CONNECT` 隧道，不支持 `socks5://`）。`make test`、`make test-web` 与 CI 仍使用各自的临时测试数据。

## Android 本地与远程设备调试

### 1. 本机一键模拟器

本地基准 AVD 为 `wildstring-phone`（`1080×1920`，控制台端口 `5566`）与 `wildstring-pad`（`2560×1600`，控制台端口 `5568`），使用 `system-images;android-35;default;x86_64` 并开启 `hw.keyboard=yes`（见 [AGENTS.md](../AGENTS.md)）。

```sh
make android-emu          # 启动/复用手机模拟器、构建安装并拉起 Dev 应用
make android-emu-pad      # 启动/复用平板模拟器、构建安装并拉起 Dev 应用
make android-emu-stop     # 停止本机运行中的 Android 模拟器
```

默认以无头后台启动；在 Linux 本机桌面直接弹窗查看时追加 `ANDROID_EMU_WINDOW=1`。

### 2. 跨机轻量操作（SSH 端口转发 + scrcpy，推荐日常交互）

仅需点击屏幕、查看页面布局与动效（无需断点调试或 UI 树检查）时，不需要打开 Android Studio，直接用 `scrcpy` 弹出独立窗口。

远端无头模拟器的 ADB 设备端口仅监听回环地址：`5567`（`emulator-5566`）与 `5569`（`emulator-5568`）。在控制端 `~/.ssh/config` 将其转发到本机高位端口，**不占用本机默认的 `5037` ADB Server 端口**，与本机 USB 真机或本地模拟器零冲突：

```sshconfig
Host wildstring-adb
    HostName <build-host-ip-or-alias>
    User <user>
    LocalForward 15567 127.0.0.1:5567
    LocalForward 15569 127.0.0.1:5569
    ExitOnForwardFailure yes
    ServerAliveInterval 15
    ServerAliveCountMax 3
```

建立后台隧道后直接用 `scrcpy` 打开对应端口（会自动建立 `adb connect`）：

```sh
ssh -fN wildstring-adb
scrcpy --tcpip=127.0.0.1:15567   # 手机（平板为 127.0.0.1:15569）
```

该方式提供 60fps 独立窗口、键鼠点按滑动、双向剪贴板以及音频转发；用完断开隧道与连接（`adb disconnect 127.0.0.1:15567`）即可，远端无头模拟器与安装状态不受影响。

### 3. 跨机接入 Android Studio 深度调试（SSH 端口转发 + adb connect）

需要 `Layout Inspector`（Compose UI 树与重组检查）、断点单步、`Logcat` 或 `Profiler` 时，复用同一条 `15567 / 15569` SSH 隧道：

```sh
ssh -fN wildstring-adb
adb connect 127.0.0.1:15567
```

设备会注册到本机原生的 `127.0.0.1:5037` ADB Server 下，因此硬编码连接 `127.0.0.1:5037` 的 IDE/调试插件以及 `adb reverse` 均可正常工作；请勿改用转发远端 `5037` 端口，以免与本机 IDE 自动拉起的 ADB Server 抢占端口或冲掉本机 USB 真机。需要注意 Android Studio 仅将 `5554–5585` 且带控制台口的设备识别为模拟器，`127.0.0.1:15567` 会显示为标准无线 TCP 设备（界面操作、`Running Devices` 投屏、装包调试与 UI 树检查均正常，仅隐藏依赖偶数控制台口的虚拟来电/电量/定位等模拟器扩展面板；如需控制台指令可在构建机执行 `adb -s emulator-5566 emu ...`）。

### 4. 实体设备跨局域网 / SD-WAN 无线装包与联调

构建机与实体 Android 设备处于同一局域网或 SD-WAN（如 Tailscale）时，可不经过中间拷贝直接远程装包（`adb -s <target> install -r ...` 或 `./gradlew :app:installDebug`）：

- **路由器直通或局域网互通（Android 11+）**：在手机「开发者选项 → 无线调试」开启开关后，构建机执行一次 `adb pair <device-ip>:<pair-port>` 配对，再通过 `adb connect <device-ip>:<connect-port>` 连接。
- **客户端虚拟网卡组网（如手机端运行 Tailscale / WireGuard `tun0`）**：Android 原生「无线调试」绑定在 Wi-Fi 接口上（切蜂窝网络自动关闭，且部分 ROM 会拦截来自虚拟网卡的握手）。若直连受阻或需要跨 Wi-Fi/蜂窝网固定端口，可在手机开机后插任意电脑执行一次 `adb tcpip 5555`，拔线后构建机即可通过 `adb connect <virtual-ip>:5555` 连接（首次需在手机确认 RSA 授权弹窗；在不可信公共网络使用前执行 `adb usb` 或关闭 USB 调试）。

真机在 SD-WAN 内直连开发机调试后端时，后端需监听可达地址，并在客户端服务器线路中显式放行 `http://`（详见 [服务器线路契约](../contracts/server-connections.md)）。

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
