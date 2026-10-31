# ADR 0004：iOS 原生客户端

日期：2026-10-19。状态：草案——关键选型已确认（播放鉴权/缓存、会话、持久化），最低系统 iOS 17；不做商店分发（开发者账号未过审）；工程未创建、未实现。产品范围与目标见 [iOS 第一版](../product/ios-v1.md)。

## 决策

iOS 使用 **Swift 6 + SwiftUI + AVFoundation** 原生实现，与已有 FastAPI 服务通过现有业务 API 通信；网络用 URLSession，凭据用 Keychain，队列与恢复点用 SwiftData，包管理用 SPM，源码放 `frontend/ios`，与 `frontend/android`、`frontend/web` 并列；最低支持 iOS 17。不引入第三方播放器、网络或 DI 框架。

| 组件 | 职责 |
| --- | --- |
| Swift 6 / Swift Concurrency | 逻辑、取消请求与可观察状态；async/await、AsyncStream、@Observable |
| SwiftUI + NavigationStack | 原生界面、导航与无障碍；沿用野弦品牌主题；iPhone/iPad 自适应 |
| AVPlayer | 原音串流、跳转与播放队列；由播放服务唯一持有 |
| AVAudioSession | 后台音频、音频中断与路由变化（`playback` 类别 + 后台音频模式） |
| MPNowPlayingInfoCenter / MPRemoteCommandCenter | 锁屏、控制中心与耳机键；不做 CarPlay |
| URLSession | REST、Cookie 会话、超时与认证；与播放数据源共用同一凭据 |
| Keychain | 会话 Cookie 加密保存，不参与备份/同步；不入 SwiftData、日志或明文偏好 |
| SwiftData | 队列条目/恢复点与经缓存策略允许的元数据；不保存会话秘密 |
| 手写依赖注入 | 沿用“不强行拆分大量模块”的原则，不引入 DI 框架 |

```mermaid
flowchart TD
    UI[SwiftUI 屏幕] --> VM[@Observable 状态]
    VM --> REPO[仓储]
    REPO --> API[URLSession]
    REPO --> LOCAL[SwiftData]
    API --> SERVER[野弦 FastAPI]
    UI <-->|播放命令与状态| SERVICE[PlaybackService]
    SERVICE --> PLAYER[唯一 AVPlayer]
    SERVICE --> SESSION[AVAudioSession 后台音频]
    PLAYER --> MEDIA[锁屏 / 控制中心 / 耳机]
    SERVICE --> RESTORE[队列 / 位置持久化与收听上报]
    RESTORE --> REPO
```

iOS 不会自动获得离线下载、无缝播放、全编码兼容或 AI 能力；两端共享服务端业务、协议、资产与设计语言，UI 与播放器分别原生实现（同 [ADR 0003](0003-native-android.md)）。

## 关键选型（已确认）

### 1. 播放鉴权与片段缓存

约束：曲目与 Range 串流走 Cookie 认证；AVPlayer 的公开请求头控制有限（`AVURLAssetHTTPHeaderFieldsKey` 非公开），且没有公开的磁盘缓存 API。

**决策：采用 AVAssetResourceLoaderDelegate 自建数据源**。AVPlayer 以自定义 scheme 请求资源，数据源用 URLSession（公开 API，自带 Cookie 保存与注入）取字节并处理 Range。不采用：直连 + 非公开头注入（无法做缓存、依赖未文档化键）；应用内回环代理（多一个监听端口与后台生命周期问题，留作备胎）。

落地分两步（内部批次，最终范围不变）：

1. 资源代理只做转发：AVPlayer 要哪段字节就带 Cookie 取哪段，先跑通播放闭环（鉴权、seek、后台、锁屏）。
2. 在同一层加磁盘缓存：取字节前先查本地，未命中再取并落盘；容量上限与退出清理都在这一层。

离线下载用 `URLSession` 后台配置单独实现，不经过资源代理，与片段缓存分开管理（对齐 Android 两套策略）。

### 2. 会话与凭据

沿用服务端 7 天可撤销 Cookie 与写请求 `X-Wildstring-Client` 机制。**决策：Cookie 数据保存进 Keychain**（`kSecAttrAccessibleAfterFirstUnlock`，不参与备份），启动时注入 `HTTPCookieStorage`，供 URLSession 与媒体请求共用；401 统一停受保护播放并回登录。每服务器独立存储空间，退出只清当前服务器。不在客户端延长有效期，不新增 Bearer / refresh-token。

后端配套小改动：`backend/src/wildstring/auth.py` 的 `require_client` 白名单从 `web|android` 扩为含 `ios`，同步契约表述与兼容测试；旧服务返回 `client_header_required` 时沿用 Android 的 Web 标识重试策略。Mac 客户端使用 `macos`，同样在旧服务上退回 `web`。

### 3. 本地持久化

**决策：采用 SwiftData**（最低 iOS 17 已确认，测试设备均满足）。存储面小（队列条目、恢复点、缓存元数据），无跨端同步需求，系统自带、零依赖。

备选 GRDB（迁移与 SQL 控制更精确，多一个依赖）：仓储接口收口，若并发/迁移受限可切换而不影响调用方；Core Data 不在新工程优先。

## 状态与生命周期

- 播放器只由 PlaybackService 创建与释放（对应 Android 的唯一 ExoPlayer）；视图经 @Observable 订阅状态，不各自建 AVPlayer。
- 队列条目 ID 与曲目 ID 分开，允许同曲重复；暂停继续保留一次收听 UUID，主动重播用新 UUID；有效播放增量排除暂停、缓冲与跳转，每约 5 秒及重要状态变化上报，以服务端 `accepted_ms` 为准。
- 后台播放依赖 `audio` 后台模式与 AVAudioSession；进程被系统回收后重建为暂停恢复；仍有后台音频时重连同一播放器。
- 音频中断按平台规则处理：来电/抢占暂停或 duck、耳机拔出暂停、恢复遵循用户意图；与 Android 同类规则，真机验收。

## 连接、网络与边界

- 默认 HTTPS + 系统证书校验，不提供跳过 TLS 的开关。ATS 例外是静态 Info.plist，无法运行时按服务器动态放开；首版对齐 Android 现状：Release 仅 HTTPS，Debug 对 localhost 类地址放开明文联调；「任意自托管 HTTP 开关」两端都留作后续。
- 跨 origin 重定向拒绝携带认证，拒绝 HTTPS→HTTP 降级；API、封面与音频共用同一鉴权上下文。
- 服务端仍是曲目、收藏、歌单与统计的事实来源；客户端不做全曲库镜像、不做离线修改合并。

## 数据与缓存

- 本地键由连接空间 ID、规范化 origin/base path 与实体 ID 组成；队列另有 entry ID。
- 片段缓存与离线下载分开管理，沿用 [Android 缓存策略](../architecture/android-cache.md) 的原则：连接空间隔离、容量上限可调、退出/换服务器清理、通用 HTTP/图片磁盘缓存保持关闭；离线副本使用前核验权限与文件版本。
- 服务端歌单带 `version`，冲突先刷新再让用户重做，不自动重放旧排序。

## 工程与验证

- 目录：`frontend/ios` 单 app 工程 + 本地 Swift Package 分层（Core/Network、Core/Data、Playback、Features/*）；工程生成方式与依赖锁随骨架批次确定（配置入库、生成物不提交）。
- 最低 iOS 17 已确认（SwiftData 与 NavigationStack 要求，测试设备均满足）；若未来需要支持更旧系统，按仓储接口切换 GRDB 并降级相应 API。
- 测试：单元（Swift Testing）、UI 回归（XCUITest，模拟器）、对临时合成曲库的集成测试（复用 Android 的 `realBackend` 思路，测试参数指向临时实例）；模拟器截图随 CI 保存。
- 真机验收清单：后台/锁屏/耳机键/音频中断/断网/大曲库浏览与拖拽。
- CI：GitHub Actions macOS runner 构建与测试（仓库公开，macOS 分钟免费）；因无商店分发，不引入 fastlane / Xcode Cloud 签名上传链；需要时再评估。
- Make 入口（后续实现）：`make ios-ci`、`make ios-test` 等，与现有习惯对齐。

## 发布

Apple 开发者账号未过审，首版不做 TestFlight / App Store 与公开分发。本机验证用免费个人团队自动签名安装（7 天有效期，过期重装）；朋友试用、侧载与商店提交等账号可用后再单独设计。不做客户端自更新。

## 边界与不做

- 不做 App Store / TestFlight 分发（开发者账号未过审；账号可用后再评估）；不做 CarPlay、小组件与上传入口。
- 不内置演示数据；空态、错误与加载状态真实呈现；模型不可用不影响基础播放。

## 参考

- [AVAudioSession](https://developer.apple.com/documentation/avfaudio/avaudiosession)
- [MPNowPlayingInfoCenter](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter)
- [AVAssetResourceLoaderDelegate](https://developer.apple.com/documentation/avfoundation/avassetresourceloaderdelegate)
- [SwiftData](https://developer.apple.com/documentation/swiftdata)
- [URLSession 后台传输](https://developer.apple.com/documentation/foundation/urlsession)
