状态：已实施

# MCP OAuth 2.1（与静态 PAT 双轨并存）

## 目标

在完全保留现有手动签发 `ws_...` 静态个人访问令牌（PAT）与局域网／无公网域名接入能力的前提下，为野弦 Streamable HTTP `/mcp` 叠加标准 **OAuth 2.1** 发卡与发现层，使 Google Gemini 自定义 MCP 连接器、Claude Web、ChatGPT Web 及支持 OAuth 的 MCP 客户端可以通过浏览器授权码 + PKCE（`S256`）直接接入，并支持 Refresh Token 自动续期与站内一键撤销。

## 不碰的边界

- 不移除、不弱化现有 `/api/v1/agent/credentials` 手动 PAT 签发／撤销、`McpOnboarding` 本地工具模板（Codex / Cursor / Antigravity / OpenCode / 通用）及 stdio `mcp_bridge.py`。
- 不引入第三方身份提供方或外部依赖；不放宽现有会话 Cookie 的 `SameSite=Strict` 策略。
- 不新增任意 URL／SQL／Shell 工具，不改变 `agent_platform` 现有的 10 个业务 scope、管理员门禁、草案审批隔离与多库可见性校验。
- 不修改工作区既有的 4 项用户本地未提交内容（`Makefile` AI 测试区块、`docs/development.md`、`docs/plans/local-ai-testing.md`、`scripts/ai_test.py`）。

## 方案

1. **数据库迁移（`SCHEMA_VERSION = 63`）**
   - 新增 `backend/src/wildstring/oauth_schema.py`，建表 `oauth_clients`、`oauth_codes`、`oauth_grants`、`oauth_refresh_tokens`，并在 `agent_credentials` 增加可空列 `oauth_grant_id`。
   - OAuth 签发的短期 `ws_...` 访问令牌写入同一张 `agent_credentials` 表，直接复用 `Core.actor()` 与 `mcp_http.py` 校验链路；手动 PAT 列表通过 `oauth_grant_id IS NULL` 保持整洁，不被短期轮换记录刷屏。
2. **标准发现与 OAuth 2.1 端点（`backend/src/wildstring/mcp_oauth.py`）**
   - `GET /.well-known/oauth-protected-resource` 与 `GET /.well-known/oauth-protected-resource/mcp`（RFC 9728），并在 `/mcp` 401 响应返回 `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`。
   - `GET /.well-known/oauth-authorization-server`（RFC 8414），声明 `S256` PKCE、授权码与刷新令牌授权类型、动态注册及吊销端点、全部业务 scope。
   - `POST /oauth/register`（RFC 7591）：按客户端 IP 限流并清理超期未授权动态注册，校验 1–16 条精确回调地址（`https://` 或 RFC 8252 回环 `http://127.0.0.1|localhost|[::1]`，拒绝 fragment／userinfo）。
   - `POST /oauth/token`：支持 `authorization_code`（强制 PKCE `S256`、60 秒单次授权码、重放检测吊销整条授权、RFC 8707 `resource` 校验）与 `refresh_token`（30 天滚动刷新令牌轮换、重放检测吊销整条授权、只允许缩小 scope、实时重检账号启用状态与角色上限）。
   - `POST /oauth/revoke`（RFC 7009）：支持按客户端鉴权吊销访问令牌或刷新令牌（吊销刷新令牌同步废止整条授权与当前访问凭据）。
   - 安全中间件联动：`HostAllowlist` 为 `/oauth/*` 补充 `Cache-Control: no-store`；`ConnectionSecurity` 在 `https_only` 策略下同样拦截明文 HTTP `/oauth/*`；`CallbackPrivacy` 与访问日志脱敏覆盖 `/oauth/authorize`；`LibraryAccess` 将 `oauth` 加入免库前缀。
3. **Web 授权确认页与个人设置统一视图**
   - `GET /oauth/authorize` 返回 SPA `index.html`，浏览器同源发起 `/api/v1/auth/status` 与 `POST /api/v1/oauth/authorize/context`（均带 `X-Wildstring-Client`），天然兼容 `SameSite=Strict` 会话 Cookie；未登录时直接复用站内登录页，登录后原地进入授权确认卡，展示应用名、注册来源、精确回调域名、当前账号及可收窄的权限勾选，操作后由 `POST /api/v1/oauth/authorize/decision` 返回目标回调 URL。
   - 个人设置「MCP 与外部工具」在保留手动 PAT 的同时，并排展示已授权的 OAuth 连接（标注来源、权限与最近刷新时间，一键撤销同时作废访问与刷新令牌），并提供折叠式「手动注册静态 OAuth 客户端」入口以适配需要手填 `Client ID / Client Secret` 的连接器。
4. **契约与测试**
   - 同步更新 `contracts/agent-platform.md` 与 `backend/tests/test_auth.py` 的 `SCHEMA_VERSION` 断言。
   - 新增后端单元与集成测试 `backend/tests/test_mcp_oauth.py`（覆盖发现端点、DCR 与限流、静态客户端、授权码+PKCE、授权码重放吊销、Refresh 轮换与重放吊销、角色降权与禁用账号、RFC 8707 `resource`、RFC 7009 吊销、真实 `/mcp` 工具调用、v62→v63 迁移）。
   - 新增 Web Playwright E2E 与桌面/390px 手机浅深主题视觉截图验证（授权确认页与个人设置 OAuth 连接管理）。

## 验收（按 AGENTS.md §3 定级）

- **级别：L2**（新增 OAuth 2.1 认证协议层、数据库 schema 63、共享 `mcp_http.py` 401 响应头、`/oauth/authorize` 页面与个人设置组件）。
- **必做检查**：
  - `make check`（Ruff、Bandit、Prettier、Web typecheck、i18n 键值与源码引用、文档链接、旧测试断言）。
  - 后端 pytest：`test_mcp_oauth.py`、`test_mcp_http.py`、`test_auth.py`、`test_agent_platform.py`、`test_server_settings.py`、`test_openapi_operation_ids.py`、`test_combined_feature_migrations.py`。
  - Web Playwright 回归（桌面 + 390px 手机）：新增 OAuth 授权与管理用例 + 既有 `agent-platform.spec.ts` / `personal-settings.spec.ts`，逐张查看桌面与 390px 手机浅深主题截图（含正常、空态、错误态）。
  - 本地 CodeQL 扫描确认零新增安全告警。

## 风险与回滚

- **回滚约束**：`database.py` 拒绝由旧版本代码打开高于其 `SCHEMA_VERSION`（63）的数据库；部署升级前应按 `docs/development.md` 备份 SQLite 数据库。
- **已有测试排查**：`git grep` 排查了所有 `SCHEMA_VERSION`、`== 62`、`WWW-Authenticate`、`agent_credential_required` 断言；仅 `backend/tests/test_auth.py:63` 硬编码了 `62`，需改为 `SCHEMA_VERSION`；`mcp_http.py` 401 的 `WWW-Authenticate` 保留 `Bearer` 前缀并附带 `resource_metadata="..."`，与既有测试完全兼容。
