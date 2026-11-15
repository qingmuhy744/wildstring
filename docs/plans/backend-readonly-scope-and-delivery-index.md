状态：已交付于 PR #139

# 后端只读连接去重与通知投递索引治理

## 目标

在不改动任何 HTTP 契约、数据结构与历史表数据保留策略的前提下，降低高频请求与 AI 巡检任务的 SQLite 只读连接/UDF 开销，补齐投递队列复合索引，并消除 Web 播客待播 E2E 的竞态条件：

1. 为只读系统配置/会话/库上下文/健康检查查询提供轻量 `Database.connect(scoped=False)`，跳过冗余库范围 SQL 查询与 UDF 注册；
2. 合并 `LibraryAccess` 在非大 JSON 请求体场景下的会话校验与库上下文解析为单次连接复用，同时维持大 JSON 请求“先验会话后读包体”的安全防线；
3. 将 `Automation.submit_task` 的曲目存在性与 `metadata_version` 校验由 `2 * N` 次往返与磁盘歌词探测改为单条 SQL 批量查询；
4. 为 `agent_deliveries(status, next_attempt_at)` 补齐幂等复合索引，加速待投递队列扫描；
5. 修复 `frontend/web/tests/podcast-player.spec.ts` 中点击“下一集播放”未等待队列 `PUT` 完成导致的 E2E 竞态。

## 不碰的边界

- 不修改任何 HTTP 路由 URL、入参校验、返回结构与状态码（严格零破坏性变更）；
- 不调整 `SCHEMA_VERSION = 52`；
- 不自动删除 `agent_events`、`agent_audit`、`agent_deliveries` 记录或 `data_dir/intake` 暂存文件；
- 不在本方案内处理封面 HTTP 缓存放开、`file-info` 路径脱敏及 `slow_download` 契约文档同步（留待后续独立 PR）。

## 方案

1. **轻量只读连接与防误用校验**（`database.py`、`site_access.py`、`server_settings.py`、`auth.py`）：
   - `Database.connect` 新增 `*, scoped: bool = True`；当 `not scoped and (write or create)` 时抛出 `ValueError`；`scoped=False` 跳过 4 个作用域 UDF 注册、`PRAGMA user_version` 读取与 `configure_scope`。
   - `SiteAccess.read`、`ServerSettings.read`、`Auth.configured`、`Auth.require_session` 与 `Database.check_ready` 改为使用 `scoped=False`（`ServerSettings.read` 与 `Auth.require_session` / `session_cookie` / `session_token` 支持传入可选 `connection` 复用同一只读连接）。
2. **`LibraryAccess` 单连接复用**（`library/access.py`）：
   - 从 `_resolve_context` 抽出 `_resolve_context_with_db`，并新增 `_authenticate_and_resolve` 在单次 `connect(scoped=False)` 内串起会话校验与库上下文解析（会话无效返回 `user=None`，交由下游路由处理，确保 `/api/v1/auth/status` 等公开/状态路由不受影响）。
   - 对无需缓冲 JSON 请求体的请求（`GET`/`HEAD`/`DELETE`、豁免前缀及非 JSON 请求）走单连接路径；对非豁免 JSON `POST`/`PUT`/`PATCH` 保持先验会话再读取最多 2 MB 请求体的顺序。
3. **`Automation.submit_task` 批量查询**（`agent_automation.py`）：
   - 对待巡检曲目列表改用单连接 `json_each(?)` 批量 JOIN `tracks` 与 `track_metadata`，校验可见性与唯一数量，直接取回 `metadata_version`，不再逐首调用 `get_track` / 触发 `TrackAssets.lyrics` 磁盘读取。
4. **`agent_deliveries_due` 复合索引**（`agent_schema.py`、`database.py`）：
   - 在 `agent_schema.py` 的建表脚本与 `Database.initialize` 末尾幂等执行 `CREATE INDEX IF NOT EXISTS agent_deliveries_due ON agent_deliveries(status, next_attempt_at)`，使 `Notifications.deliver_one()` 的到期及租约回收查询走索引。
5. **Web E2E 待播请求等待**（`frontend/web/tests/podcast-player.spec.ts`）：
   - 点击“下一集播放”前注册对 `PUT /api/v1/podcasts/queue` 的 `waitForResponse` 并校验 `ok()`，避免与后续“加入待播”响应监听产生竞态。

## 验收（按 AGENTS.md §3 定级）

本改动仅涉及后端内部连接复用、SQL 批量化、索引补充及单条 E2E 测试等待稳定化，不改动前端样式与组件，按 **L0** 加上对应后端与 E2E 回归验证：

- 补齐/更新单元与集成测试（`test_library.py`、`test_site_access.py`、`test_agent_platform.py`），覆盖 `scoped=False` 参数校验、单连接认证/库上下文复用、失效会话放行与未登录超大包拦截、`submit_task` 常数连接/零歌词磁盘读、以及 `EXPLAIN QUERY PLAN` 命中 `agent_deliveries_due`；
- 运行定向 `pytest`、`make check` 与 `make test-affected-desktop`；
- 运行 `podcast-player.spec.ts`（或核对 Playwright 环境可用性并写明验证范围）；
- 推送后确认 GitHub Actions 全量 CI 状态。

## 风险与回滚

- 风险：`scoped=False` 误用于依赖 `active_user()` / `library_visible()` 的查询会导致 SQLite 报错；已在 `connect()` 禁止与 `write`/`create` 同用，且所有 `scoped=False` 调用点经人工逐行核对并通过完整认证/多库回归测试验证。
- 风险：`Automation.submit_task` 多库可见性校验边界与 `get_track` 差异；经查 `MetadataEditor.read` 与 `repository.track` 均限定当前可见库，批量 SQL 同步校验 `t.library_id = ? AND library_visible(t.library_id)` 并对齐 `422 inspection_limit` / `404 track_not_found`。
- 回滚：各子项改动均保持向外兼容且未变更 `SCHEMA_VERSION`，可直接按文件/提交回滚；`agent_deliveries_due` 索引纯属查询加速，无需破坏性降级。
