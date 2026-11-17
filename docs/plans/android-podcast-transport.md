状态：已实施

# Android 播客回退与恢复播放

## 目标

- 修复已准备播客的播放命令被拦截、暂停后不能继续的问题。
- 同一集内的回退、暂停、继续沿用本机会话，不因同步阻塞或冲突而重新读取续听位置。
- 缓冲、音频焦点抑制与用户暂停分开记录，避免把临时停止出声上报为片尾暂停。

## 不碰的边界

- 保留服务器的版本、会话、序号、完成判定和显式接管协议。
- 保留进入单集时的先读后播及离线降级；开播网络等待的整体调整另行设计。
- 不改其他客户端、UI 布局、音频缓存、真实曲库与发布版本。

## 方案

- `PlaybackService` 只有正在恢复或确需准备单集时消费播放命令；已准备单集的普通继续命令透传给 `AbsolutePlayer` 的底层播放器。
- `onIsPlayingChanged` 只在开始实际播放时记录进度；用户或系统暂停由 `onPlayWhenReadyChanged` 记录，停止与真正结束由 `onPlaybackStateChanged` 记录。
- 在真实媒体服务测试中执行播放器后退按钮、暂停、继续和系统媒体命令；人为阻塞进度 PUT、返回跨设备冲突，断言播放位置继续前进、GET 与会话不增加。

## 验收（按 AGENTS.md §3 定级）

播放器共享逻辑按 L2 验证。关联入口：`PodcastTransportServiceTest`、`PodcastResumeServiceTest`、`PodcastProgressTest`、`PodcastProgressNetworkTest`、`PodcastResumeUiTest`，以及播放器和系统控制共用的 `AbsolutePlayer`。

- 新增真实服务回归先在旧实现上失败，再在修复后通过。
- 执行 `make check`、`make test-affected`、Android 单元测试、设备测试编译及 lint。
- 标准 Phone / Pad、浅深主题检查播客播放器截图及回退、暂停、继续路径；未覆盖的矩阵如实记录。
- 不将模拟器测试等同蓝牙耳机真机 UAT。

### 验证记录（2026-11-17）

- 基于 `origin/main` 的 `714bf0d` 建立 `fix/android-podcast-transport`。新增回退恢复路径在旧实现上实际失败，断言为 `UI resume reaches the engine and advances after rewind`；证据保存在 `artifacts/android-podcast-transport/old-implementation/`。
- `make check`、`make test-affected` 通过；后者没有选中后端或 Web 功能测试。`make android-test` 的 180 项 JVM 测试通过，设备测试编译与 Debug APK 构建通过；`make android-check` 的 Debug lint 通过。
- 标准 Phone（1080×1920）与 Pad（2560×1600）均开启物理键盘输入，各通过新增播放控制、既有服务生命周期、系统媒体会话三个专项。新增专项实际覆盖后退 15 秒、暂停后继续、询问模式下不重复弹框、上传阻塞、断网、跨设备冲突、临时音频焦点丢失和返回／重开播放器；断言同集操作不增加进度 GET 或更换会话。阻塞上传的系统媒体恢复须在两秒内推进播放位置。
- 系统媒体会话专项最初未等待新登录完成，日志显示以旧账号作用域提交的条目被拒绝；单类运行仍复现。修正测试的登录完成等待后，Phone / Pad 均通过，未改音乐播放实现。
- Phone / Pad 最终各 5 张截图已逐张查看：浅深主题暂停与播放各一张，深色冲突一张；截图先等待回退缓冲、按钮语义与图标转场稳定。证据位于 `artifacts/android-podcast-transport/{phone,pad}/`，未发现控件遮挡或异常折行。
- 服务端进度专项 `backend/tests/test_podcast_progress.py` 22 项通过，覆盖旧会话、乱序、并发抢占、回退和完成意图；不代表大节目策略重算的性能验证。
- 本轮按 L2 影响面完成上述专项；未覆盖完整空／加载／错误／权限不足、全部长文案和主题组合，没有执行蓝牙耳机真机 UAT、其他客户端运行验收或完整 L3 CI。

## 跨端与服务端核对

- Android 吞掉普通恢复命令的缺陷位于本端适配层。Apple 普通恢复直接调用 `beginPlayback`；Web 普通按钮区分已激活会话，但系统媒体 `play` 仍调用 `start` 并重新经过进度读取、会话准备。这是源码核对，不等同其他端故障复现。
- 服务端使用原子事务、版本、会话与递增序号拒绝过期上传并允许主动回退，核心协议保留。完成状态变化后同步调用自动下载引用重算；是否调整其响应耗时需先测量，本轮不改服务端。
- 其他客户端的对照修复在 Android 修复验收后开展，本方案只记录源码核对结论。

## 风险与回滚

- 风险集中在准备期间仍需拦截播放、等待期间暂停不得自动出声、完成后重新点播仍需准备；用既有服务回归保护。
- 修改前已反查相关 JVM 与设备断言；原 `resumingThePreparedEpisodeDoesNotPrepareAgain` 只断言准备条件，新增测试覆盖命令实际到达播放器。
- 回滚本方案对应的服务改动与测试即可，不涉及数据库迁移。
