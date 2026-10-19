# ADR 0004：iOS 原生客户端

日期：2026-10-19。状态：草案——关键选型待评审；工程未创建、未实现。产品范围与目标见 [iOS 第一版](../product/ios-v1.md)。

## 决策

iOS 使用 **Swift 6 + SwiftUI + AVFoundation** 原生实现，与已有 FastAPI 服务通过现有业务 API 通信；网络用 URLSession，凭据用 Keychain，队列与恢复点用 SwiftData，包管理用 SPM，源码放 `frontend/ios`，与 `frontend/android`、`frontend/web` 并列；最低支持 iOS 17。不引入第三方播放器、网络或 DI 框架。以下为拟定方案，「关键选型」三节确认后定稿。

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

## 关键选型（待评审）

### 1. 播放鉴权与片段缓存

约束：曲目与 Range 串流走 Cookie 认证；AVPlayer 的公开请求头控制有限（`AVURLAssetHTTPHeaderFieldsKey` 非公开），且没有公开的磁盘缓存 API。

- **A 直连 + 头注入**：最快打通播放；无片段缓存，依赖非公开键，无法对齐 0.5.6 的缓存能力。
- **B AVAssetResourceLoaderDelegate 自建缓存**（推荐）：完全控制鉴权、Range 与缓存，无额外端口；实现量与并发/失效处理最重。
- **C 应用内回环代理 + AVPlayer**：鉴权与缓存复用一套 HTTP 逻辑、调试直观；多一个监听端口，后台挂起边界要专项验证。

推荐 **B**，分两步落地：先以 A 的最小形态（同一数据源抽象）验证播放闭环，再实现缓存；离线下载用 `URLSession` 后台配置单独实现，与片段缓存分开管理（对齐 Android 两套策略）。

### 2. 会话与凭据

沿用服务端 7 天可撤销 Cookie 与写请求 `X-Wildstring-Client` 机制。推荐把 Cookie 数据保存进 **Keychain**（`kSecAttrAccessibleAfterFirstUnlock`，不参与备份），启动时注入 `HTTPCookieStorage`，供 URLSession 与媒体请求共用；401 统一停受保护播放并回登录。每服务器独立存储空间，退出只清当前服务器。不在客户端延长有效期，不新增 Bearer / refresh-token。

后端配套小改动：`backend/src/wildstring/auth.py` 的 `require_client` 白名单从 `web|android` 扩为含 `ios`，同步契约表述与兼容测试；旧服务返回 `client_header_required` 时沿用 Android 的 Web 标识重试策略。

### 3. 本地持久化

- **SwiftData**（推荐）：系统自带、代码量小；本项目表少（队列条目、恢复点、缓存元数据），无跨端同步需求。
- **GRDB**：迁移与 SQL 控制最精确；多一个依赖。
- **Core Data**：成熟但样板多，新工程不优先。

推荐 **SwiftData** 起步；仓储接口收口，若并发/迁移受限可换 GRDB 而不影响调用方。

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

- 目录：`frontend/ios` 单 app 工程 + 本地 Swift Package 分层（Core/Network、Core/Data、Playback、Features/*）；依赖锁版本，Xcode 工程文件入库。
- 最低 iOS 17（SwiftData 与 NavigationStack）；开工前确认测试朋友的设备下限，若需支持 iOS 16 则改用 GRDB 并降级相应 API。
- 测试：单元（Swift Testing）、UI 回归（XCUITest，模拟器）、对临时合成曲库的集成测试（复用 Android 的 `realBackend` 思路，测试参数指向临时实例）；模拟器截图随 CI 保存。
- 真机验收清单：后台/锁屏/耳机键/音频中断/断网/大曲库浏览与拖拽。
- CI：GitHub Actions macOS runner 构建与测试；签名构建与 TestFlight 上传用 fastlane 或 Xcode Cloud（待定）；发布签名只放本地未跟踪配置或 CI secrets。
- Make 入口（后续实现）：`make ios-ci`、`make ios-test` 等，与现有习惯对齐。

## 发布

TestFlight 外部测试（朋友试用）；首个外部构建过 Beta App Review，在 Test Information 提供演示服务器与测试账号；构建 90 天有效期，按周期续期；不做客户端自更新。

## 边界与不做

- 不做 App Store 上架（后续独立评估）；不做 CarPlay、小组件与上传入口。
- 不内置演示数据；空态、错误与加载状态真实呈现；模型不可用不影响基础播放。

## 参考

- [AVAudioSession](https://developer.apple.com/documentation/avfaudio/avaudiosession)
- [MPNowPlayingInfoCenter](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter)
- [AVAssetResourceLoaderDelegate](https://developer.apple.com/documentation/avfoundation/avassetresourceloaderdelegate)
- [SwiftData](https://developer.apple.com/documentation/swiftdata)
- [URLSession 后台传输](https://developer.apple.com/documentation/foundation/urlsession)
