状态：已实施

# Android 端书架体验升级、统一听书播放与便携侧车对齐方案

## 目标

将 Android 原生客户端（兼容手机 `1080×1920` 与平板 `2560×1600`）升级至与 Web 及 Schema 58 后端一致的产品形态、交互层次与侧车语义：

1. **Web 与 Android 导航拆分**：
   - Web 侧栏与移动端「浏览方式」下拉拆分为独立的「电台 · 播客」(`podcasts`) 与「书架」(`books`)，取消播客页与书架页的顶栏下拉切换器；书架页展示清晰顶部标题与管理入口，点击底部有声书停靠条跳转至 `books`。
   - Android 平板（`≥600dp` `NavigationRail`）保留全部 6 项独立入口（发现 · 曲库 · 电台 · 书架 · 助手 · 我的）；手机端（`<600dp` `NavigationBar`）保持 5 栏平衡布局（发现 · 曲库 · 电台 · 书架 · 我的），并将「AI 助手」图标按钮收进 `CatalogTopBar` 右上角操作区。
2. **书架浏览页降噪与视觉对齐**：采用统一 `10dp` 圆角搜索框与并排「上传电子书」入口、紧凑下拉筛选胶囊（书库、载体、阅读状态）和暖珊瑚色快速继续胶囊；卡片使用自适应多列网格（最小列宽 `260dp`）及统一尺寸封面/衬线首字占位，保证无封面书籍与有封面书籍正文左缘严格对齐，同步提供多列骨架屏及静默空/错态。
3. **书籍详情页章节直出与折叠管理**：详情页首屏直接呈现可按需切换的「有声章节 / 阅读目录」列表（有声章节点击即播且支持管理员校对章名，电子书目录点击即直达对应章节），同时将标题修改、在线搜刮（Open Library / Google Books / Apple iTunes）、上传封面、补传电子书及清晰语义的「合并版本 / 版本拆分」收进默认折叠的「整理与编辑」面板。
4. **底部统一听书条与全屏有声书播放器**：移除详情页顶部割裂的「正在收听」横幅及散落文本按钮；新建 `BookPlaybackController` 协调 `BookPlaybackService` 与主音乐/播客 `PlaybackService` 的单音频焦点互斥，在底部共用 `MiniPlayer` 位置提供 `BookMiniPlayer`，点击展开适配手机/平板双栏章节面板的全屏 `BookAudioPlayerScreen`（`-15s`/上章/播放暂停/下章/`+30s`、等宽时间轴、倍速、睡眠定时、`结束听书`）。
5. **沉浸单顶栏阅读器与批注文字升级**：
   - Web 阅读器升级：目录/笔记/搜索/排版面板改为右上角非重排浮层抽屉（不再下推正文）；批注列表改为左侧 `3px` 色条引导的编辑式卡片并支持查看、填写与修改批注文字（复用现有 `POST/PUT /api/v1/books/{id}/annotations` `note` 字段）；划词工具条改为紧跟选区矩形上方（近顶自动下翻）的 4 色圆点 +「写批注」紧凑浮条，并支持点击正文已有高亮编辑；阅读内伴读控制精简为单行紧凑条。
   - Android 阅读器升级：进入电子书阅读自动隐藏 `CatalogTopBar`，保留单行纸张配色顶部阅读栏与既定悬浮工具/抽屉动画；补全 `BookAnnotation.note` 模型、创建与编辑批注对话框（可选输入批注文字并 `PUT` 更新）以及左侧色条卡片展示。
6. **音乐 `.wildstring/` 侧车状态同步与模拟器稳定加速配置**：在 [LibraryManagementTools.kt](../../frontend/android/app/src/main/java/com/wildstring/app/ui/LibraryManagementTools.kt) 中识别经 `.wildstring/lyrics/<sha256>.json` 删库恢复出的逐字与双语/音译歌词并展示清晰来源标签，并更新元数据编辑提示文案明确覆写同步至便携侧车；本机 `wildstring-phone` / `wildstring-pad` AVD 统一使用与 CI 对齐的 `android-35;default;x86_64` 系统镜像并限制为 `hw.cpu.ncore=4` / `hw.gpu.mode=auto` / `hw.keyboard=yes`，[scripts/agent_shot.sh](../../scripts/agent_shot.sh) 与新增的 `make android-emu` / `make android-emu-pad` / `make android-emu-stop` 使用 `-cores 4 -gpu swiftshader -feature -Vulkan`，避免 Mesa 25.2.8 / Android 16 无头采样导致的 `SurfaceFlinger` 崩溃并支持一键启动安装。

## 不碰的边界

1. **保持 `BookReaderPanel` 与 `BookReaderToolbar` 动效与测试桩不变**：保留 [BookReaderPanel.kt](../../frontend/android/app/src/main/java/com/wildstring/app/ui/BookReaderPanel.kt) 既有的 `240ms FastOutSlowInEasing` 平移透明度动画、减少动态效果一帧落位及测试 tag（`book-reader-stage`、`book-reader-panel`、`book-reader-tools`）。
2. **不打破现有音乐与播客播放状态**：音乐与播客的 `QueueDatabase` 表结构、队列及 `PodcastCheckpoint` 保持不变，有声书继续完全隔离于音乐队列及播客待播列表之外。
3. **R8 与双语资源一致性**：新增 Gson 网络模型保留完整 `@SerializedName` 与可空默认值；`values/strings.xml` 与 `values-zh/strings.xml` 保持严格 1:1 键值与格式占位符对齐。
4. **合成测试夹具不污染用户真库与 Web 测试**：仅在显式开启 `WILDSTRING_TEST_API_ONLY=1` 或 `WILDSTRING_TEST_BOOKSHELF=1` 时向 [scripts/serve_web_tests.py](../../scripts/serve_web_tests.py) 注入 Android 设备端回归所需的 `"Portable Pages"` 与有声书夹具，不影响既有 Web Playwright 夹具。

## 方案

- **数据层与播放控制**：扩展 [Books.kt](../../frontend/android/app/src/main/java/com/wildstring/app/data/Books.kt)、[Api.kt](../../frontend/android/app/src/main/java/com/wildstring/app/data/Api.kt)（补全书籍单本详情、元数据更新/在线搜刮、有声章名修改、封面/电子书补传、配对与拆分端点）、[BookPlaybackService.kt](../../frontend/android/app/src/main/java/com/wildstring/app/playback/BookPlaybackService.kt)（新增 `STOP_CLEAR` 自定义指令），并新增 `BookPlaybackController` 接入 [MusicViewModel.kt](../../frontend/android/app/src/main/java/com/wildstring/app/ui/MusicViewModel.kt)。
- **导航与播放壳层**：升级 [LibraryChrome.kt](../../frontend/android/app/src/main/java/com/wildstring/app/ui/LibraryChrome.kt) `CatalogTopBar`（在手机端右上角操作区承接 `nav-assistant`，将底层导航栏拆分为独立的「发现 · 曲库 · 电台 · 书架 · 我的」，并在平板端 `NavigationRail` 保留全部 6 项独立入口）、[MiniPlayer.kt](../../frontend/android/app/src/main/java/com/wildstring/app/ui/MiniPlayer.kt)（新增 `BookMiniPlayer`）、新增全屏 `BookAudioPlayerScreen` 并在 [WildStringApp.kt](../../frontend/android/app/src/main/java/com/wildstring/app/ui/WildStringApp.kt) 完成互斥调度与平板/手机全屏浮层接入。
- **书架与管理细节**：重构 [BookshelfScreen.kt](../../frontend/android/app/src/main/java/com/wildstring/app/ui/BookshelfScreen.kt)（浏览筛选网格、细节英雄区、折叠编辑面板、直出章节列表、沉浸阅读顶栏与字体/笔记面板）、扩展 [LibraryManagementTools.kt](../../frontend/android/app/src/main/java/com/wildstring/app/ui/LibraryManagementTools.kt) 便携侧车歌词状态展示，并对齐双语资源文件。

## 验收（按 AGENTS.md §3 定级）

本次改动同时覆盖 Android 共享导航栏（`CatalogTopBar`）、共享底部播放器（`MiniPlayer` / `WildStringApp`）、书架全流程 UI、Service 命令及测试夹具脚本，按 `AGENTS.md` §3 定为 **L2/L3 级验证**：

1. 执行 `make check` 通过全仓静态检查、格式、文档状态与链接校验。
2. 执行 `make android-ci` 完成 Debug/Release（含 R8）构建、全部 JVM 单元测试与 `lintDebug` / `lintRelease`（0 错误）。
3. 启动本地合成测试服务及 `wildstring-phone`（`1080×1920`）、`wildstring-pad`（`2560×1600`）模拟器运行 `BookReaderPanelMotionTest`、`BookshelfRealBackendTest` 与 `PodcastQueueDetailLayoutTest`，并逐张核验手机与平板浅/深色截图（书架列表、详情与章节、编辑折叠、全屏听书播放、滚动与分页阅读器）。

## 风险与回滚

- **风险点**：`MusicViewModel` 中接入有声书 `MediaController` 互斥逻辑与电台顶栏标签调整若未同步更新现有设备测试节点选择（如 `BookshelfRealBackendTest` 点击旧 `books_title` 标签），会导致仪器测试超时；已在同批同步更新 `BookshelfRealBackendTest` 并全量回归电台相关测试。
- **回滚策略**：前端 UI 与控制器改动完全独立于后端 Schema v58，若需局部调整可在客户端独立迭代，不影响服务端既有 REST 接口与 `.wildstring/` 侧车数据。
