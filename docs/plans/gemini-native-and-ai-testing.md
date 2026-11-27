状态：已实施

# Google Gemini 原生协议适配与本地 AI 自动测试

## 目标

1. 为野弦内置 AI 助手新增 Google Gemini 原生 REST 协议（`protocol = "gemini"`，支持 `generateContent`、`streamGenerateContent?alt=sse`、`x-goog-api-key` 请求头、`thoughtSignature` 多轮工具续接、`thinkingConfig` 推理强度映射以及原生 Google Search Grounding 来源归一），并加固现有 Gemini OpenAI 兼容层参数校验。
2. 升级并合入本地 AI 手测与在线能力探测工具（`make test-ai-local`、`make test-ai-live`、`scripts/ai_test.py`），支持 `.env.test.local` 配置协议、供应商、推理强度、原生搜索与独立 HTTP 代理，补齐全离线回环自动化测试。

## 不碰的边界

- 不升级 SQLite Schema：新协议与选项沿用现有 `agent_connections.options` JSON 列，保持旧连接与旧客户端兼容。
- 不引入 SOCKS 代理依赖：沿用统一出站代理层 `http://host:port`（HTTPS 请求走 `CONNECT` 隧道），所有 AI 请求（含流式与连接探测）统一走 `outbound.py` 代理与 SSRF 防护。
- 不把 API Key 拼入 URL Query：Gemini 原生接口严格使用 `x-goog-api-key` 请求头。
- 不修改 Apple 客户端 UI：iOS / macOS 直接消费后端模型连接列表，无连接编辑表单。
- 自动化测试严格离线，使用本机回环假模型与假代理服务，不调用真实外部账号。

## 方案

- **后端协议与流式**：
  - `agent_models.py`：`Connection.protocol` 增加 `"gemini"`。
  - `agent_ai.py`：校验 Gemini 模型路径安全字符与推理强度（拦截不支持的 `max`），对 `protocol == "gemini"` 开放 `native_search`、发送 `x-goog-api-key` 头，并统计 `usageMetadata` token。
  - `model_protocol.py`：实现 Gemini 原生请求构造（`systemInstruction`、`contents`、连续工具响应合并为单轮 `user`、`parametersJsonSchema`、`toolConfig`、`thinkingConfig`、`googleSearch`）与响应解析（过滤 `thought: true` 预览、保留 `_gemini_parts` 原始 `thoughtSignature`、解析 `groundingMetadata.groundingChunks` 为 `_sources`）。
  - `model_stream.py`：支持 `:streamGenerateContent?alt=sse` 增量文本预览、思考分片过滤、工具调用与 `groundingMetadata` / `usageMetadata` 聚合，以及断流不完整拦截。
- **Web 与 Android 表单**：
  - Web `agent-settings.tsx`（及中英文 i18n）与 Android `AgentWorkspace.kt`（及中英文 `strings.xml`）在协议下拉项中新增「Gemini 原生接口」，选择时联动 `provider="gemini"` 并显示 `native_search` 开关。
- **本地 AI 测试与文档**：
  - 升级 `scripts/ai_test.py`、`Makefile`、`docs/development.md` 与 `docs/architecture/assistant-research.md`，新增 `WILDSTRING_TEST_AI_PROVIDER`、`WILDSTRING_TEST_AI_REASONING_EFFORT`、`WILDSTRING_TEST_AI_NATIVE_SEARCH`、`WILDSTRING_TEST_AI_PROXY`，探测失败输出 `error_code`，移除 `assert` 消除 Bandit 低危告警。
  - 新增 `backend/tests/test_ai_test.py` 并扩展 `test_agent_research.py`、`test_model_stream.py`。

## 验收（L1）

- `make check` 通过；
- `pytest` 覆盖 `test_ai_test.py`、`test_agent_research.py`、`test_model_stream.py` 及相关代理/连接测试；
- Web 受影响 Playwright 用例（`agent-platform.spec.ts`、`assistant-research.spec.ts`）通过，并逐张检查桌面与 390px 手机浅深主题表单截图；
- `make android-ci` 通过；
- PR 云端全套 CI（Backend、Web E2E、Container、Android APK、macOS、iOS、CodeQL）全绿后 rebase 合入 `main`。
- 真实 Google Gemini API Key 连通性与账号额度验证留给用户本机执行 `make test-ai-live`，自动化测试不宣称已覆盖真实上游账号。

## 风险与回滚

- 不同代 Gemini 模型对 `googleSearch` 与自定义 `functionDeclarations` 共存或 `thinkingLevel` 的上游支持可能随版本变化：默认 `auto` 不发送 `thinkingConfig`、`native_search` 默认关闭，出问题可直接在连接配置中关闭或切回 `chat_completions`。
- 改动集中在协议适配层、本地测试脚本与表单下拉选项，无数据库迁移，回滚只需 revert 对应提交即可。
