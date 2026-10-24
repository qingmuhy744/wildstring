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

I0–I9 全部批次已完成本地验证（模拟器运行、缓存与下载文件核验、截图记录）：骨架、连接与登录、播放闭环、曲库（含拼音字母定位）、播放页与歌词、收藏/歌单/每日推荐、缓存与离线、AI 助手与草案批准、管理员编辑工具、外观（主题/播放页样式/列表大小/触感）与歌单拖动排序。0.5.6 之后的增量也已落地：睡眠定时、音质设置（AAC 转码与回退）、起播加速、多服务器清单、跨设备续播、元数据来源建议。

### 对齐 Android 0.5.13（2026-10-20）

- **曲库排序与多碟**：专辑/歌曲/专辑曲目支持排序与升降序，偏好按服务器保存；多碟专辑按 `DISC 01` 分组并保留整张连续播放；字母索引仅在名称升序时显示。
- **核对工作台**：按专辑列出待核对歌曲，并排对比当前值/建议值/来源；默认只勾选变化且保留人工值；支持按曲或同字段选择、本次跳过、接受本曲并下一首；整批通过服务端事务应用，冲突整批不落库。封面先由服务端固定快照、预览成功后才能应用，可与文字资料同批提交。
- **拒绝候选**：只忽略当前候选及其旧重复记录，保留其他版本与并发新查询；需要 0.5.12+ 服务端，旧服务端会提示升级。

### 对齐 WildString 0.6.1（2026-10-22）

- 服务器地址可省略协议，默认补 `https://`；放行自托管 HTTP 实例时采用按服务器单点授权策略，未加密明文连接弹出风险确认；OriginGuard 拦截器防止未授权重定向。
- 统一 iOS 工程版本号为 0.6.1。

### 对齐 WildString 0.6.0（2026-10-21）

- 账号接口改为只返回 `profile`，客户端移除旧 `role` 字段；所有者继续看到现有管理入口，曲库管理员和资料编辑员的管理功能以 Web 端为主。
- 统一 iOS 工程版本号为 0.6.0；本版不新增移动端档案管理界面。

### 对齐 WildString 0.5.15（2026-10-21）

- 统一 iOS 工程版本号为 0.5.15；本版客户端行为沿用已验证的播放页和队列能力，新增的 Android 专辑操作与元数据 Web 批量编辑不声称已在 iOS 真机实现。
- **整理方式**：按账号选择「审核后应用 / 自动整理」及允许自动应用的草案类型（歌单、单曲、专辑批量、封面、歌词、导入），默认人工审核。
- **草案与接续**：草案默认「待处理」，已处理记录可切换查看，支持一次「接受并应用」；接续仅提示其他设备最近 30 分钟内真实暂停的记录（每次暂停只提示一次），来源恢复播放后自动撤回提示。
- **通知收件箱**：未读/已读/全部筛选、标为已读与全部已读、未读徽标；查看列表不会自动标为已读，通知里的草案可直接打开。

### 与 Android 0.5.12 的已知差异

- 外部通知偏好（Telegram 目标与投递记录、静默时间）尚未移植；站内通知可用。
- 导入管理（待整理队列、自动发现策略、下载完成后缀与同专辑等待）尚未移植；这些策略仍可在 Web/Android 配置，服务端行为一致。
- 在线歌词候选与逐字/双语预览尚未移植；核对工作台暂不包含歌词页签。
- 安卓 0.5.11 的布局细节（曲数自适应换行、下拉刷新、菜单收纳）按 iOS 交互另行实现，不逐项照搬。
- MCP 凭据管理与标签写回仍不在 iOS 范围；写回尚未在任何客户端实现。

**待真机验收**：后台播放、锁屏控制、耳机键、音频中断（需要免费个人团队自签在 iPhone 上运行一遍）。

图标源文件为 `design/app-icon.svg`，由 Android 自适应图标换算（按启动器可见区放大 1.5×）；`AppIcon-1024.png` 由它栅格化生成。
