# 野弦 iOS

SwiftUI 原生客户端，最低 iOS 17。产品范围见 [iOS 第一版](../../docs/product/ios-v1.md)，技术决策见 [ADR 0004](../../docs/decisions/0004-native-ios.md)。

## 构建

需要 Xcode 27+ 与 [XcodeGen](https://github.com/yonaskolb/XcodeGen)（`brew install xcodegen`）。

```sh
cd frontend/ios
xcodegen generate
open WildString.xcodeproj
```

命令行构建（模拟器）：

```sh
xcodebuild -project WildString.xcodeproj -scheme WildString \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
```

`WildString.xcodeproj` 由 `project.yml` 生成，不入库；改工程结构请改 `project.yml` 后重新生成。

## 测试

```sh
make ios-test
```

核心逻辑与单元测试在 `WildStringKit` 包（Swift Testing，`swift test` 可在 macOS 直接跑）；Keychain 与界面行为在模拟器/真机运行时验证。

## 集成测试（可选）

对着一次性本地实例跑真实 HTTP 登录、会话与登出：

```sh
# 终端 1：启动一次性实例（临时数据目录，不影响本机运行数据）
WILDSTRING_ENVIRONMENT=test WILDSTRING_DATA_DIR="$(mktemp -d)" \
WILDSTRING_ADMIN_PASSWORD=fixture-admin-password WILDSTRING_PORT=18799 \
uv run --frozen --project backend python -m wildstring

# 终端 2
WILDSTRING_INTEGRATION_URL=http://127.0.0.1:18799 \
WILDSTRING_INTEGRATION_PASSWORD=fixture-admin-password \
make ios-test
```

## 真机安装（无开发者账号）

当前 Apple 开发者账号未过审，不做商店分发。真机验证用 Xcode 的免费个人团队自动签名：

1. 连接 iPhone，在 Xcode 中打开工程，为 WildString target 选择你的个人 Team；
2. 直接 Run 安装；
3. 免费签名有效期 7 天，过期后在 Xcode 重新 Run 即可。

`make ios-gen` / `make ios-build` 会重新生成 `WildString.xcodeproj`，Xcode 里选的 Team 会被重建覆盖。想让它跨重新生成保留，把 Team 放进仓库根目录的未跟踪文件 `.env.ios-local`（已被 gitignore）：

```sh
echo "IOS_DEVELOPMENT_TEAM=你的TeamID" > ../.env.ios-local
```

Team 只保存在本地，不会提交；`.env.ios-local` 不存在时生成空 Team。

## 现状

I0–I9 全部批次已完成本地验证（模拟器运行、缓存与下载文件核验、截图记录）：骨架、连接与登录、播放闭环、曲库（含拼音字母定位）、播放页与歌词、收藏/歌单/每日推荐、缓存与离线、AI 助手与草案批准、管理员编辑工具、外观（主题/播放页样式/列表大小/触感）与歌单拖动排序。0.5.6 对齐后的增量也已落地：睡眠定时、音质设置（AAC 转码与回退）、起播加速、多服务器清单与跨设备续播（关闭 / 轻提示 / 自动恢复，载入保持暂停、暂停时保存）。实施批次见 [iOS 第一版](../../docs/product/ios-v1.md#实施与验收顺序)。

**待真机验收**：后台播放、锁屏控制、耳机键、音频中断（需要免费个人团队自签在 iPhone 上运行一遍）。少量后续项：元数据「联网建议与封面核对」流程。

图标源文件为 `design/app-icon.svg`，由 Android 自适应图标换算（按启动器可见区放大 1.5×）；`AppIcon-1024.png` 由它栅格化生成。
