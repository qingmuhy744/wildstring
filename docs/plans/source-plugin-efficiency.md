状态：草案

# 数据源插件请求缩减与跨来源并行优化

## 目标

- 缩短单曲冷查询与全库歌词批扫的物理上游请求链：字段清晰且无版本歧义时，歌词路径直接基于搜索候选匹配取词（QQ、网易云目标 2 次物理请求，酷狗目标 3 次）；存在歧义时按需批量补查曲目详情；元数据建议保留完整发行信息，但批量合并曲目详情并对同专辑请求去重。
- 消除宿主调度与锁竞争损耗：热缓存走锁外快路径；批扫有到期工作立即推进、空闲才休眠；锁竞争 `source_plugin_busy` 与上游错误分离，不消耗失败重试额度且交互式查询优先。
- 打通端到端限流信号并开启跨来源并行：修复 Node 运行时（网易云、酷狗）吞掉 HTTP `429` 与丢失 `Retry-After` 的缺口，确保单来源严格串行门控与冷却；在此基础上支持手动单曲查询（歌词、元数据建议）跨来源并发，以及后台歌词批扫按来源分槽跨歌曲并发（同一首歌仍按来源优先级串行推进、达标即停）。
- 直接升级插件协议至 `api_version = 2`（参考插件版本 `2.0.0`），不保留 `api_version = 1` 双轨兼容代码，保持核心与插件契约干净。

## 不碰的边界

- 不做音频下载、流媒体代理或绕过上游平台鉴权与反爬校验。
- 同一数据源（`plugin_id`）内部绝不并发突发请求，继续通过 `plugin_request_gates` 强制执行最小请求间隔与 `429` 冷却。
- 不手改 `plugins/node-runtime/vendor/*` 受 `UPSTREAM.json` 哈希锁定的上游源码文件，保持 `make source-providers-check` 原样通过。
- 服务升级不自动删除或覆盖用户数据目录已安装的旧插件记录、配置与已存 Cookie 密钥；存量 `api_version = 1` 旧包仅标记为不可用并给出明确升级提示，管理员导入 `2.0.0` ZIP 后无损继承原有配置与密钥。
- 暂不引入常驻 Python/Node worker 守护进程或基于历史命中率自动改写用户来源优先级。

## 方案

### 阶段一：宿主调度去阻塞、锁外缓存快路径与 Node 429 门控闭环

1. **批扫去固定等待**（`backend/src/wildstring/lyric_scans.py`）
   - 改造 `LyricScans.run()`，复用 `Providers.run()` 的事件循环节奏：`step()` 返回有进展时仅做极短让步（`0.02s`）立即继续处理下一条到期任务或已扫覆盖推进；无到期任务时按最近 `next_at` 计算休眠时长（上限 `0.5s`）并等待 `exit.wait(delay)`，在避免空转的同时消除每步 `0.5s` 固定损耗。

2. **锁外热缓存快路径与交互优先锁策略**（`backend/src/wildstring/plugin_archives.py`）
   - `execute()` 先调用 `context.manager.current(...)` 校验启用状态与配置版本，再按 `[plugin.sha256, config_version, method, value]` 计算缓存键；非 `force` 且 `provider_cache` 未过期时直接在锁外返回结果。
   - 未命中缓存时再获取 `.request.lock`，并在锁内二次复查缓存（Double-Checked Locking），避免并发冷请求重复击穿上游。
   - 区分锁等待预算：交互式调用（`batch_id is None`）`timeout=15` 秒；后台批扫（`batch_id is not None`）`timeout=0.1` 秒快速让路给手动查询。

3. **`source_plugin_busy` 轻推迟重排**（`backend/src/wildstring/lyric_scans.py`）
   - `process_scoped()` 捕获 `source_plugin_busy` 时，不递增真实网络失败 `attempts`，不走 `30/60s` 失败退避，改为短延迟（`2~5s`）重回 `queued`。
   - 单独记录并限制连续锁推迟上限（例如单来源连续推迟超过阈值才记为 `source_plugin_busy` 推进下一来源），防止极端长期占锁导致批扫无法完结。

4. **Node `429` 与 `Retry-After` 透传**（`plugins/node-runtime/rate.cjs`、`plugins/node-runtime/netease.cjs`、`plugins/node-runtime/kugou.cjs`、`backend/src/wildstring/plugin_worker.py`、`plugins/community_adapters.py`）
   - 在 `rate.cjs` 对共享 `axios` 注册响应拦截器，在 vendor `request.js` 将传输或状态异常统一包装成 `502` 之前，提取原始 HTTP 状态码（`429`、`401`、`403`）与 `Retry-After` 响应头（支持整数秒与 HTTP-date 解析，裁剪至 `60..86400` 秒），同时识别响应体内的限流业务码。
   - Node 运行时向 stdout 输出 `{wildstring_error: "source_plugin_rate_limited", retry_after}`，由 `bridge()`（携带 `retry_after` 字段或映射到带时长信息的 `PluginError`）与 `plugin_worker.py` 传递给 `plugin_rate.cooldown(rate, delay)`，确保真实触发平台限流后对应来源准确进入冷却。

### 阶段二：插件契约升级 `api_version = 2`、搜索预匹配与批量详情去重

1. **干净升级 `api_version = 2` 与存量包保护**（`backend/src/wildstring/source_plugins/__init__.py`、`backend/src/wildstring/plugin_archives.py`、`backend/src/wildstring/music_sources.py`、`backend/src/wildstring/plugin_worker.py`）
   - 定义协议常量 `API_VERSION = 2`；`inspect_package()` 仅接受 `api_version == 2`；`GET /api/v1/manage/source-plugins` 返回 `api_version: 2`。
   - 对升级前已存在于数据库的 `manifest.api_version != 2` 存量安装包，`InstalledPlugin.available()` 返回 `False`（目录项暴露不兼容标识，执行兜底抛出 `source_plugin_incompatible_api`），保留 `source_plugin_settings` 与 `secrets`，Web 与 Android 管理页明确提示导入 `2.0.0` ZIP 升级。

2. **统一搜索摘要与按需批量详情契约**
   - `search(context, query)`：返回最多 3 条已清洗的候选摘要 `[{id, title, artists, album?, duration_ms?, release_id?, source_url, token?}]`，宿主直接做 URL/时长边界校验并执行 `matching(track, item)`。
   - `metadata(context, request)`：接收 `{"candidates": [...], "include_release": bool}`，返回对应的详情列表。
     - `include_release=False`：供歌词路径歧义回退使用，仅批量拉取曲目级权威标题、艺人、时长与版本特征。
     - `include_release=True`：供元数据建议使用，补齐专辑发行日期、流派与封面。
     - 因缓存键包含序列化后的 `request`，`include_release` 自然隔离深浅两套 `provider_cache`，杜绝歌词轻量查询污染元数据完整建议。
   - `lyrics(context, candidate)`：直接消费 `search` 或 `metadata` 产出的候选对象，内置 `lyric_formats.normalize_bundle` 保持不变。

3. **歌词按需补详情判定规则**（`backend/src/wildstring/music_sources.py`）
   - 歌词路径先对 `search()` 返回的前 3 条候选执行 `matching()` 预匹配；仅当命中任一歧义条件时，才把相关候选聚合为一次 `metadata(..., include_release=False)` 批量调用并重算分数：
     - 任一待评估候选缺失标题、艺人或有效时长；
     - 标题出现疑似截断（如过长省略号）或与本地曲目存在版本词边界模糊；
     - 有效候选前两名得分接近（分差 `< 0.05`）或均处于临界匹配区间。
   - 搜索字段明确区分版本时（例如录音室版、Demo、Live 时长与标题清晰），跳过 `metadata()` 直接请求 `lyrics()`。

4. **三内置适配器请求合并**（`plugins/community_adapters.py`，版本升至 `2.0.0`）
   - `QQPlugin`：使用锁定版本 `qqmusic_api` 的 `Client.gather()`（保持 `max_concurrency=1`）将多个候选的 `song.get_detail` 合并为单次 CGI HTTP 请求（仅消耗 1 次门控许可）；仅在 `include_release=True` 时按 `album.mid` 去重后，再用 `Client.gather()` 合并 `album.get_detail`。
   - `NeteasePlugin`：`/song/detail` 一次传入多个歌曲 ID（`ids` 数组字符串）；仅在 `include_release=True` 时按 `album.id` 去重查询 `/album`。
   - `KuGouPlugin`：`/krm/audio` 一次传入多个 `album_audio_id` 批量获取 `album_info,base,authors.base`（其返回已包含专辑名、发行日期与封面模板，无需额外专辑请求）。

### 阶段三：手动查询跨来源并行与批扫按来源分槽并行

1. **手动单曲查询跨来源并行**（`backend/src/wildstring/music_sources.py`）
   - `MusicSources.suggestions()`（元数据建议）与 `MusicSources.step()`（手动在线歌词任务）对所有已启用对应能力的插件使用有界 `ThreadPoolExecutor`（线程上限为当前已启用插件数）并行执行。
   - **上下文传播与短事务约束**：工作线程必须通过 `contextvars.copy_context().run(...)` 继承 `library_job_scope` 建立的 `current_library` 上下文，保证多曲库可见性与权限校验准确；单来源超时、异常或 `429` 仅记入 `warnings` 不影响其他来源；各来源完成后通过短写事务落库或由协调线程汇总提交，避免长事务持锁。

2. **批扫按来源分槽跨歌曲并行**（`backend/src/wildstring/lyric_scans.py`）
   - 将批扫单线程循环升级为“协调器选任务 + 每来源至多 1 个活跃槽位”的并发调度器：
     - 同一 `track_id` 同一时刻只允许 1 个 `running` 批扫项，严格保持原来源优先级顺序（`provider_index`）与 `reaches(best_quality, goal)` 达标即停语义，不因并发多发无谓上游请求。
     - 选任务时按 `item.provider_index` 对应的目标 `plugin_id` 匹配空闲来源槽，并主动避开 `plugin_request_gates.cooldown_until > now` 的冷却中来源（对受冷却影响的排队项推迟 `next_at = cooldown_until`），使 QQ 查歌曲 A 时网易云与酷狗可同步处理歌曲 B、C，单来源冷却不阻塞全库扫描吞吐。
     - 继续复用 `exit` 暂停/取消信号、`checkpoint()` 批次状态检查与 `library_job_scope` 上下文隔离。

### 阶段四：插件打包器、Nuitka 原生扩展与文档契约同步

- 更新 `scripts/package_source_plugins.py` 的 AST 导出符号清单与 `README.txt`（声明 `WildString source plugin API v2`），核验 `make source-plugins`。
- 更新原生编译插件夹具 `tests/fixtures/plugins/native_core.py` 至 v2 方法签名，核验 `make test-native-plugin`。
- 更新 Web（`frontend/web/src/locales/zh-CN.json`、`frontend/web/src/locales/en.json`、`frontend/web/src/source-plugins.tsx`）与 Android（`frontend/android/app/src/main/res/values/strings.xml`、`frontend/android/app/src/main/res/values-zh/strings.xml`、`frontend/android/app/src/main/java/com/wildstring/app/data/AgentPlatform.kt`、`frontend/android/app/src/main/java/com/wildstring/app/ui/MusicSourcePlugins.kt`）对 `source_plugin_incompatible_api` 与旧版包不可用状态的平静提示文案（说明“插件包 API 版本已更新，请在版本与维护中导入新版 ZIP，原有配置与密钥会保留”）。
- 同步更新 `docs/architecture/source-plugins.md` 契约说明。

## 验收（按 AGENTS.md §3 定级）

- **验收级别**：L2（触及后端核心插件调度、跨来源并发、参考插件包构建；涉及 Web 与 Android 插件提示映射与文案时，按 L3 补充对应客户端检查与截图核对）。
- **前置断言清点**：修改规则前使用 `git grep` 清点并列出需要同步更新的现有断言（`api_version == 1`、旧三方法签名、`source_plugin_busy` 重试次数、错误码文案）：
  - `backend/tests/test_plugin_contract.py`
  - `backend/tests/test_source_plugins.py`
  - `backend/tests/test_lyric_scans.py`
  - `backend/tests/test_mcp_music.py`、`backend/tests/test_security_contracts.py`
  - `plugins/node-runtime/tests/metadata-surface.test.cjs`、`plugins/node-runtime/tests/native-rsa.test.cjs`
  - `tests/fixtures/plugins/native_core.py`
  - `frontend/web/tests/source-plugins-gain.spec.ts`
- **构建与自动化验证**：
  - `make source-providers-check`：确认未破坏 `plugins/node-runtime/vendor/*` 上游溯源哈希。
  - `make source-plugins`：跑通 `plugins/node-runtime` 单元测试、rolldown 打包与三个 `2.0.0` ZIP 产物生成。
  - `make check` 与 `make test-affected`：覆盖全部更新后的后端、Web 与契约检查。
  - `make test-native-plugin`：验证 Nuitka CPython 3.12 编译扩展在 `api_version = 2` 契约下的导入、调用与升级。
  - 若改动 Android 文案或代码映射，执行 `make android-check android-test`；若改动 Web 插件管理页提示，渲染桌面与 `390px` 手机宽度的浅深主题截图逐张核对（覆盖旧 v1 包提示升级状态与正常启用状态）。
- **专项量化与回归场景（隔离合成上游 + 假 HTTP 传输）**：
  - **请求预算**：无歧义曲目歌词冷查询验证 QQ、网易云物理请求降至 2 次、酷狗降至 3 次；隐藏重制版后缀导致同分歧义时触发 1 次批量详情回退并正确区分版本；同专辑 3 候选元数据建议验证专辑详情按 `release_id` 去重，且 `include_release=False/True` 缓存互不污染。
  - **锁与调度延迟**：同来源持锁慢查询期间热缓存命中耗时 `< 50ms`（不再等待 2s 报错）；批扫连续 4 步已扫覆盖推进总耗时 `< 200ms`；手动查询撞批扫锁时批扫快速让路且不消耗 `attempts`。
  - **429 端到端与跨来源并行**：从假 HTTP 层向网易云/酷狗 Node 运行时注入 `HTTP 429` + `Retry-After: 120`，验证 `plugin_request_gates.cooldown_until` 正确写入约 120s，仅该来源冷却，其余两个来源在手动并行查询与批扫分槽调度中继续正常完成，总耗时接近最慢可用来源。
  - **存量 v1 包升级回归**：在隔离 SQLite 预置已启用且带 Cookie 密钥的 `api_version = 1` 包，服务启动不崩溃、该包显示 `available=False`、原配置与密钥完整保留，导入 `2.0.0` ZIP 升级后恢复可用。

## 风险与回滚

- **搜索摘要字段缺失导致误配风险**：冷门曲目搜索结果可能省略版本后缀或返回时长为 0。通过“缺标题/艺人/有效时长、标题疑似截断或版本模糊、前两名得分差 `< 0.05` 一律触发批量详情回退”兜底；若线上某平台搜索质量波动，只需调整该适配器 `search()` 清洗逻辑或宿主歧义阈值即可退回批量详情路径，无需回滚协议。
- **并发与 SQLite 写锁争用风险**：跨来源并行仅并发外部子进程 IO，SQLite 写事务维持短小原子提交，线程池强制通过 `contextvars.copy_context().run` 传播曲库上下文，防止跨库越权或上下文丢失。
- **升级摩擦风险**：现有自托管实例升级后需导入一次新版三个插件 ZIP（Release 产物同步提供 `2.0.0` 包），原有配置、外部服务地址与 Cookie 密钥自动保留；如需回退可切回旧镜像并使用管理页保留的旧 ZIP 恢复。
