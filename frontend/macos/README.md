# 野弦 Mac

原生 macOS 14 应用，与 iOS 共用 `frontend/ios/WildStringKit` 的网络、模型和播放。界面是侧栏加播放栏，不把 iOS 页面原样搬过来。

## 菜单

左边是应用菜单：

- 「控制」：播放/暂停（⌘↩）、上一首（⌘[）、下一首（⌘]）、随机（⌥⌘S）、循环（⌥⌘R）、后退 15 秒、前进 30 秒。
- 「显示」：歌词（⌘L）、队列（⌥⌘J）、桌面歌词（⇧⌘L）。

右边是状态项。点开后是封面、歌名、进度和播放控制。设置里可以关掉「在菜单栏显示播放器」。

系统正在播放接到 `MPNowPlayingInfoCenter` 和远程命令，媒体键、控制中心和耳机操作走这一路。桌面歌词是置顶窗口，可按当前行显示，也可设为穿透点击。

写请求使用 `X-Wildstring-Client: macos`。旧服务返回 `client_header_required` 时改用 `web` 重试。

## 构建

```sh
make macos-build
make macos-dmg
```

DMG 在 `artifacts/WildString-macOS.dmg`。GitHub Actions 的 macOS 工作流会在相关路径变更时编译并上传 DMG；发版时挂到 Release。

有付费开发者账号时，在仓库 Secrets 中配置后才会签名和公证：

- `APPLE_CERTIFICATE_P12_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`（Developer ID Application）
- `APPLE_NOTARY_APPLE_ID`
- `APPLE_NOTARY_PASSWORD`
- `APPLE_TEAM_ID`

没有这些密钥时仍会打出 DMG。macOS 会拦截未公证的应用，需要在访达里右键打开，或到系统设置里放行。
