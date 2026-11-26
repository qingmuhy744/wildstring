状态：已实施

# 跨端审查缺陷修复与防回归护栏（0.9.0-alpha.1）

## 目标

基于对全仓代码审查在当前 `feat/bookshelf-0.9.0a1` 分支上的实证核对结果，按三个独立提交批次修复已确认的高/中/低优先级真实缺陷，并补齐防回归测试与 CI 护栏。

（注：审查中涉及 `file_reorganizer.py` 的大小写仅改名 409 与符号链接目录逃逸已在当前分支 `_replace_entry` 的 `dir_fd` + `os.path.samestat` 实现中修复，不再重复改动。）

## 不碰的边界

- 保留用户工作区原有 4 项未提交内容，绝不改动、暂存或提交：`Makefile` 中的 `AI_TEST_ENV` / `test-ai-local` / `test-ai-live` 区块、`docs/development.md`、`docs/plans/local-ai-testing.md`、`scripts/ai_test.py`。
- 不改写既有历史提交，不自动 `git push`，提交说明不包含 `Co-Authored-By:`。
- 严格遵循 `AGENTS.md`、`DESIGN.md` 与现行契约；如更改契约行为需同步更新对应 `contracts/*.md`。
- 本机为 Linux，无法执行 Xcode / `make macos-test` / `make ios-test`，Apple 改动须明确报告构建与运行验证缺口。

## 方案

执行进度：批次 1、2、3 均已落地。

### 批次 1：数据安全与跨账号隔离（独立提交 1）

1. **播客队列防截断（后端 + Android）**
   - `backend/src/wildstring/podcasts.py`：`delete_podcast` 删除节目时同步清理所有用户的 `podcast_queue_state.items_json` 中对应单集并递增队列版本（可复用合并时的重写逻辑）。
   - `backend/src/wildstring/podcast_queue.py`：`GET /podcasts/queue` 过滤不可访问条目并处理版本一致；`PUT /podcasts/queue` 遇不可访问条目返回 422 时携带 `episode_id` / `dropped_episode_ids` 明细，不截断写入。
   - `frontend/android/.../data/Repository.kt`：删除 `replacePodcastQueue` 中 422 后降级“只提交第一条”的截断逻辑（保留旧服务器兼容的 `includeAddedAt = false` 安全重试），422 原样抛给调用方并保留本机队列。
   - `frontend/android/.../ui/PodcastQueueController.kt`：为队列编辑协程引入 `owner` 与代次校验，`reset()` 取消整个编辑子作用域，防止切账号竞态写串。
   - 补后端与 Android 单测回归：第二条失效时 PUT 返回 422 且服务端队列不变；删节目后队列仍可编辑与自然播完推进。
2. **批量改专辑/文件夹资料按字段合并**
   - `backend/src/wildstring/management.py`（`update_metadata_album` 与文件夹批量更新）与 `backend/src/wildstring/library/edits.py`：批量保存仅合并请求显式传入的字段，保留各单曲原有的其他人工 `overrides`（如单曲标题/艺人）。
   - 补回归测试：单曲覆盖 `title` 后再批量修改专辑字段，单曲 `title` 覆盖保留。
3. **待整理审批明细字段崩溃修复**
   - `backend/src/wildstring/library/intake.py`：调用 `dataclasses.replace(metadata, ...)` 仅传入 `Metadata` 基础字段，其余明细覆盖走既有 `apply_overrides` 流程，不再抛出 `TypeError` 变成 `intake_file_unavailable`。补回归测试。
4. **Android 跨账号缓存清理**
   - `frontend/android/.../data/Repository.kt`：在 `logout` / `acceptAccount` 切换会话时清空 `podcastFavoriteIds` 与 `discoveryCache`（或按 owner 隔离），补单测验证。

### 批次 2：安全、导入稳定性与播客可靠性（独立提交 2）

1. **`WILDSTRING_CONNECTION_POLICY` 严格校验**：`backend/src/wildstring/config.py` 改为 `Literal["mixed", "https_only", "legacy"]`，非法配置启动即失败，避免静默降级 `legacy`（同步检查 `server_settings.py` 与测试）。
2. **登录 `scrypt` 移出 SQLite 写锁 + Schema 62**：`backend/src/wildstring/auth.py` 将密码哈希校验移出 `BEGIN IMMEDIATE` 写事务（短读事务取用户与 guard → 锁外算 scrypt → 短写事务落会话与 guard）；`backend/src/wildstring/database.py` 升至 schema 62，补充 `sessions(expires_at)` 索引并移除未使用的旧 `login_guard` 表。
3. **插件归档与子进程边界**：`backend/src/wildstring/plugin_archives.py` 在 inspect 阶段将 `package.zip` 列为保留名返回 422（避免 500 `IsADirectoryError`）；子进程退出后仅在 `process.poll() is None` 时 `killpg`，`wait(timeout=5)` 防止无界阻塞。
4. **WAV 直接上传一致性**：核对 `backend/src/wildstring/library/upload.py`、`scanner.py`、`frontend/web/src/music-uploader.tsx` 与相关测试，确保上传入口不再“假成功导入但扫描器永不索引”（在直传入口明确拒绝 `.wav` 并给出清晰提示，或在确认无破坏后统一格式集合）。
5. **重组织后同步专辑身份**：`backend/src/wildstring/library/file_reorganizer.py` 移动托管文件后在事务内通过 `apply_effective` 同步重算 `album_id` 与 release lock（保持已有 `_replace_entry` 的 `O_NOFOLLOW` 与 `samestat` 行为不回退）。
6. **播客可靠性与边界修复**：
   - `backend/src/wildstring/podcast_identity_backfill.py`：RSS 抓取失败写 `failed`（可重试）而非 `no_match`（7 天冻结）；合并重复节目将未过期的 `podcast_resource_leases` 纳入忙碌判定与孤儿删除保护，先删文件再清登记。
   - `backend/src/wildstring/podcast_queue.py`：`_read_prefs` / `put_preferences` 过滤或忽略因降权不可访问的节目并返回 dropped 提示，不再整单 422 锁死偏好保存。
   - `backend/src/wildstring/podcast_opml.py`：去掉字符级 `max_length`，统一按字节上限返回 413。
   - `backend/src/wildstring/podcast_resources.py`：统计磁盘占用按解析后的路径去重累计。
   - `backend/src/wildstring/podcast_search.py`：目录封面代理补充账号级限流与并发 single-flight 保护。
   - `backend/src/wildstring/site_access.py`：`/mcp` 出口统一附带 `Cache-Control: no-store`。
   - `backend/src/wildstring/config.py`：`podcasts_dir` 纳入目录互不包含重叠校验。

### 批次 3：Apple、Web 缺陷、CI 护栏与遗留清理（独立提交 3）

1. **Apple（iOS / macOS）**
   - `frontend/macos/WildStringMac/MacSession.swift` & `frontend/ios/WildStringKit/Sources/CoreNetwork/WildstringClient.swift`：`activate` 校验持久化 `mac.library.*` 是否在启用 `/libraries` 中，不匹配则清空；`perform` 遇 404 `library_not_found` 清空库选择；`deleteServer` 同步清 `mac.library.*`。
   - `frontend/ios/WildStringKit/Sources/CorePlayback/PlaybackService.swift`：播客队列跳过或过滤后再发布跨端 `playbackSnapshot`（与 Web 对齐），错误接入 UI。
   - `frontend/ios/WildString/PagedListModel.swift`（含 `AlbumTracksModel`）：引入 revision/代次校验防止刷新竞态丢首页。
   - `frontend/ios/WildStringKit/Sources/CorePlayback/AudioDiskCache.swift` & `AudioRangeFetcher.swift`：磁盘缓存索引记录并校验 ETag/size（不一致淘汰整轨）；区分 HTTP 206 与 200，避免将全量 200 文件头错写成任意 offset 缓存。
2. **Web 修复**
   - `frontend/web/src/offline.ts`：IndexedDB 存储稳定错误码（如 `waiting_for_network`）替代翻译后文案哨兵，展示层再翻译。
   - `frontend/web/src/podcast-inbox.tsx`：拖拽排序仅提升被移动条目的 `origin` 为 `manual`；单节目分发保存失败回滚下拉值。
   - `frontend/web/src/podcast-resources.tsx`：补 `AbortController` + 请求序号保护，翻页请求期间禁用翻页按钮。
   - `frontend/web/src/workspace-ui.tsx` & `agent-workbench.tsx`：离线/隐藏标签页早退时正确更新状态，任务页先判 loading 避免误显空态。
   - `frontend/web/src/podcasts.tsx` & `agent-workbench.tsx`：修复缺失 locale 键 `common.loading` 与 `podcastDownloads.retrySingle`。
   - `frontend/web/src/podcast-remote.ts`：拆分 `QueueWriteResult`，与 PUT 实际返回字段一致。
3. **CI 护栏与清理**
   - `scripts/check_i18n_keys.py`：增加“前端代码静态 `t('...')` 引用 → locale 键存在”反向检查及单测。
   - 修复 `library/api.py` 与 `podcasts.py` 中 GET/HEAD 共用 `api_route` 导致的 OpenAPI `operationId` 重复，补后端单测断言全站 OpenAPI `operationId` 唯一。
   - 清理确认无引用的死代码与文案：`CatalogGapCard`（含 `catalogGapCard.*`）、`queue-panel.tsx` 的 `upNextOnly` 死分支、未使用的 `roles` locale 段、核对并清理 `permissions.py` 未执行常量。
   - 修复 `Makefile` 与 `scripts/upload_music.py` 的默认端口 `8000` → `18780`（提交 `Makefile` 时仅暂存本改动 hunk）；修正 `frontend/android/README.md` 过时版本号与矛盾签名说明（链接构建文件而非复制易变数值）；清理 `contracts/podcast-queue.md` 中过时的 `/inbox` 验收条目。

## 验收（按 `AGENTS.md` §3 定级）

- 批次 1 & 2（后端 + Android）：**L1/L2** — `make check`、受影响及新增后端 `pytest` 回归、`make android-ci`、`make codeql-local`（Python 零新增告警）。
- 批次 3（Web + Apple + 护栏）：**L1/L2** — `make check`、受影响 Web Playwright 回归（含离线、播客收件箱/资源、任务页与 i18n 检查），对改动涉及的 Web 页面按 L1 补看桌面与 390px 浅深主题截图；Apple 端因 Linux 无 Xcode，明确报告 `make macos-test` / `make ios-test` 验证缺口。

## 风险与回滚

- 修改前先用 `git grep` 反查受影响的后端、Web、Android、Apple 测试与契约断言，同步更新，避免残留旧断言。
- 三个批次拆为独立原子提交，任一批次出现回归可单独 `git revert` 而不影响其余批次或书架功能。
