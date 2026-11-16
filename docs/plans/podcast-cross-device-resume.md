状态：已确认

# 播客跨设备续听

## 目标

四端都能在另一台设备听过之后正常续听，不需要手动刷新页面，并且不会把别处已经标为已听完的单集改回未听。

现状按当前实现核对如下（`main` 7c5d4b5）：

| | 开播前先读服务器 | 先按旧进度出声再跳 | 已听完会被改回未听 | 切回页面自动更新 |
| --- | --- | --- | --- | --- |
| Web | 是 | 否 | 是 | 否 |
| Android | 是（等待上限 6 秒） | 被 pause 挡住，存在极短漏音，未实测 | 是 | 否 |
| macOS / iOS | 否 | 是 | 是 | 否 |

具体位置：

- 服务器：新会话的非片尾事件一律重算 `completed`，见 `backend/src/wildstring/podcast_progress.py:103-108`。任何端用旧缓存从开头播放都会清掉已听完。
- Android：`frontend/android/app/src/main/java/com/wildstring/app/data/PodcastProgress.kt:91-113` 先读后播。静默改写版本、重传旧位置在 `:155-165`，同一集已在播放器里时不会重新准备（`playback/PlaybackService.kt:278-282`）。节目页「继续」读缓存（`ui/PodcastScreen.kt:1202-1206`），详情按 `loadedDetails` 缓存（`PodcastBrowser.kt:83-85`），无前台恢复刷新。
- Apple：`frontend/ios/WildStringKit/Sources/CorePlayback/PlaybackService.swift:1543-1587` 先按旧位置加载音频，再在后台读服务器并校正。macOS「继续」挑列表里第一个听了一半的集（`MacPodcasts.swift:491`），续听对话框用页面旧数据（`:108-111`），窗口不刷新。
- Web：`frontend/web/src/player.tsx:588-596` 先读后播；已听完从 0 播并上报，清掉已听完。切回标签页不刷新（`podcasts.tsx` 无 `visibilitychange`）。

## 不碰的边界

- 不改历史提交与已发布标签，不改 `contracts/podcast-progress.md` 之外的进度语义，不做跨设备实时推送或播放中轮询别的设备。
- 不回溯修正已有书签：已停在片尾余量内但未标已听完的旧记录保持原样。
- 片尾余量标已听完的规则已在 PR #148 处理，本方案不改它的阈值与触发事件。两者都会改 `save_progress`，以 #148 先合入为前提。
- 不改导入源、托管曲库与下载文件，只改进度读写和页面刷新。

## 方案

### 1. 服务器按意图保护已听完

`PUT /api/v1/podcasts/episodes/{episode_id}/progress` 增加可选字段 `intent`：

- `resume`：用户点「继续收听」。已接受的新会话即使位置为 0、事件为 `play`，也保留当前已听完状态，直到用户真正从头播放或标为未听。
- `restart`：用户明确从头播放或标为未听。按现有规则重算，清掉已听完。
- 缺省：保持当前行为，老客户端不受影响。

`intent` 不落库，只在请求内生效；版本与序列校验不变。与 #148 的片尾余量处理在同一处汇合：`resume` 时保留、`restart` 与缺省时按现有规则。

### 2. Android

- 用户主动点播（列表、节目页、待播、迷你播放器与锁屏恢复）时，即使同一集已在播放器中，也重新走一次 `prepare()`；后台自动恢复仍不重读。
- 409 处理：只有服务器当前会话属于本机同一个 `deviceId` 时才改写版本重传；别的设备写过就采用服务器状态并停止上报，不再静默覆盖。这与契约「冲突始终询问」一致。
- 前台恢复（`ON_START`）时刷新当前节目详情，离上次拉取不到 30 秒不重复拉；保留下拉刷新。
- 「询问接续位置」设置自 0.8.7 起没有对话框，实际等于「自动」。本方案删除该设置项，Android 只保留自动和从头播放两种；`mode == "ask"` 映射为自动，迁移旧值。

### 3. macOS / iOS

- 点「继续」先读这一集进度，再出声，等待上限约 1.5 秒；超时或离线按本地位置播，此时不上报 `play 0`。等待期间用现有缓冲状态，不先按旧位置出声再跳。`bootPodcast` 在开播前完成校正后，启动时的跳位置与「出声后跳一次」一并去掉。
- 服务器已是已听完时点「继续」：带 `intent=resume` 上报；服务器返回已听完后改播这个节目的下一集未听，没有下一集就停住并显示已听完。「从头播放」带 `intent=restart`，仍从 0 开始。
- macOS「继续」改为挑最近听的那一集（有进度的集里 `last_listened_at` 最新的那个），全部听完时停住并显示已听完，不退回第一集。
- 窗口重新成为当前窗口（macOS）或场景回到前台（iOS）时静默重拉当前节目，离上次不到 30 秒不重复拉；保留手动刷新。
- 续听对话框和列表行的时间改用刚读到的进度。

### 4. Web

- 切回标签页（`visibilitychange` 回到可见）时静默重拉当前节目，离上次不到 30 秒不重复拉。
- 服务器已是已听完的单集，点播放视为明确从头播放，带 `intent=restart`。

### 5. 文档

实现落地时同步：`contracts/podcast-progress.md` 补 `intent` 字段、Android 冲突处理与设置项变更；`docs/product/scope.md` 如有相关描述一并核对；本方案状态随进度更新。

## 验收（按 AGENTS.md §3 定级）

- 服务器与契约：L0 + `make test-affected`。补测试覆盖 `intent=resume` 保留已听完、`intent=restart` 清掉、缺省不变，以及与 #148 片尾余量的组合。
- Android：L2，`make test-affected` + `make android-ci`。补单元测试覆盖「同一集已在播放器里再次点播会重读」和「别的设备的会话不被改写」。
- Apple：L3（共享播放代码），`make macos-test`、`make ios-test`。改现有 `playPodcastEpisodeWithoutExplicitPositionRecoversNewerRemoteProgressOverStaleCache` 为先读后播语义，补「已听完点继续改播下一集」和「窗口回归刷新」。
- Web：L2，`make test-affected-desktop` + Playwright。补「页面不刷新时先读服务器再出声」和「已听完带 `restart`」。
- 视觉验收：四端节目页与续听对话框，桌面与 390px 宽度、浅深主题各一次，逐张查看截图。Web 用 CI 上传的 `browser-visual-evidence`；原生端在本机模拟器渲染。
- 真机路径：Android 与 macOS 同一账号，A 端听到 40 分钟，B 端不刷新点「继续」，确认不先出声、无跳转、位置正确；A 端标已听完，B 端再点「继续」，确认已听完不被清掉并改播下一集。

## 风险与回滚

- 老客户端不带 `intent`，仍会清掉已听完。服务器只能保护新客户端；彻底解决要等各端升级。不为此做位置启发式，因为「标为未听」同样是新会话从 0 上报，启发式会误伤。
- 删除 Android 询问设置会改变部分用户的操作路径，需要在更新说明中写明；旧值按自动处理，不丢进度。
- Apple 开播前等待最多 1.5 秒，弱网下比现在慢。以缓冲状态提示，超时退回本地位置，不回退成「先出声再跳」。
- 回滚按提交单元进行：服务器 `intent` 缺省行为不变，客户端可单独回退；删除的设置项回退时旧值仍能读出。
