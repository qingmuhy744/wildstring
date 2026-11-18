状态：已实施

# CI 流水线提速与 Android 模拟器自愈

## 目标

在不改写业务功能与 Android 依赖锁的前提下，缩短常规 CI 与 Release 周期、提升 Android 设备分片负载均衡与掉线自愈能力：

- 将 `Web E2E Tests` 从单机串行执行改为 5 路并行矩阵分片，结合 Playwright 版本与 `.deb` 系统依赖离线缓存，显著压缩浏览器回归墙钟耗时，并在下游保留同名必检门禁与合并后的 `browser-visual-evidence` 截图产物。
- 将 `make android-ci` 两次串行 Gradle 调用合并为单次任务图并行执行，并启用 `setup-uv` 依赖缓存。
- 为 Android 模拟器分配 `cores: 4` 与 `-no-metrics`，将分片策略由按类名模切升级为按已发现用例数均衡分配，并在 QEMU/SwiftShader 崩溃掉线后快速探测与自动重启拉起，继续完成剩余测试类与失败重试。

## 不碰的边界

- 不修改任何业务源码与测试断言；不调整 Android Gradle 依赖锁文件与 `verification-metadata.xml`（Android 第二批 Compose Robolectric 迁移保持在 [Android 测试分层迁移方案](android-robolectric-test-migration.md) 中独立推进）。
- 不删减任何必检质量门禁或分支保护规则名称（`Web E2E Tests`、`apk`、`Code Quality & Packaging` 等保持与仓库规则一致）。
- 不放宽 Playwright（Desktop + Mobile、`workers: 1`）与 Android 设备用例的并发/隔离前提，保证状态隔离与截图产物完整。

## 方案

1. **Playwright 浏览器与系统依赖缓存**
   - 新增 `scripts/install_playwright_chromium.sh`：先执行 `playwright install chromium`（命中 `~/.cache/ms-playwright`）；再以 `playwright install-deps --dry-run chromium` 探测系统依赖是否就绪，就绪则零 `apt-get` 耗时直接退出；未就绪时优先离线安装 `~/.cache/apt-archives/*.deb`，缺失时才联网安装并回存 `.deb` 缓存。
   - 在 [ci.yml](../../.github/workflows/ci.yml) 中提取 `frontend/web/package-lock.json` 的 `@playwright/test` 精确版本作为缓存键并配置 `restore-keys`，避免日常版本号或无关包变动使浏览器与 `.deb` 缓存整库失效。
2. **Web E2E 5 路并行分片与汇总门禁**
   - 在 [Makefile](../../Makefile) 中增加 `SKIP_WEB_BUILD` 与 `WEB_TEST_ARGS`，令各分片仅构建一次 Web 并传入各自的 `--shard` 与 `--output` 目录，复用同一套 `Makefile` 环境变量和 spec 清单。
   - 新增 `scripts/run_web_ci_shard.py` 及测试，按实测耗时将 8 个 Web 测试目标均衡拆至 5 个分片。
   - [ci.yml](../../.github/workflows/ci.yml) 用 `web_shard`（`matrix.shard: [0..4]`）并行执行，再由同名 `web`（`Web E2E Tests`）下载各分片视觉证据合并上传为单一 `browser-visual-evidence` 产物、生成摘要链接并汇总判定通过状态。
3. **Android 构建合并与模拟器均衡/自愈**
   - [Makefile](../../Makefile) 将 `android-ci` 的两次 Gradle 调用合并为单次任务图调度，让 `--parallel` 同时调度单测、androidTest 编译、R8 与 Lint。
   - `scripts/run_android_instrumented.py` 将分片算法改为按类内用例数降序贪心分配，避免重量级长测试集中落入同一分片；遇到异常退出的类时先做 5 秒 `device_ready(timeout=5)` 探活，掉线时免等 120 秒 `logcat` 超时；新增 `--recover-device` 钩子与 `--max-device-restarts`，调用 `scripts/ci_recover_emulator.sh` 自动拉起崩溃的 `test` AVD、重新部署包与中文设置后续跑剩余类并在下一轮重试被中断的类。
   - [android.yml](../../.github/workflows/android.yml) 将模拟器核数从 `2` 调高至 `4` 并添加 `-no-metrics`，在 `emulator`、`quality`、`backend`、`web_shard` 启用 `setup-uv` 缓存。

## 验收

- **L0/工具单测**：`pytest` 执行 `backend/tests/test_web_ci_shard.py`、`backend/tests/test_android_instrumented_runner.py`、`backend/tests/test_release_verify_scope.py` 与 `backend/tests/test_ci_changed_areas.py` 全绿。
- **L3/工作流实测**：`make check` 与单次调用的 `make android-ci` 通过；PR 上 `CI`（含 5 个 `Web E2E Shard` 与汇总 `Web E2E Tests`、`browser-visual-evidence` 产物）、`Android APK`、`CodeQL`、`Backend Tests`、`Container Smoke & Test` 全绿；针对性手动触发 `android.yml`（`run_emulator=true`、`test_classes=NativePlaybackTest`）验证 4 核参数与设备执行路径通过。

## 风险与回滚

- **Web `browser-visual-evidence` 文件重名覆盖**：所有 spec 的显式截图文件名已按主题或 `{project}-{theme}` 命名，Playwright 失败诊断目录则通过 `--output=../../artifacts/browser-tests/<slug>` 隔离，避免同一分片或合并下载时相互覆盖。
- **模拟器自愈上限**：`--max-device-restarts` 默认限制最多重启 2 次，防止宿主机底层虚拟化故障导致作业卡死至超时上限。
- **回滚**：还原 `.github/workflows/ci.yml`、`.github/workflows/android.yml`、`Makefile` 与 `scripts/run_android_instrumented.py` 即可退回改动前行为。
