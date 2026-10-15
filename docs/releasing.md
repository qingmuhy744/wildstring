# CI/CD 与发布

## CI

`.github/workflows/ci.yml` 在 main 提交、PR、手动触发和 Release 复用调用时执行：安装锁定依赖 → hooks 与测试 → Web 构建 → 锁文件核验。独立任务构建并启动容器，实测 API、Web、FFmpeg、非 root 和只读音乐，结束时清理容器。

PR 工作流只具有仓库读取权限。

## GitHub Release

`.github/workflows/release.yml` 仅在 **GitHub Release 发布** 时执行；只推标签或保存草稿不会发布镜像。

先在同一提交更新后端 `pyproject.toml`、前端 `package.json` 及对应锁文件。

| Release 标签 | Python 版本 | Web 版本 |
| --- | --- | --- |
| `v0.1.0` | `0.1.0` | `0.1.0` |
| `v0.1.0-rc.1` | `0.1.0rc1` | `0.1.0-rc.1` |
| `v0.1.0-dev.0` | `0.1.0.dev0` | `0.1.0-dev.0` |

版本不一致时发布失败。通过完整 CI 后执行：

- 构建 Web ZIP，包含 LICENSE 和使用说明，生成 SHA256SUMS。
- 构建 linux/amd64 与 linux/arm64 镜像，推送到 `ghcr.io/qingmuhy744/wildstring`。
- 镜像内置 Web，记录源码与版本信息，生成 Release 和提交标签。
- 正式 Release 更新 latest；勾选预发布的 Release 不更新 latest。
- 将 Web ZIP 和校验和附到对应 GitHub Release。

使用 GitHub 内置 GITHUB_TOKEN，不将个人令牌放入仓库。首次发布后核对 GHCR 包可见性符合预期。

当前不会自动创建 Release、发布测试版本或更新远程服务器。原生安装包待客户端工程和签名方案确定后接入。

## Android 当前状态

Android 当前交付 [首版设计](product/android-v1.md) 与 [可点击草图](design/android-v1.html)，尚无 `frontend/android` 工程、Gradle Wrapper 或 APK 构建任务。合并这批设计只触发现有 Python/Web/容器检查；Actions 中目前没有可安装的 APK，HTML 草图也不是 APK。

| 流程 | 当前产物 |
| --- | --- |
| PR / main 的 `CI` | 检查和测试结果，不生成 Android 安装包 |
| 发布 GitHub Release 的 `Release` | 容器镜像、Web ZIP 与校验和 |
| 计划中的 Android CI | 客户端工程实现后，执行检查/测试与 `assembleDebug`，上传可下载的 debug APK；尚未接入 |

第一个测试 APK 需要在同一交付中补齐 Kotlin/Compose/Media3 工程、锁定的构建依赖、Make 入口和 Actions 产物上传，并实测 APK 可以安装与运行。正式 release 包还需要独立的版本与签名配置；私钥仅放在未跟踪的本地文件或 CI secrets 中。不能以设计 PR 或现有 Web CI 通过代替 Android 构建成功。

## 本地 Web 打包验证

本地验证当前开发版打包，不触发外部发布：

```sh
make build-web
python3 scripts/package_release.py --tag v0.1.0-dev.0
```
