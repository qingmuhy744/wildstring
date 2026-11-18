状态：已实施

# Android 模拟器测试向 JVM Robolectric 分层迁移

## 目标

将不依赖真实音频硬件解码、系统网络开关、多窗口缩放或截图渲染的纯逻辑、存储、加密会话与组件单测从云端 Android 模拟器（`src/androidTest`）迁入本地与 `make android-ci` 可秒级执行的 JVM / Robolectric 套件（`src/test`），缩短回归时长并降低模拟器宿主机抖动面。

## 不碰的边界

- 不放宽任何原有测试断言；若某个类在 Robolectric SDK 37 下无法保持等价语义，保留在 `src/androidTest`。
- 本分支第一批不改动外部依赖版本与 Gradle 锁文件／`verification-metadata.xml`（避免 macOS/Linux 校验条目混改）。
- 保留真实后端联调、真实音频播放与服务生命周期、系统网络切换、以及窗口缩放／截图验收类在模拟器套件中。

## 方案

将 `src/androidTest` 的 51 个测试类按运行期依赖分为三层：

1. **第一批（本分支已落地，零依赖锁文件变更）**：6 个纯 HTTP 夹具、SharedPreferences/AppSettings 隔离、Room 1→2 迁移与多服务端加密会话隔离测试类迁移至 `src/test`，并将共用音频响应夹具 `AudioStreamFixture.kt` 迁至 `src/sharedTest/kotlin`：
   - `AudioStreamFixtureTest`（纯 JVM + MockWebServer）
   - `AccountPreferencesTest`（Robolectric Context + AppSettings/AccountPreferences）
   - `PodcastCheckpointStorageTest`（Robolectric Context + Room 1→2 迁移）
   - `AccountPrivacyTest`（Robolectric + `MemorySessionKey` Shadow 验证 `SessionStore` 加密迁移）
   - `CachePrivacyTest`（Robolectric + `MemorySessionKey` Shadow 验证缓存目录与 Cookie 作用域隔离）
   - `ServerSessionTest`（Robolectric + `MemorySessionKey` Shadow + 测试音频 assets 验证多服务端原子切换与离线文件隔离）
2. **第二批（后续随 Compose JVM 测试依赖锁更新推进）**：约 16 个纯 Compose 状态／布局／MockWebServer 测试类（`AgentInboxTest`、`AssistantMarkdownTest`（拆分截图逻辑后）、`BilingualLyricTest`、`CatalogInputGestureTest`、`CatalogToolbarLayoutTest`、`DiscoveryShortcutsLayoutTest`、`LyricGestureTest`、`MovableTextFieldTest`、`OptimisticActionsTest`、`PlayerDismissCompositionTest`、`PodcastArticleTest`、`PodcastArtworkTest`、`PodcastPresentationTest`、`PodcastQueuePreferenceTest`、`PodcastStreamTest`、`QueueReorderTest`、`SettingsPageGestureTest`、`PodcastQueueDetailLayoutTest` 等非真设备依赖部分），补充 Compose Desktop/Robolectric 测试产物并在 Linux 校验条目补齐后迁移。
3. **保留在模拟器上的核心端到端套件**：
   - `realBackend` 真实后端集成：`AgentRealBackendTest`、`PlaybackIndicatorRealBackendTest`、`RealBackendCompletionTest`、`RecommendationRealBackendTest`
   - 真实播放／下载／媒体会话服务：`AppUpdateTest`、`NativeNavigationTest`、`NativePlaybackTest`、`PlatformMediaSessionTest`、`PodcastPlayRequestTest`、`PodcastResumeServiceTest`、`PodcastTransportServiceTest`
   - 系统环境与多窗口／逐帧／截图视觉回归：`ArtworkNetworkTest`（`svc wifi/data`）、`AccountPlaybackTest`、`AgentWorkspaceTest`、`CatalogBrowseLayoutTest`、`ContinuousCatalogTest`、`MobileCompletionTest`、`MultiServerUiTest`、`PadLayoutTest`、`PodcastGainTest`、`PodcastPlayerLayoutTest`、`PodcastResumeUiTest`、`PodcastTabTransitionTest`、`RecommendationExperienceTest`、`SettingsExperienceTest`、`SongAlbumNavigationTest`、`SourceGainWorkspaceTest`

## 验收

- **L1/工程验证**：`make check`、`make android-ci`（验证 `:app:testDebugUnitTest` 覆盖全部新增 JVM/Robolectric 用例、`:app:compileDebugAndroidTestKotlin` 编译剩余 `androidTest`、Debug/Release Lint 与打包全绿）。

## 风险与回滚

- **Android KeyStore 在 Robolectric 的差异**：`SessionStore` 在真实设备依赖 Android KeyStore；沿用 `PodcastProgressNetworkTest.MemorySessionKey` Shadow 仅替换密钥生成方法并保持静态共享密钥，加解密、存储格式与失败回退仍执行真实 `SessionStore` 代码，同时保留 `SettingsExperienceTest` 等设备端真实流程覆盖。
- **回滚方式**：单个文件 `git mv` 回 `src/androidTest/java/com/wildstring/app/` 并移除 `@RunWith`/`@Config` 即可恢复原位。
