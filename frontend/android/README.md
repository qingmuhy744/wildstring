# 野弦 Android

Kotlin / Compose / Media3 原生客户端，Android 8.0（API 26）起可安装。所有曲库、封面、歌词、收藏与歌单来自用户配置的野弦实例；生产 APK 没有内置演示曲库或测试音频。测试夹具只打包到独立的 androidTest APK。

当前功能：服务器连接/登录与加密会话保存；歌曲、专辑、艺人、关键词搜索与分页；原音串流、后台媒体服务、系统控制、队列增删/移动、循环/随机；手机全屏歌词、平板双栏与窄分屏布局；收藏、歌单浏览/创建/加入和在线收听上报；按曲目 ID 保存队列及暂停恢复。

完整歌单编辑/排序、离线下载、AI 业务、Android Auto 与正式发布签名单独交付。支持的容器以服务端曲库协议为准，实际编码仍需设备解码验证。无歌词、无封面和网络错误使用真实空态或反馈，不填充虚构内容。

## 构建

准备 JDK 21、Android SDK `platforms;android-36.1` 与 `build-tools;36.1.0`。在仓库根目录执行：

```sh
make android-ci                 # Android Lint、单元测试、debug APK 与校验和
make android-connected-test     # 已启动的设备/模拟器上运行原生登录/播放/歌词测试
make android-locks              # 修改依赖后刷新锁与 SHA-256 校验元数据
```

`ANDROID_HOME` 指向本机 SDK，`JAVA_HOME` 指向 JDK；`local.properties` 只用于本机且不跟踪。Gradle Wrapper、版本目录与依赖校验资料入库，构建缓存、APK 和签名私钥不提交。

`make android-ci` 的安装包位于 `artifacts/android/`，包含 `wildstring-0.1.0-dev.1-debug.apk` 与 `SHA256SUMS`。GitHub 的 **Android APK** 工作流通过后，在该次运行的 **Artifacts → wildstring-android-debug** 下载并解压 ZIP 后安装 APK。原有 Python/Web/Docker CI 继续独立运行。

设备测试用 `UiAutomation.takeScreenshot()` 生成手机和平板 PNG，写入 AGP 传入的 `additionalTestOutputDir`，在测试卸载应用前自动取回到 `frontend/android/app/build/outputs/connected_android_test_additional_output/`。Actions 的 `android-test-reports` 同时保存这些截图及失败截图。手工查看本地已连接设备时，也可用 `adb exec-out screencap -p > screenshot.png` 保存当前屏幕。

debug 包 ID 为 `dev.wildstring.app.debug`，与未来 release 包隔离。CI 使用一次性 debug 签名，不上传私钥；不同运行的签名可能不同，安装更新提示签名不匹配时需卸载旧测试包。卸载会清空本机连接/队列，服务端曲库、收藏和歌单保留。

## 连接与数据

- 默认 HTTPS，校验系统可信证书，不提供跳过 TLS 验证的开关。当前版本的 HTTP 仅限 debug 包显式启用的 `localhost`、`127.0.0.1` 与 Android 模拟器宿主地址 `10.0.2.2`；普通局域网地址请提供 HTTPS 入口。未全局开放明文连接。
- 服务端默认回环监听，手机不能用自己的 `127.0.0.1` 访问另一台服务器。使用可达的 HTTPS 反向代理，客户端不会修改服务器监听或防火墙。
- 普通接口、封面与媒体 Range 请求共用 CookieJar 和同源/路径校验；拒绝重定向。当前服务支持 `X-Wildstring-Client: android`；旧服务仅返回明确的 `client_header_required` 时，在同一地址使用已有 Web 标识重试，认证仍需有效 Cookie。
- 密码只用于本次登录，不落盘。Cookie 由 Android Keystore 管理的 AES-GCM 密钥加密，应用禁止系统备份。401 清理会话并停止受保护播放。
- Room 仅保存连接地址、队列条目 ID/曲目 ID、顺序和位置，展示元数据恢复时在线校验。封面不启用磁盘缓存，音频没有离线下载。退出清理本机状态。
- 进程重建后恢复到暂停状态；后台服务仍在时重新连接同一播放器。强制停止、厂商省电策略和断网尾段统计另按真机结果验收，不能以可构建 APK 代替这些验证。
