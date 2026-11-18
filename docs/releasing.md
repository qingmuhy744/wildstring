# CI/CD 与发布

## CI

`.github/workflows/ci.yml` 在 main 提交、PR、手动触发和 Release 复用调用时执行：锁定依赖、hooks、Python/Web 测试、Web 构建与锁文件检查。容器任务执行 `make docker-up docker-smoke docker-test`，检查 API、Web、FFmpeg、非 root、只读音乐及后端测试，最后停止容器并保留数据卷。

`make dependency-audit` 审计完整 Web 和插件 npm 依赖。Web 构建链的 [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) 有一项经确认的限时例外，具体版本、范围和截止时间见[审计脚本](../scripts/audit_web_dependencies.py)。CI 原样打印审计报告及例外命中提示。新增公告、受影响版本变更、进入生产依赖或到期未修复仍会阻断。确认上游补丁后更新锁文件并移除临时代码，同时将 Web 恢复为常规完整审计。

`.github/workflows/android.yml` 的日常 PR / main 检查包含 Android Lint、JVM 测试、debug 与 R8 release 构建，以及设备测试源码编译。上传的 `wildstring-android-debug` 是「野弦 Dev」调试包，使用独立固定签名，可与正式版共存，同签名 Dev 包之间可覆盖安装；正式安装包从 Releases 下载。Fork / Dependabot 的无密钥构建继续检查，但不上传可安装的 Dev 附件。

完整设备回归日常在本地 Pixel 上执行，命令见 [Android 构建说明](../frontend/android/README.md)。除每周定时基准与按需手动触发 **Android APK**（`run_emulator=true`）外，打标签触发 **Release** 时会自动对比上一版本标签，在存在功能性 Android 改动时并行运行完整模拟器回归；该运行启动一次性合成曲库 API，再把 `realBackend` 参数传给模拟器，验证登录、认证音频串流、播放/暂停、歌词与手机/平板布局；不连接个人服务器或曲库。日常 CI 通过不等于设备回归通过。

PR 工作流只有仓库读取权限，不读取发布私钥。

Dev 签名使用专用 Actions secret `ANDROID_DEV_KEYSTORE_BASE64`，只在同仓库可信任务中恢复；Release 的 Android 验证任务也仅传入这个 Dev secret。调试 keystore 使用 Android 标准的 `androiddebugkey` 别名与 `android` 密码，私钥本体必须保密。公开指纹以 [`frontend/android/dev-signing-certificate.sha256`](../frontend/android/dev-signing-certificate.sha256) 为准，输入密钥与输出 APK 都需匹配该指纹，临时密钥在任务结束时删除。证书不符或可信任务缺少 secret 时失败，不降级上传随机签名包。

Dev 密钥备份在主工作区未跟踪的 `.env.android-dev.keystore`（0600），与正式密钥分开保存，不进入 Git、Gradle 缓存或附件。本地需要生成与 CI 同签名的 Dev 包时，设置 `ANDROID_DEV_KEYSTORE_PATH` 为该文件的绝对路径后执行既有 Android 构建命令；未设置时仍使用开发机自己的调试密钥。本机默认调试包与 CI Dev 包也可能不能互相覆盖。

CI 模拟器使用 API 35 的 AOSP `default` 镜像，完整回归和正式包安装检查保持一致。应用不依赖 Google Play 服务；Google APIs 镜像中的 Pixel Launcher 曾在回归中弹出无响应窗口、抢走焦点并导致后续用例连锁失败。回归仍保留全部窗口焦点、输入法及布局断言，不跳过失败用例。仪器化套件按已发现的用例数均衡拆成 4 个并行 shard（指定 `test_classes` 时为单 shard），各自使用全新 4 核模拟器运行，合起来覆盖每个类恰好一次；若单个模拟器进程中途掉线，会先短超时探活再自动拉起恢复并继续完成剩余与被中断测试类；测试运行器 `WildStringTestRunner` 与 `cmd locale set-app-locales` 直接设置应用中文语言，避免重开系统框架引起的竞态。

## 版本要求与签名

发版时同步 Python、Web、Android 版本及对应锁文件，并更新 iOS／macOS 各自 `project.yml` 的 `MARKETING_VERSION`／`CURRENT_PROJECT_VERSION`。当前版本与构建号分别以 `backend/pyproject.toml`、`frontend/web/package.json`、`frontend/android/app/build.gradle.kts` 和 Apple `project.yml` 为准；历史版本由 Git 标签与 `docs/releases/` 记录，不在本指南重复维护对照表。

Android `versionCode` 必须随发布严格递增，Apple 构建号与 Android `versionCode` 不要求相等。预发布标签使用对应生态的格式，例如 `v0.1.0-rc.1` 对应 Python `0.1.0rc1`、Web／Android `0.1.0-rc.1`，`v0.1.0-dev.1` 对应 Python `0.1.0.dev1`、Web／Android `0.1.0-dev.1`。

将标签替换为实际版本后运行版本一致性检查：

```sh
python3 scripts/package_release.py --tag vX.Y.Z --check-only
```

该脚本检查当前后端、Web 与 Android `versionName`；iOS／macOS 的 `project.yml` 未由脚本自动检查，发版前需单独核对。

正式签名使用仓库 Actions secrets：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`、`ANDROID_SIGNING_CERT_SHA256`。密钥仅在签名步骤写入 runner 临时目录，权限 0600，步骤退出立即删除；校验证书指纹后才上传 APK。Gradle 的常规依赖缓存不包含私钥。

本地密钥与密码分别保存在主工作区未跟踪的 `.env.android-release.jks` 与 `.env.android-release`，权限 0600。仓库 `.gitignore` 排除这些文件；不要提交、打包、上传 Release 或在终端打印其内容。请将两个文件一起备份到安全位置；丢失密钥后无法以同一身份更新已安装应用。具体文件是否已经配置，以本地和仓库 secrets 的实际状态为准。

## 功能批次与更新记录

从 0.1.0 后的改进批次开始，在根目录 [CHANGELOG.md](../CHANGELOG.md) 的「未发布」记录用户可见变化，并单列实现 / 验证状态。完成有意义的一批功能后，先与用户核对内容、验证结果和仍有的限制，由用户确定版本号，再更新各端版本及构建号、准备对应发布说明、构建并更新 App。不要因为功能代码完成就自行发布或预占版本号；不启用 PR 自动合并。

## 发布顺序

1. 用户确认版本号后，将 `CHANGELOG.md` 的本批「未发布」条目归入对应版本，并准备 `docs/releases/vX.Y.Z.md`，说明已实现能力、验证及限制。在推送或发起发布前，先在本地运行 `make check` 与 `make test-affected`（或完整 `make ci`），确保没有因界面文案调整或重构遗留的过期测试断言。
2. 通过 PR 合并进入 main，确认主线 **CI** 与 **Android APK** 工作流均已在该最终提交上通过。
3. 在这个已合并提交创建并推送 `vX.Y.Z` 标签。
4. **Release** 工作流核对标签、三个端版本及 main 祖先关系后，通过 [`scripts/release_verify_scope.py`](../scripts/release_verify_scope.py) 自动判定检查范围：若同一提交已在 main 通过主线 **CI** 则复用该结果免重跑；若对比上一版本标签存在功能性 Android 改动则执行 4 分片并行模拟器回归，否则仅执行 Android 构建、单元测试与 Lint；最后始终构建固定签名 R8 正式 APK，并在模拟器实际安装、检查连接页。
5. 全部通过后构建 Web ZIP 和 linux/amd64、linux/arm64 镜像，推送 GHCR，最后自动创建带全部附件的 GitHub Release。

工作流也支持手动重试：选择对应标签作为运行 ref，并填入同一 tag。工作流提交必须与标签一致，避免用另一提交的检查代替发布验证。只保存 Release 草稿或直接在网页发布 Release 不会触发构建。发布步骤失败时应先检查日志，再重跑同一标签；不移动已有发布标签。

发布产物：

- `wildstring-X.Y.Z-release.apk`：固定签名、R8 优化、无内置测试曲库的 Android 安装包。
- `wildstring-X.Y.Z-mapping.txt`：对应正式包的 R8 混淆映射，用于还原崩溃堆栈。
- `wildstring-web-vX.Y.Z.zip`：Web 静态文件、LICENSE 与使用说明；运行时需要后端。
- `WildString-macOS.dmg`：原生 Mac 客户端，最低 macOS 14；是否经过 Developer ID 签名与公证取决于 Apple secrets 配置，发布说明须明确实际状态。正式版发布且配置了 `HOMEBREW_TAP_TOKEN` 时，工作流会通过 [`scripts/generate_homebrew_cask.py`](../scripts/generate_homebrew_cask.py) 自动更新 `qingmuhy744/homebrew-tap` 的 `Casks/wildstring.rb`。
- 数据源插件 ZIP：按各插件独立版本打包。
- `SHA256SUMS`：APK、R8 mapping、Web ZIP、插件 ZIP、Mac DMG 与公开签名指纹文件的 SHA-256。
- `android-signing-certificate.sha256`：Android 发布签名的公开证书指纹。
- `ghcr.io/qingmuhy744/wildstring:vX.Y.Z`：同时包含后端、Web 与 FFmpeg 的双架构镜像；同时发布版本标签和提交标签。正式版更新 `latest`，预发布不更新。

Release 正文记录容器 manifest 摘要。首次推送后需要核对 GHCR 包可见性和匿名拉取；GitHub Release 可下载不代表镜像一定公开。不自动更新远程服务器。

## 下载与验证

用户从 [GitHub Releases](https://github.com/qingmuhy744/wildstring/releases) 直接下载 APK，无需解压 Actions artifact。Android 8.0 起可安装；默认使用系统信任的 HTTPS；客户端可逐线路显式允许 HTTP，但服务器 `https_only` 策略仍会拒绝 HTTP API／MCP 请求，见 [连接契约](../contracts/server-connections.md)。后续同一包名、同一发布密钥并递增 versionCode 后可覆盖升级。

开发测试包从 **Actions → Android APK → Artifacts → wildstring-android-debug** 下载并解压，附件包含 APK、校验和与 Dev 公开证书指纹。切换到固定签名之前的临时签名 Dev 包通常需先卸载一次；卸载会清除该 Dev 应用的本机数据，之后的固定签名包可覆盖安装。Dev 签名不代替正式发布签名。实施与验收见 [Dev 签名方案](plans/android-dev-signing.md)。

手机和平板截图由 `UiAutomation.takeScreenshot()` 写入 AGP `additionalTestOutputDir`，测试卸载前取回；对应报告保留 14 天。发布 APK 的安装检查另外上传真实连接页截图。夹具只存在于独立测试 APK 中。模拟器通过不代表真机省电、后台兼容和全部音频编码均已验收。
