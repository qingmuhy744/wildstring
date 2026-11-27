状态：已实施

# main 浏览器与 Android 构建稳定性修复

## 范围

处理 a4f3caec 上的 Web E2E 滚动断言和 Android APK 插件解析失败，并核对 Java/Kotlin CodeQL 的同类失败。保留应用交互、断言强度、依赖版本、校验元数据、签名和模拟器触发规则。

## 实施与验收

- 区分页面因点击前准备而发生的滚动和应用处理点击后的滚动。用窄屏复现滚动时序，继续检查展开后的逐帧位置与试听内外滚动边界；同步消除播客暂停后立即读取 `session_id` 的异步竞态。
- 核对主线和历史 Gradle 失败日志，为 5 个已声明插件坐标限定对应仓库以减少重复查询。对可识别的仓库限流、瞬时 5xx/网络抖动与插件解析失败使用有界重试，并在重试时开启堆栈输出以便在 CI 日志中保留真实底层异常；同步为 `android.yml`、`codeql.yml`、`release.yml` 与 `dependency-submission.yml` 关闭 `setup-gradle` 清理、放宽冷缓存重跑阈值（`run_attempt > 2`）、为 `android-release` 补齐重试并为依赖图提交补齐 Android 路径过滤。
- 使用隔离的 HTTP 仓库验证依赖恢复，运行相关 Web 用例、Android 构建入口、工作流静态检查和 `make check`，并在 GitHub Actions 上核验真实 Runner 恢复效果。
