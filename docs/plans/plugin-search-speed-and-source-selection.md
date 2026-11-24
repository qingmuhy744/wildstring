状态：已实施

# 插件搜索性能优化与按次选择数据来源

## 目标

- **缩短单曲交互式搜索延迟**：在不放松后台批扫限流的前提下，为交互式查询引入 `0.8s` 最小物理间隔，并在 `Providers.suggestions()` 并发执行 MusicBrainz/CAA、Last.fm 与数据源插件，配合手动高置信度双语逐字歌词短路、搜索词封装噪音清洗以及前端渐进轮询，将单曲冷查等待显著压缩。
- **消除多余子进程启动开销**：`bridge()` 直接在 Python `plugin_worker` 侧完成首个门控等待并透传 `first_permitted`，消除每次 Node 请求反向拉起 `python -m wildstring.plugin_rate` 的多余子进程；酷狗歌词搜索与解码合并入同一 `service.cjs` 生命周期（`2.0.1`，保持 `api_version = 2`）。
- **支持按次选择搜索数据来源**：在单曲在线歌词、单曲/专辑/曲库元数据刷新、单曲在线元数据匹配与歌词批扫中支持选择目标来源（默认全选已启用来源；单选或缩窄重查仅刷新对应来源结果并保留其余来源已有候选），同时修复 `OnlineMetadataMatcher` 自定义标题/艺人关键词未传后端及短延时盲读问题。

## 不碰的边界

- 不破坏 `plugins/node-runtime/vendor/*` 受 `UPSTREAM.json` 哈希锁定的上游源码文件，保证 `make source-providers-check` 原样通过。
- 保持 `API_VERSION = 2`，参考插件仅升修订号至 `2.0.1`（兼容既有 v2 安装包）。
- 同一数据源内部继续严格串行执行请求门控与 `429` 冷却；交互式 `0.8s` 间隔不得缩短后台批扫已排定的 `next_at`。
- 遵循界面降噪规范：仅当可用来源不少于 2 个时展示来源选择器，全部选中时不改变既有请求默认行为与空载 Mock 兼容。

## 方案

### 1. 数据库 Schema 56 增量迁移（`backend/src/wildstring/database.py`）

- 将 `SCHEMA_VERSION` 升至 `56`，在 `if current < 56:` 中以幂等 `PRAGMA table_info` 检查为 `lyric_lookup_jobs`、`provider_jobs` 与 `provider_refresh_intents` 增加可空列 `options TEXT`，用于持久化单次/批量任务的筛选来源列表与自定义关键词覆盖（`NULL` 表示沿用全部已启用来源与曲库自身标签）。

### 2. 后端搜索延迟与子进程减负

1. **交互式 `0.8s` 物理间隔与后台调度隔离**（`backend/src/wildstring/plugin_rate.py`、`plugin_archives.py`、`music_sources.py`）
   - `plugin_archives.execute_serial()` 在 `payload["rate"]` 中传递 `"interactive": bool(context.interactive)`。
   - `MusicSources.candidates()` 在 `interactive=True` 且无 `batch_id` 时使用 `interval_seconds = 0.8`。
   - `plugin_rate.permit()` 对 `interactive and not batch_id` 的请求仅约束 `last_at + interval`（下限 `0.8s`），不被后台低频批扫预排的 `next_at` 阻塞；写入许可时采用 `next_at = max(plugin_request_gates.next_at, excluded.next_at)`，确保交互请求不会缩短批扫节拍。
2. **高分逐字歌词短路与搜索词去噪**（`backend/src/wildstring/music_sources.py`）
   - 新增 `search_query(track, *, query_title=None, query_artist=None)`，支持自定义标题/艺人覆盖（并同步参与 `matching()` 评分），同时剔除 `[FLAC]`、`[24bit]`、`(Explicit)`、`(Official Audio)` 等封装/音质噪声，严格保留 `live`、`现场`、`demo`、`remaster`、`acoustic`、`instrumental` 等版本特征词。
   - `MusicSources.step()` 手动查词循环在拿到首条 `matched(candidate)` 且 `quality(normalized)["level"] >= 5`（双语逐字）的候选后立即 `break`，不再多余拉取第二条候选正文。
3. **消除 Node 反向门控子进程与酷狗歌词单进程合并**（`plugins/community_adapters.py`、`plugins/node-runtime/rate.cjs`、`plugins/node-runtime/kugou.cjs`）
   - `bridge()` 当 `context.data.get("rate")` 存在且 `context` 具备 `throttle` 方法时，直接在 `plugin_worker` 进程内完成首次门控等待，并向 `service.cjs` 传入 `"first_permitted": True`；`rate.cjs` 的 `paced()` 首个请求跳过反向 `spawn` Python 子进程，后续同进程请求仍照常门控并遵守间隔。
   - `kugou.cjs` 新增 `/lyric/combined` 入口，在单次 Node 进程中复用同一 `paced()` 依次执行 `/search/lyric` 与 `/lyric`；`QQPlugin`、`NeteasePlugin`、`KuGouPlugin` 版本升至 `2.0.1`。
4. **内置元数据源与插件并行**（`backend/src/wildstring/providers.py`）
   - `Providers.suggestions()` 按传入 `sources` 过滤 MusicBrainz/CAA、Last.fm 与数据源插件分支，使用 `ThreadPoolExecutor` + `copy_context().run` 并发执行并按 `source_priority()` 排序汇总（同时向插件分支透传 `force` 与 `query_override`）。

### 3. 按次选择搜索来源与自定义单曲匹配

1. **单曲在线歌词来源选择与保留**（`backend/src/wildstring/music_sources.py`）
   - `POST /manage/tracks/{track_id}/online-lyrics` 接收可选 `LyricQuery(plugin_ids=...)`，空请求体保持兼容；`GET` 返回 `sources` 可用列表。
   - 仅指定子集来源重查时，仅清理目标 `plugin_id` 的旧未选中手工候选，保留其余来源已有候选不受 5 批历史淘汰影响。
2. **元数据刷新与单曲匹配来源选择**（`backend/src/wildstring/providers.py`）
   - 新增 `GET /api/v1/manage/providers/sources`，并在 `GET /api/v1/manage/providers/tracks/{track_id}` 返回 `available_sources`。
   - `RefreshQuery` 与 `BatchQuery` 支持可选 `sources` 校验与 `options` 持久化；`BatchQuery` 支持 `force`、`interactive` 及单曲 `query_title` / `query_artist` 覆盖；仅重查子集来源时保留其余来源的待处理建议。
3. **歌词批扫可选来源**（`backend/src/wildstring/lyric_scans.py`）
   - `ScanOptions` 增加可选 `plugin_ids`；新增 `GET /api/v1/manage/lyric-scans/sources`（保持 `/manage/lyric-scan-settings` 配置契约不变）；`create()` 与 `preview()` 复用校验并按优先级保留所选来源。

### 4. Web 前端来源选择器、渐进轮询与 `OnlineMetadataMatcher` 修复

- **`frontend/web/src/source-plugins.tsx`（`OnlineLyrics`）**：轮询改为 `250ms -> 500ms -> 1s -> 2s` 渐进退避；可用来源不少于 2 个时展示「全部」与单源胶囊切换，缩窄时随 `POST` 传入 `plugin_ids`。
- **`frontend/web/src/metadata-refresh.tsx`（`MetadataRefreshDialog`）**：可用来源不少于 2 个时在选项区展示来源复选框，进度轮询改为 `300ms -> 600ms -> 1.2s -> 2s`。
- **`frontend/web/src/online-metadata-matcher.tsx` & `style.css`**：修复 `handleSearch` 传递 `query_title`、`query_artist`、`interactive: true`、`force: true` 与可选 `sources`，轮询真实任务状态并修正匹配分百分比显示与窄屏换行布局。
- **`frontend/web/src/lyric-scans.tsx`**：读取 `/manage/lyric-scans/sources` 并在不少于 2 个可用来源时展示来源复选框，`PUT /manage/lyric-scan-settings` 仅提交表单配置字段，扫描请求在缩窄时附带 `plugin_ids`。
- 同步更新 `frontend/web/src/locales/zh-CN.json`、`en.json`（保持键值一致）以及 `docs/product/lyric-scans.md`、`docs/architecture/source-plugins.md`。

## 验收（按 AGENTS.md §3 定级）

- **验收级别**：L2（触及后端调度、数据库增量迁移、参考插件 `2.0.1` 与 Web 多处组件交互；修改前通过 `git grep` 核对全部既有断言）。
- **必跑验证**：
  - `make source-providers-check`、`make source-plugins`、`make test-native-plugin`、`make check`、`make test`
  - Web Playwright 回归覆盖来源选择、`OnlineMetadataMatcher` 关键词检索、渐进轮询及 `MetadataRefreshDialog` / `LyricScans`；渲染桌面与 `390px` 手机宽度的浅深主题截图并逐张核对。
- **专项回归场景**：
  - 交互式 `0.8s` 间隔不等待批扫未来 `next_at`，且不缩短批扫已排定的 `next_at`。
  - 手动查歌词首条 `matched` 且 `level == 5` 时跳过第 2 条候选正文请求。
  - 搜索去噪保留版本词并剔除 `[FLAC]` 等封装噪声。
  - 单曲歌词 / 元数据按子集来源重查保留其余来源候选；跨 5 次单源重查仍保留未重查来源的已有候选。
  - `Providers.suggestions()` 并发总耗时显著小于串行之和，`sources` 过滤可跳过 MusicBrainz / Last.fm，Schema 55 -> 56 迁移保留既有任务。
  - `rate.cjs` `first_permitted: true` 跳过首跳 Python 子进程，`kugou.cjs` `/lyric/combined` 在单进程完成两跳并正常透传 `429`。

## 风险与回滚

- **交互间隔过短触发上游限流**：交互式最小间隔仍受 `>= 0.8s` 串行与 `plugin_request_gates` 冷却保护，遇到平台 `429` 立即进入冷却；如需保守间隔可调整交互常数或回滚对应分支提交。
- **测试 Mock 结构兼容性**：前端仅在后端返回 `>= 2` 个可用来源时渲染来源选择器，且全选时省略 `plugin_ids` / `sources` 字段，确保现有单源/空载荷 Playwright Mock 与 iOS/Android 客户端无感兼容。
