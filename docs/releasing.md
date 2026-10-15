# CI/CD 与发布

## CI

`.github/workflows/ci.yml` 在 main 提交、PR、手动触发和 Release 复用调用时执行：锁定依赖、hooks、Python/Web 测试、Web 构建与锁文件检查。容器任务执行 `make docker-up docker-smoke docker-test`，检查 API、Web、FFmpeg、非 root、只读音乐及后端测试，最后停止容器并保留数据卷。

`.github/workflows/android.yml` 检查 Android Lint、JVM 测试、debug 构建和 R8 release 构建，再通过模拟器检查登录、认证音频串流、播放/暂停、手机全屏歌词和平板双栏。上传 `wildstring-android-debug` 与报告/截图。debug 使用临时签名，供开发验证；正式安装包从 Releases 下载。

PR 工作流只有仓库读取权限，不读取发布私钥。

## 版本和签名

显示名称「野弦 / WildString」。正式 Android applicationId 为 `com.wildstring.app`，debug 为 `com.wildstring.app.debug`。0.1.0 的 Android versionCode 为 2；后续发布必须递增。旧的 `dev.wildstring.app.debug` 属于独立应用，安装新版后重新连接即可，服务端数据保留。

同时更新 Python、Web、Android 版本及对应锁文件：

| 标签 | Python | Web / Android versionName |
| --- | --- | --- |
| `v0.1.0` | `0.1.0` | `0.1.0` |
| `v0.1.0-rc.1` | `0.1.0rc1` | `0.1.0-rc.1` |
| `v0.1.0-dev.1` | `0.1.0.dev1` | `0.1.0-dev.1` |

`python3 scripts/package_release.py --tag v0.1.0 --check-only` 检查三个端版本一致。

正式签名使用仓库 Actions secrets：`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`、`ANDROID_SIGNING_CERT_SHA256`。密钥仅在签名步骤写入 runner 临时目录，权限 0600，步骤退出立即删除；校验证书指纹后才上传 APK。Gradle 的常规依赖缓存不包含私钥。

本地密钥与密码分别保存在主工作区未跟踪的 `.env.android-release.jks` 与 `.env.android-release`，权限 0600。仓库 `.gitignore` 排除这些文件；不要提交、打包、上传 Release 或在终端打印其内容。请将两个文件一起备份到安全位置；丢失密钥后无法以同一身份更新已安装应用。具体文件是否已经配置，以本地和仓库 secrets 的实际状态为准。

## 功能批次与更新记录

从 0.1.0 后的改进批次开始，在根目录 [CHANGELOG.md](../CHANGELOG.md) 的「未发布」记录用户可见变化，并单列实现 / 验证状态。完成有意义的一批功能后，先与用户核对内容、验证结果和仍有的限制，由用户确定版本号，再更新三个端版本及 Android versionCode、准备对应发布说明、构建并更新 App。不要因为功能代码完成就自行发布或预占版本号。

## 发布顺序

1. 用户确认版本号后，将 `CHANGELOG.md` 的本批「未发布」条目归入对应版本，并准备 `docs/releases/vX.Y.Z.md`，说明已实现能力、验证及限制。
2. 通过 PR 合并进入 main，确认主线 CI 与 Android APK 工作流成功。
3. 在这个已合并提交创建并推送 `vX.Y.Z` 标签。
4. **Release** 工作流核对标签、三个端版本及 main 祖先关系，重新执行完整 CI、Android 功能测试，构建固定签名 APK，并在模拟器实际安装 R8 正式包、检查连接页。
5. 全部通过后构建 Web ZIP 和 linux/amd64、linux/arm64 镜像，推送 GHCR，最后自动创建带全部附件的 GitHub Release。

工作流也支持手动重试：选择对应标签作为运行 ref，并填入同一 tag。工作流提交必须与标签一致，避免用另一提交的检查代替发布验证。只保存 Release 草稿或直接在网页发布 Release 不会触发构建。发布步骤失败时应先检查日志，再重跑同一标签；不移动已有发布标签。

发布产物：

- `wildstring-X.Y.Z-release.apk`：固定签名、R8 优化、无内置测试曲库的 Android 安装包。
- `wildstring-web-vX.Y.Z.zip`：Web 静态文件、LICENSE 与使用说明；运行时需要后端。
- `SHA256SUMS`：APK、Web ZIP、公开签名指纹文件的 SHA-256。
- `android-signing-certificate.sha256`：Android 发布签名的公开证书指纹。
- `ghcr.io/qingmuhy744/wildstring:vX.Y.Z`：同时包含后端、Web 与 FFmpeg 的双架构镜像；同时发布版本标签和提交标签。正式版更新 `latest`，预发布不更新。

Release 正文记录容器 manifest 摘要。首次推送后需要核对 GHCR 包可见性和匿名拉取；GitHub Release 可下载不代表镜像一定公开。不自动更新远程服务器。

## 下载与验证

用户从 [GitHub Releases](https://github.com/qingmuhy744/wildstring/releases) 直接下载 APK，无需解压 Actions artifact。Android 8.0 起可安装；真实服务器需要系统信任的 HTTPS。后续同一包名、同一发布密钥并递增 versionCode 后可覆盖升级。

开发测试包仍从 **Actions → Android APK → Artifacts → wildstring-android-debug** 下载并解压。它的临时签名可能随运行变化，不能代替正式发布签名。

手机和平板截图由 `UiAutomation.takeScreenshot()` 写入 AGP `additionalTestOutputDir`，测试卸载前取回；对应报告保留 14 天。发布 APK 的安装检查另外上传真实连接页截图。夹具只存在于独立测试 APK 中。模拟器通过不代表真机省电、后台兼容和全部音频编码均已验收。
