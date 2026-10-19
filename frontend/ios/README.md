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

## 现状

I0 骨架：模拟器可启动占位页。实施批次见 [iOS 第一版](../../docs/product/ios-v1.md#实施与验收顺序)。

图标源文件为 `design/app-icon.svg`，由 Android 自适应图标换算（按启动器可见区放大 1.5×）；`AppIcon-1024.png` 由它栅格化生成。
