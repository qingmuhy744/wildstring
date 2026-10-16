# 野弦 Android

Kotlin / Compose / Media3 原生客户端，Android 8.0（API 26）起可安装。所有曲库、封面、歌词、收藏与歌单来自用户配置的野弦实例；生产 APK 没有内置演示曲库或测试音频。测试夹具只打包到独立的 androidTest APK。

当前开发版本：0.2.3（versionCode 6，尚未发布）。当前已发布版本为 0.2.2。

0.2.3 在设置中增加封面／黑胶／磁带选择，默认封面并记住本机选择。黑胶中心封面放大，手机横屏采用视觉与播放控制左右布局。唱臂、唱片与双卷轴跟随实际播放状态，暂停、缓冲、后台及关闭系统动画时停转；三种样式共用音频和队列。播放背景延伸至系统栏，按钮保留安全间距，进度条使用主题配色。实现与验证状态见 [播放页样式](../../docs/product/player-styles-0.2.3.md)。

当前功能：服务器连接/登录与加密会话保存；歌曲、专辑、艺人、关键词搜索与分页；原音串流、后台媒体服务、系统控制、队列增删/三横杠拖动排序、循环/随机；手机全屏歌词、平板双栏与窄分屏布局；收藏、歌单浏览/创建/加入和在线收听上报；按曲目 ID 保存队列及暂停恢复。

完整歌单编辑/排序、离线下载、AI 业务、Android Auto 单独交付。支持的容器以服务端曲库协议为准，实际编码仍需设备解码验证。无歌词、无封面和网络错误使用真实空态或反馈，不填充虚构内容。

0.2.0 增加可调缓存、封面取色毛玻璃、自然过渡、轻触反馈，以及独立红布彩蛋。经典深色主题保留原暖橙 / 深绿，支持浅色及跟随系统自动切换；红布固定正红，不随日夜变化。变化与验证状态见 [CHANGELOG](../../CHANGELOG.md)。

## 0.2.1：原生页面布局

手机以「发现 / 音乐 / 我的」底部导航切换，平板保留侧边导航；曲库使用专辑 / 歌曲 / 艺人标签，个人页集中展示账号、最近听过和歌单。启动页提供搜索、横向专辑预览和真实最近收听。设置是独立页面，返回栏固定，选项按组排列并使用单选弹窗；封面取色的悬浮播放条在曲库和设置中都可控制播放或打开队列，展开后返回保留页面位置与播放状态。

触感仅用于播放与关键操作：点播、收藏、队列增删、悬浮条展开、进度松手和歌词定位轻反馈；拖动队列区分开始与有效落位，取消不触发落位反馈。共用反馈节流，普通浏览、列表滚动和自动歌词跟随保持安静。设置中的「轻触反馈」即时生效，使用系统原生反馈并遵循系统开关；实际强弱取决于手机，模拟器不能验收马达手感。

交互设计稿也已同步为这套结构，执行 `make android-design` 后访问 `http://127.0.0.1:18782/android-v1.html`；可切换手机 / 平板、主题和设置选项，并预览播放器返回与队列拖动。HTML 仅使用示例资料，不连接实例、不播放音频、不保存真实设置，不能代替 APK 验收。设计稿已完成 JavaScript / HTML / CSS 语法及静态检查，浏览器视觉验收待补；下述设备回归针对原生 APK。

本批 UI 与交互改进归入 0.2.1（versionCode 4）。本地 `make android-ci android-connected-test` 已通过：20 项单元测试、Debug / Release Lint、R8 构建及 9 项 Android 15 ARM64 模拟器回归；含触感开关与节流、反馈异常不阻断操作、队列拖动反馈类型、发现页数据与查看全部、悬浮播放条 / 队列、设置轻下拉防抖、返回与列表位置恢复、手机 / 平板导航、主题 / 缓存设置，以及真实音频播放与缓冲 / underrun 指标检查。截图使用 androidTest 接口夹具；国产真机手势、后台限制和功耗仍待验证。

## 构建

准备 JDK 21、Android SDK `platforms;android-36.1` 与 `build-tools;36.1.0`。在仓库根目录执行：

```sh
make android-ci                 # Android Lint、单元测试、debug APK 与校验和
make android-connected-test     # 已启动的设备/模拟器上运行原生登录/播放/歌词测试
make android-locks              # 修改依赖后刷新锁与 SHA-256 校验元数据
```

`ANDROID_HOME` 指向本机 SDK，`JAVA_HOME` 指向 JDK；`local.properties` 只用于本机且不跟踪。Gradle Wrapper、版本目录与依赖校验资料入库，构建缓存、APK 和签名私钥不提交。

`make android-ci` 的安装包位于 `artifacts/android/`，包含 `wildstring-<version>-debug.apk`（当前开发包为 `wildstring-0.2.3-debug.apk`）与 `SHA256SUMS`。GitHub 的 **Android APK** 工作流通过后，在该次运行的 **Artifacts → wildstring-android-debug** 下载并解压 ZIP 后安装 APK。原有 Python/Web/Docker CI 继续独立运行。

设备测试用 `UiAutomation.takeScreenshot()` 生成手机和平板 PNG，写入 AGP 传入的 `additionalTestOutputDir`，在测试卸载应用前自动取回到 `frontend/android/app/build/outputs/connected_android_test_additional_output/`。Actions 的 `android-test-reports` 同时保存这些截图及失败截图。手工查看本地已连接设备时，也可用 `adb exec-out screencap -p > screenshot.png` 保存当前屏幕。

debug 包 ID 为 `com.wildstring.app.debug`，与正式包 `com.wildstring.app` 隔离。CI 使用一次性 debug 签名，不上传私钥；不同运行的签名可能不同，安装更新提示签名不匹配时需卸载旧测试包。卸载会清空本机连接/队列，服务端曲库、收藏和歌单保留。

## 正式发布

显示名称为「野弦」，英文名称 WildString。0.1.0 的正式包 ID 为 `com.wildstring.app`，versionCode 为 2。旧的 `dev.wildstring.app.debug` 测试包属于另一应用，无法直接覆盖；首次安装正式版需要重新连接服务端。服务端曲库不受影响。

GitHub [Releases](https://github.com/qingmuhy744/wildstring/releases) 当前提供已发布的 `wildstring-0.2.2-release.apk` 与校验和。正式包启用 R8 优化，使用固定发布签名；后续保留同一包名和密钥，以递增 versionCode 更新。私钥不进入源码、Actions 缓存或发布附件。公开证书指纹在 Release 的 `android-signing-certificate.sha256` 中。

本地签名构建需要从未跟踪的 `.env.android-release` 导出 `ANDROID_KEYSTORE_PATH`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`，再执行 `make android-release`。`make android-release-smoke` 会在一次性模拟器安装正式包并检查连接页；不要对正在使用的正式客户端运行这个安装检查。工作流与密钥备份约定见 [发布说明](../../docs/releasing.md)。

## 连接与数据

- 默认 HTTPS，校验系统可信证书，不提供跳过 TLS 验证的开关。当前版本的 HTTP 仅限 debug 包显式启用的 `localhost`、`127.0.0.1` 与 Android 模拟器宿主地址 `10.0.2.2`；普通局域网地址请提供 HTTPS 入口。未全局开放明文连接。
- 服务端默认回环监听，手机不能用自己的 `127.0.0.1` 访问另一台服务器。使用可达的 HTTPS 反向代理，客户端不会修改服务器监听或防火墙。
- 普通接口、封面与媒体 Range 请求共用 CookieJar 和同源/路径校验；拒绝重定向。当前服务支持 `X-Wildstring-Client: android`；旧服务仅返回明确的 `client_header_required` 时，在同一地址使用已有 Web 标识重试，认证仍需有效 Cookie。
- 密码只用于本次登录，不落盘。Cookie 由 Android Keystore 管理的 AES-GCM 密钥加密，应用禁止系统备份。401 清理会话并停止受保护播放。
- Room 保存队列条目 ID/曲目 ID、顺序和位置。0.2.0 新增应用级曲库 / 歌词 / 封面 / 最近播放片段缓存，容量可在设置中调整或关闭，退出或切换服务器清理。短时断网仅能播放已缓存片段，不包含完整离线下载。策略与边界见 [Android 缓存](../../docs/architecture/android-cache.md)。
- 进程重建后恢复到暂停状态；后台服务仍在时重新连接同一播放器。强制停止、厂商省电策略和断网尾段统计另按真机结果验收，不能以可构建 APK 代替这些验证。

## main 新功能适配（0.2.0）

- 默认原音，设置可选 AAC 128/192/256/320 kbps；FLAC/ALAC 由服务端按实际编码决策，有损源直放，页面显示实际输出。
- Media3 加载线程读取播放决策，保留认证和同源路径约束；转码尾段按 `start_ms` 重新请求，整曲位置用于歌词、系统媒体控件、收听与 Room 恢复点。音质切换保留位置与暂停状态。
- 登录账号可自由输入；设置显示账号和角色、支持改密。退出、改密与登录失效停止播放，换账号隔离私密缓存与队列。
- 播放页可刷新 Web 管理员保存的人工歌词，刷新不重新设置音频源；歌词打点、账号管理及 Host 白名单设置继续使用 Web。
- 旧服务仍可使用默认原音；AAC 与改密需要目标服务实际部署对应新接口。转码繁忙/失败可重试或切换原音。

合成 FLAC、fragmented AAC 及偏移尾段只在测试 APK；生产 APK 不包含样本。适配验证见 CHANGELOG 和 PR 的实际结果；不以模拟器替代真机后台与全部格式验收。
