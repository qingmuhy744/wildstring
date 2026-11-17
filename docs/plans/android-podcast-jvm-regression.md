状态：已交付于 PR #158

# Android 播客规则的 JVM 回归与发布门槛

## 目标

将播客进度网络规则纳入普通 PR 已有的 JVM 单测，在打标签前一次性完成待发布提交的完整设备回归。

## 不碰的边界

- 不修改播放产品规则、生产代码、版本号或发布标签。
- 普通 push / pull_request 不启动模拟器；每周、手动及 Release 的设备回归触发策略保持现状。
- MediaSession、服务存活、播放衔接和界面截图继续由设备测试覆盖。

## 方案

1. 单独提交工作流程文档：`AGENTS.md` L3 明确待发布 main 提交必须先通过 `run_emulator=true` 的 Android APK 完整设备回归，`test_classes` 留空；修复后必须验证最终提交。统一 §4 的表述，方案模板补充修改规则前查找旧断言的要求。
2. 将 `PodcastProgressNetworkTest` 的全部 5 个用例从 `androidTest` 移入 `test`，保留真实 HTTP、Repository 与 Room：自动跳过完成单集、主动重播、询问与从头播放、同设备重试、异设备冲突、离线重试及历史补传。
3. 引入固定版本 Robolectric，测试使用独立 Application 与合成账号／临时数据库。固定 Android SDK 版本，通过 Gradle 解析并校验 SDK JAR，关闭 Robolectric 自行下载依赖。历史补传的十秒节流使用虚拟 Android 时钟推进。
4. 更新锁文件、SHA-256 元数据与 Android 测试说明，核对现有 Linux aapt2 校验仍然保留。现有 `make android-test` / `make android-ci` 自动执行迁移的规则用例。

## 验收（按 AGENTS.md §3 定级）

按 L3 依赖改动处理；没有生产 UI 改动。执行 `make check`、`make ci` 与 `make android-ci`，单独确认迁移类的 5 项在 JVM 上被发现并通过、设备源码仍可编译。核对规则测试不再被设备运行器发现。依赖解析须在严格校验下通过；新 PR 的 Actions 结果另行记录。

完整模拟器与真机 UAT 不由这次规则迁移代替；本次不发版。其他原生端、容器部署及视觉／动画验收不在改动范围。

## 风险与回滚

- 已用 `git grep` 检查完成单集、读写计数与旧断言位置：`PodcastProgressTest` 保留纯规则单测，网络用例整体迁移；`PodcastResumeServiceTest` / `PodcastResumeUiTest` 保留服务与界面的集成验证。
- Robolectric 主线程调度与真实设备不同，保留真实 HTTP 与数据库，使用独立运行的主 Looper；不为迁移修改生产调度逻辑。
- SDK JAR 首次下载增加 JVM 测试冷启动成本，由 Gradle 缓存复用。
- 测试迁移与流程文档分别提交；需要回滚时撤销迁移提交，恢复原设备规则测试，发布前完整回归要求仍有效。

## 实施与验证记录

- 5 个网络规则用例整体迁入 JVM，原有 47 条断言保持一致。AndroidKeyStore 只在测试中替换密钥生成，凭据加解密、HTTP、Repository 和内存 Room 仍执行真实实现。
- `make android-locks`、严格依赖校验下的 `make android-ci` 已通过；JVM 共 176 项通过，其中迁移类 5 项合计约 6.5 秒。Debug／Release 构建与 Lint、设备测试源码编译通过。
- 原有 2257 个依赖文件校验值全部保留，包括 5 个 Linux aapt2 条目；生产 Debug／Release 的编译和运行依赖未变化。
- `make ci` 与远程 Actions 结果在 PR 中记录；完整设备回归、真机 UAT 及发布不在本次验证结果内。
