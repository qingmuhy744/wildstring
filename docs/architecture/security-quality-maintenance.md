# 安全与质量维护

安全与质量维护的实现记录；合并、CodeQL 复扫、发布和部署分别验收。

## 模块依赖

- `agent_common` 保存权限主体、工具定义和序列化等公共契约。助手、巡检、研究、通知和路由依赖契约；公共契约不反向导入平台或服务实现。
- `library.import_files` 保存导入与待整理流程共用的命名、哈希和安全复制函数，避免两种业务流程相互导入。
- `library.scope` 保存库身份、账号上下文、权限计算与设置解析；schema 36 的 SQL 独立于目录管理和存储实现。0.8.0 的循环依赖拆分、生成代码提示及路径误报依据见[逐条审查记录](codeql-0.8.0-review.md)。
- `source_models` 保存歌词候选的验证模型，来源管理与后台扫描共同使用。
- POSIX 目录遍历为每一个文件描述符设置 `finally` 关闭路径；仍使用目录描述符、`O_NOFOLLOW` 和排他发布保护只读导入源。

`ExitStack.enter_context(open_directory(...))` 接管目录上下文，退出时逆序触发各自的 `finally: os.close(...)`。针对扫描与导入分别验证正常退出、使用方抛错及中途拒绝符号链接三种路径；不依赖垃圾回收关闭目录。若分析器仅在 `enter_context` 调用处报告未关闭，应结合此所有权路径逐条审查，保留文件资源扫描规则。

## 客户端与插件

- Android 账户资料与登录会话均使用 Android Keystore 管理的 AES-GCM 密钥加密。启动时原子迁移各个已保存服务器的旧账户资料；清理或删除服务器时清除新旧字段，不轮换会话密钥。
- 系统栏使用 AndroidX Core 1.17 的 `WindowCompat.enableEdgeToEdge`，媒体控制器连接使用 `onConnectAsync` 和包含控制器参数的构造器，保留自身、受信任外部控制器和不受信任控制器的权限边界。
- Compose 仪器测试采用 `androidx.compose.ui.test.junit4.v2` 的规则工厂，使用 `StandardTestDispatcher` 排队执行组合协程；通过 `waitForIdle`、`runOnIdle` 和可观察的 UI 状态同步。旧 API 会在调用线程立即执行协程，迁移要求见 [Android 官方说明](https://developer.android.com/develop/ui/compose/testing/migrate-v2)。
- Web 导航计数使用 `Map`，切换入口验证已知视图；设计预览中的设置值以 `textContent` 输出。跨标签偏好测试通过另一个标签修改存储，触发真实的 `storage` 事件。
- 酷狗插件 1.1.2 的配置只保留元数据与歌词所需的公开平台参数，裁剪脚本同时更新来源哈希。独立导入的旧插件仍需升级 ZIP；本轮没有修改已部署插件。

`apk` 是每个 PR 的必需检查，Android 工作流的 PR 触发不设置路径过滤；主分支推送仍按路径过滤。这样文档或预览页修复也能提供合并规则所需的检查结果。

## 必须保留的行为

Last.fm 的 `api_sig` 使用其[官方认证协议](https://www.last.fm/api/authspec)规定的 MD5。它只用于该协议签名；用户密码不走此函数，不能直接替换算法而破坏服务兼容性。

Android 应用更新只下载固定 GitHub 仓库的正式发布资产，校验 SHA256、包名、签名与递增版本，并在安装前再次验证；最终仍由用户在系统安装界面确认。扫描发现 APK 安装 API 时应核对完整调用链。

Compose 编译器会生成名为 `$stable` 的静态字段，详见 [StabilityInferred](https://developer.android.com/reference/kotlin/androidx/compose/runtime/internal/StabilityInferred)。父类和 Room 生成子类中各自的字段属于编译器元数据，不直接修改构建输出，也不为此关闭整个规则。

## 验证边界

本地检查与 GitHub 告警状态分开记录。源代码改动完成后，仍需在获准推送后运行 CodeQL，确认实际剩余项，再按逐条证据处理协议约束与生成代码误报；不将本地测试通过写成线上告警已清零。

2026-10-18 本地已通过 `make ci`：后端 421 项通过、16 项因缺少本机媒体工具跳过；Web 主回归 216 项通过，真实大曲库与连续浏览另有 2 项和 12 项通过。隔离容器内后端 437 项全部通过，补齐 FFmpeg/Chromaprint 集成；容器冒烟检查通过。本机 AAC 浏览器集成仍需由具备 FFmpeg 的 GitHub CI 补跑。

Android 调试与发布构建、Lint、58 项 JVM 测试通过；API 35 模拟器上的 16 项针对性回归通过，并额外验证迁移后保留账户版本与启用状态。来源裁剪可重现校验及插件测试通过，酷狗 1.1.2 ZIP 校验通过，打包运行代码不再含旧微信字段及其值；不带个人 Cookie 的实际歌曲搜索返回 3 条结果。

应用更新另有 3 项模拟器测试通过，验证真实 APK 身份、签名与版本校验、仅开放私有更新目录的 FileProvider，以及更新界面不同阶段的操作限制。

修复合并后的主分支 `30c43b6` 已通过 GitHub 完整 CI：原生与容器后端分别 441 项、Web 234 项、Android JVM 58 项和 API 35 模拟器 72 项；四种语言 CodeQL 分析完成。Compose v2 调度与巡检加载门控的修复也包含在此回归中。原生完整回归同时在本地 Mac 模拟器运行过；正式 v0.5.5 标签的发布构建和下载产物另行验证。
