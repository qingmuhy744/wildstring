状态：已确认

# 数据源插件请求缩减与跨来源并行优化

## 目标

- 缩短单曲冷查询与全库歌词批扫的物理上游请求链：字段清晰且无版本歧义时，歌词路径直接基于搜索候选匹配取词（QQ、网易云目标 2 次物理请求，酷狗目标 3 次）；存在歧义时按需批量补查曲目详情；元数据建议保留完整发行信息，但批量合并曲目详情并对同专辑请求去重。
- 消除宿主调度与锁竞争损耗：热缓存走锁外快路径；批扫有到期工作立即推进、空闲才休眠；锁竞争 `source_plugin_busy` 与上游错误分离，不消耗网络失败重试额度，来源槽位支持手动查询优先。
- 打通端到端限流信号并开启跨来源并行：修复 Node 运行时（网易云、酷狗）吞掉 HTTP `429` 与丢失 `Retry-After` 的缺口，确保单来源严格串行门控与冷却；在此基础上支持手动单曲查询（歌词、元数据建议）跨来源并发，以及后台歌词批扫按来源分槽跨歌曲并发（同一首歌按可用来源的优先级串行推进、达标即停）。
- 直接升级插件协议至 `api_version = 2`（参考插件版本 `2.0.0`），不保留 `api_version = 1` 双轨兼容代码，保持核心与插件契约干净。

## 不碰的边界

- 不做音频下载、流媒体代理或绕过上游平台鉴权与反爬校验。
- 同一数据源（`plugin_id`）内部绝不并发突发请求，继续通过 `plugin_request_gates` 强制执行最小请求间隔与 `429` 冷却。
- 不手改 `plugins/node-runtime/vendor/*` 受 `UPSTREAM.json` 哈希锁定的上游源码文件，保持 `make source-providers-check` 原样通过。
- 升级到 v2 时一次性清理已安装的 v1 ZIP、插件配置和插件专用凭据（包括 Cookie）；管理员重新导入 v2 ZIP、配置并启用。清理范围限于受影响的插件，保留曲库、已应用歌词、任务历史和其他服务凭据。
- 暂不引入常驻 Python/Node worker 守护进程或基于历史命中率自动改写用户来源优先级。

## 方案

### 阶段一：宿主调度、锁外缓存与 Node 429 冷却

1. **批扫去固定等待**（`backend/src/wildstring/lyric_scans.py`）
   - 改造 `LyricScans.run()`，复用 `Providers.run()` 的事件循环节奏：`step()` 返回有进展时仅做极短让步（`0.02s`）立即继续处理下一条到期任务或已扫覆盖推进；无到期任务时按最近 `next_at` 计算休眠时长（上限 `0.5s`）并等待 `exit.wait(delay)`，在避免空转的同时消除每步 `0.5s` 固定损耗。

2. **锁外热缓存快路径与进程内优先级槽位**（`backend/src/wildstring/plugin_archives.py`）
   - `execute()` 先调用 `context.manager.current(...)` 校验启用状态与配置版本，再按 `[plugin.sha256, config_version, method, value]` 计算缓存键；非 `force` 且 `provider_cache` 未过期时直接在锁外返回结果。
   - 未命中缓存时先经过每个 `plugin_id` 对应的进程内轻量优先级条件锁，再获取 `.request.lock`，并在锁内二次复查缓存（Double-Checked Locking），避免并发冷请求重复击穿上游：
     - 交互式调用（`batch_id is None`，优先级 `0`）排在后台批扫（`batch_id is not None`，优先级 `1`）之前唤醒并领取释放后的来源槽，在不耦合 `Providers` 与 `LyricScans` 两套任务表的前提下兑现手动优先；
     - 后台批扫短等待后仍未拿到槽位则快速让路并重排；已开始的调用执行到返回或超时。

3. **`source_plugin_busy` 轻推迟重排**（`backend/src/wildstring/lyric_scans.py`）
   - `process_scoped()` 捕获 `source_plugin_busy` 时，不递增真实网络失败 `attempts`，不走 `30/60s` 失败退避，改为短延迟（`2~5s`）重回 `queued`。
   - 单独记录并限制连续锁推迟上限（例如单来源连续推迟超过阈值才记为 `source_plugin_busy` 推进下一来源），防止极端长期占锁导致批扫无法完结。

4. **Node `429` 与 `Retry-After` 透传**（`plugins/node-runtime/rate.cjs`、`plugins/node-runtime/netease.cjs`、`plugins/node-runtime/kugou.cjs`、`backend/src/wildstring/plugin_worker.py`、`plugins/community_adapters.py`）
   - 在 `rate.cjs` 对共享 `axios` 注册响应拦截器，在 vendor `request.js` 将传输或状态异常统一包装成 `502` 之前，提取原始 HTTP 状态码（`429`、`401`、`403`）与 `Retry-After` 响应头（支持整数秒与 HTTP-date 解析，裁剪至 `60..86400` 秒），同时识别响应体内的限流业务码。
   - Node 运行时向 stdout 输出 `{wildstring_error: "source_plugin_rate_limited", retry_after}`，由 `bridge()` 与 `plugin_worker.py` 保留结构化字段（如 `upstream_429=True`、`retry_after`、`cooldown_until`），同时对外继续保持 `error.code == "source_plugin_rate_limited"` 兼容既有 API 与测试契约。
   - `plugin_worker.py` **仅当** `upstream_429` 为真时调用 `plugin_rate.cooldown(rate, delay)` 写入或延长冷却；门控拒绝只透传既有 `cooldown_until` 与 `source_plugin_rate_limited` 错误码，重复查询不延长冷却，也不消耗网络失败重试额度。验收使用最终 ZIP 内的 Node 运行时，确认拦截器捕获的信息能在 vendor 包装成 502 后仍传到 Python。

### 阶段二：插件契约升级 `api_version = 2`、搜索预匹配与批量详情去重

1. **升级至 `api_version = 2` 并清理旧安装**（`backend/src/wildstring/source_plugins/__init__.py`、`backend/src/wildstring/plugin_archives.py`、`backend/src/wildstring/music_sources.py`、`backend/src/wildstring/plugin_worker.py`）
   - 定义协议常量 `API_VERSION = 2`；`inspect_package()` 仅接受 `api_version == 2`；`GET /api/v1/manage/source-plugins` 返回 `api_version: 2`。
   - 在插件 worker 启动前完成一次可重试的清理。按旧 manifest 识别 v1 记录和插件专用凭据；停止旧包被认领或执行，清理安装和设置记录、对应旧 ZIP 与插件状态，保留同来源已经生效的请求冷却。已有待执行任务涉及旧包时进入可解释的终态，历史任务和已应用歌词继续可读。旧包移除后，手动入口只选择已启用且可用的插件。
   - v2 宿主、三个 v2 ZIP、架构契约和管理页提示同批交付。提示重新导入并配置插件，包含 Cookie 需要重新填写的说明。

2. **统一搜索摘要与按需批量详情契约**
   - `search(context, query)`：返回最多 3 条已清洗的候选摘要 `[{id, title, artists, album?, duration_ms?, release_id?, source_url, token?}]`，宿主直接做 URL/时长边界校验并执行 `matching(track, item)`。
   - `metadata(context, request)`：接收 `{"candidates": [...], "include_release": bool}`，返回按来源曲目 ID 关联的逐项结果。单条失败或缺失时保留其他成功结果，宿主按 ID 对齐乱序响应；缺失详情的歧义候选不进入自动匹配。
     - `include_release=False`：供歌词路径歧义回退使用，仅批量拉取曲目级权威标题、艺人、时长与版本特征。
     - `include_release=True`：供元数据建议使用，补齐专辑发行日期、流派与封面。
     - 因缓存键包含序列化后的 `request`，`include_release` 自然隔离深浅两套 `provider_cache`，杜绝歌词轻量查询污染元数据完整建议。
   - `lyrics(context, candidate)`：直接消费 `search` 或 `metadata` 产出的候选对象，内置 `lyric_formats.normalize_bundle` 保持不变。

3. **歌词按需补详情判定规则**（`backend/src/wildstring/music_sources.py`）
   - 歌词路径先对 `search()` 返回的前 3 条候选执行 `matching()` 预匹配；仅当命中任一歧义条件时，才把相关候选聚合为一次 `metadata(..., include_release=False)` 批量调用并重算分数：
     - 任一待评估候选缺失标题、艺人或有效时长；
     - 标题出现疑似截断（如过长省略号）或与本地曲目存在版本词边界模糊；
     - 有效候选前两名得分接近（分差 `< 0.05`）或均处于临界匹配区间；无候选达标时，对仍可能匹配的候选补查。
   - 搜索字段明确区分版本时（例如录音室版、Demo、Live 时长与标题清晰），跳过 `metadata()` 直接请求 `lyrics()`。

4. **三内置适配器请求合并**（`plugins/community_adapters.py`，版本升至 `2.0.0`）
   - `QQPlugin`：使用锁定版本 `qqmusic_api` 的 `Client.gather()`（保持 `max_concurrency=1`）将多个候选的 `song.get_detail` 合并为单次 CGI HTTP 请求（仅消耗 1 次门控许可）；仅在 `include_release=True` 时按 `album.mid` 去重后，再用 `Client.gather()` 合并 `album.get_detail`。
   - `NeteasePlugin`：`/song/detail` 一次传入多个歌曲 ID（`ids` 为逗号分隔的字符串）；仅在 `include_release=True` 时按 `album.id` 去重查询 `/album`。
   - `KuGouPlugin`：`/krm/audio` 一次传入多个 `album_audio_id` 批量获取 `album_info,base,authors.base`（其返回已包含专辑名、发行日期与封面模板，无需额外专辑请求）。

### 阶段三：手动查询跨来源并行与批扫按来源分槽并行

1. **手动单曲查询跨来源并行**（`backend/src/wildstring/music_sources.py`）
   - `MusicSources.suggestions()`（元数据建议）与 `MusicSources.step()`（手动在线歌词任务）对所有已启用对应能力的插件使用有界 `ThreadPoolExecutor`（线程上限为当前已启用插件数）并行执行。
   - **上下文传播与短事务约束**：工作线程必须通过 `contextvars.copy_context().run(...)` 继承 `library_job_scope` 建立的 `current_library` 上下文，保证多曲库可见性与权限校验准确；单来源超时、异常或 `429` 仅记入 `warnings` 不影响其他来源；各来源完成后通过短写事务落库或由协调线程汇总提交，避免长事务持锁。

2. **批扫按来源分槽跨歌曲并行**（`backend/src/wildstring/lyric_scans.py`）
   - 将批扫单线程循环升级为“协调器选任务 + 每来源至多 1 个活跃槽位”的并发调度器：
     - 同一 `track_id` 同一时刻只允许一个活跃批扫项，逐来源推进。满足目标时在一个事务内保存结果并转入 `ready`；只有需要继续查询时才重新入队。
     - 无需新增数据库列：以现有的 `lyric_scan_items.results` JSON 映射作为已完成来源权威集合（`provider_index` 同步写为 `len(results)`，不再作为单向跳过游标）。每次调度按 `options["providers"]` 优先级选出首个未在 `results` 中且未冷却的来源；仅在需要新增物理请求时受冷却约束，覆盖记录和热缓存仍可直接命中。若当前所有剩余未查来源均处于冷却中，则以 `next_at = min(cooldown_until)` 重新入队，等冷却到期后再补查，不把暂缓来源记作未匹配；若后续已达标则直接结束。
     - 来源槽空闲时通过阶段一的进程内优先级条件锁优先让手动任务领取；每个来源仍只执行一个调用，继续共享原有物理请求门控。
     - 继续复用 `exit` 暂停/取消信号、`checkpoint()` 批次状态检查与 `library_job_scope` 上下文隔离。

### 阶段四：插件打包器、Nuitka 原生扩展与文档契约同步

- 更新 `scripts/package_source_plugins.py` 的 AST 导出符号清单与 `README.txt`（声明 `WildString source plugin API v2`），核验 `make source-plugins`。
- 更新原生编译插件夹具 `tests/fixtures/plugins/native_core.py` 至 v2 方法签名，核验 `make test-native-plugin`。
- 遵循 `AGENTS.md` §2 界面降噪原则同步文档与简明文案：更新 Web（`frontend/web/src/locales/zh-CN.json`、`frontend/web/src/locales/en.json`）中的 `sourcePlugins.importDescription` 以及 `docs/architecture/source-plugins.md`，明确插件与候选管理仅在 Web 提供，取消对跨主协议版本无条件保留旧包的承诺，简明写清“兼容协议升级保留插件与配置，协议大版本变更会清理不兼容旧包并需重新导入与配置”；不为新安装空状态堆砌常驻迁移横幅。
- **Android 历史残留死代码清理**（插件管理、批扫管理、管理中心与资料候选审阅入口已在 `MobileFeatures.kt` `"source-plugins"`、`"lyric-scans"`、`"management"`、`"suggestions"` 路由退役并引导至 Web，清理下列未挂载死代码及孤立资源，严禁误删仍在使用的面板与路由）：
  - `frontend/android/app/src/main/java/com/wildstring/app/ui/MusicSourcePlugins.kt`：删除未挂载的 `SourcePluginsPanel`（以及仅由它引用的 `uploadPlugin` / `downloadPlugin` 等 API 辅助方法）；**保留同一文件内的 `OnlineLyricsPanel`**（仍被 `"lyrics"` 路由下的 `LyricsEditorPanel` 挂载）。
  - `frontend/android/app/src/main/java/com/wildstring/app/ui/LyricScans.kt`：删除未挂载的 `LyricScansPanel`；**保留 `lyricLevelLabel`**（或将其移至 `AgentWorkspace.kt` 旁），因 `AgentWorkspace.kt` 仍在调用。
  - `frontend/android/app/src/main/java/com/wildstring/app/ui/LibraryManagementTools.kt`：删除未挂载的 `ManagementPanel` 与 `SuggestionsPanel`；**保留 `MetadataPanel`、`LyricsEditorPanel`、`AlbumMetadataPanel` 与 `MetadataRefreshPrompt`**。
  - `frontend/android/app/src/main/java/com/wildstring/app/ui/MetadataReview.kt`：删除未挂载的 `MetadataReviewPanel`（及该文件内不再被引用的残留代码）。
  - `frontend/android/app/src/main/res/values/strings.xml` 与 `values-zh/strings.xml`：清理上述死代码移除后不再被引用的孤立字符串资源（如无人引用的 `src_plugin_*`、`lyric_scan_*`、`meta_rev_*`、`lib_mgmt_*`，以 Android Lint `UnusedResources` 检出为准），同时**保留** `MobileFeatures.kt` 中引导前往 Web 的 `"source-plugins"` / `"lyric-scans"` 等路由及 `SourceGainWorkspaceTest` 现有断言。

## 验收（按 AGENTS.md §3 定级）

- **验收级别**：L3（插件协议、后端调度、Web 文案以及 Android 历史残留死代码与资源清理）。
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
  - 交付前执行 `make ci` 与 `make android-ci`（运行 `:app:lintDebug` 检查无孤立字符串资源、单元测试、`:app:compileDebugAndroidTestKotlin` 含 `SourceGainWorkspaceTest` 与 Debug APK 打包），并按项目验收规则逐张检查 Web 桌面与 `390px` 手机宽度浅深主题截图，覆盖清理后空状态、导入 v2 与正常启用状态。
- **专项量化与回归场景（隔离合成上游 + 假 HTTP 传输）**：
  - **请求预算**：无歧义曲目歌词冷查询验证 QQ、网易云物理请求降至 2 次、酷狗降至 3 次；隐藏重制版后缀导致同分歧义时触发 1 次批量详情回退并正确区分版本；同专辑 3 候选元数据建议验证专辑详情按 `release_id` 去重，且 `include_release=False/True` 缓存互不污染；批量响应乱序或缺失单条时保留成功项；摘要未达标时可通过详情回退正确匹配。
  - **锁与调度延迟**：同来源持锁慢查询期间热缓存命中耗时 `< 50ms`（不再等待 2s 报错）；批扫连续 4 步已扫覆盖推进总耗时 `< 200ms`；批扫撞到已占用的来源锁时短暂重排，且不消耗 `attempts`；来源槽释放后，排队中的手动任务先于后台领取。
  - **429 端到端与跨来源并行**：从假 HTTP 层向网易云/酷狗 Node 运行时注入 `HTTP 429` + `Retry-After: 120`，验证 `plugin_request_gates.cooldown_until` 正确写入约 120s，验证冷却期间重复查询不产生上游请求、不续期，缓存仍可用；首选来源冷却时其余来源继续，达标歌曲不再发后续请求，未达标歌曲到期后可继续查被暂缓的来源。
  - **存量 v1 清理回归**：用带 Cookie、已应用歌词和未完成任务的合成实例验证升级。旧包、旧设置及插件专用 Cookie 被清理；旧任务进入终态，已应用歌词与无关配置仍可用。重复启动无额外影响，重新导入并配置 v2 后查询正常。

## 风险

- **搜索摘要字段缺失导致误配风险**：冷门曲目搜索结果可能省略版本后缀或返回时长为 0。通过“缺标题/艺人/有效时长、标题疑似截断或版本模糊、前两名得分差 `< 0.05` 一律触发批量详情回退”兜底；若线上某平台搜索质量波动，只需调整该适配器 `search()` 清洗逻辑或宿主歧义阈值即可退回批量详情路径，无需回滚协议。
- **并发与 SQLite 写锁争用风险**：跨来源并行仅并发外部子进程 IO，SQLite 写事务维持短小原子提交，线程池强制通过 `contextvars.copy_context().run` 传播曲库上下文，防止跨库越权或上下文丢失。
- **升级摩擦风险**：在发布说明中写明 v1 安装清理范围，提醒管理员导入所需的 `2.0.0` ZIP、重新填写外部服务地址或 Cookie 并启用。
