# Agent 平台与 MCP API

基础路径 `/api/v1/agent`（同时提供 stdio `python -m wildstring.mcp_bridge` 与 Streamable HTTP `/mcp` 端点）；普通客户端使用现有 Cookie 和 `X-Wildstring-Client`；外部工具可使用独立 `Authorization: Bearer ws_…`。除 `/tools/*`、`/capabilities` 外的修改均需站内 Cookie 会话；工具凭据不能直接修改自动整理策略或读取/更改连接密钥。错误沿用 `{"detail":"stable_error_code"}`，trace 由公共 middleware 提供。所有列表 `{items,total,limit,offset}`，默认 50、上限 100。时间 UTC ISO，版本是整数。

## 权限及工具

`GET /capabilities` 返回 `{version:1,scopes:[…],tools:[{name,description,scope,input_schema,read_only}]}`（MCP `tools/list` 同时返回 `annotations: {readOnlyHint, destructiveHint, idempotentHint, openWorldHint}`）。

全量 scope：`library:read, personal:read, drafts:write, drafts:apply, tasks:write, diagnostics:read, notifications:read, library:manage, personal:write, web:search`。所有库级工具 Schema 接受可选 `library_id` 作为目标；账号有多个可访问库且工具无法从对象推断目标时，库级工具必须显式传入该字段，否则返回 422 `library_selection_required`；个人数据仍按当前账号隔离。

`GET /credentials`；`POST /credentials {name,scopes,expires_in_days:30}` 返回 `{id,name,scopes,created_at,expires_at,revoked_at,token}`，token 只在创建响应出现（有效期 1–365 天）。`DELETE /credentials/{id}` 立即撤销。

`POST /tools/{name}` 直接传工具 arguments。受控工具按领域分为：
- **曲库与专辑检索（`library:read`）**：`search_tracks`, `search_albums`, `search_artists`, `get_track`, `get_album_tracks`, `get_inspection_rules`, `inspect_library`, `get_lyrics_quality`, `get_loudness`
- **个人曲库与响度偏好（`personal:read` / `personal:write`）**：`get_personal_library {kind:playlists|favorites|history}`, `get_gain_settings`, `set_gain_settings`, `adjust_gain`
- **整理草案与策略（`drafts:write` / `drafts:apply`）**：`get_application_policy`, `create_draft`, `get_draft`, `list_drafts`, `apply_draft`
- **曲库管理、导入、封面与歌词候选（`library:manage`，仅所有者/管理员）**：`get_metadata_suggestions`, `request_metadata_refresh`, `get_album_release_lock`, `set_album_release_lock`, `clear_album_release_lock`, `get_cover_candidates`, `get_cover_preview`, `get_import_settings`, `set_import_settings`, `discover_imports`, `list_intake_items`, `get_intake_item`, `submit_library_task`, `list_library_tasks`, `get_library_task`, `get_lyric_candidates`, `request_lyrics_lookup`, `get_lyric_scan_settings`, `set_lyric_scan_settings`, `submit_lyric_scan`, `list_lyric_scans`, `get_lyric_scan`, `control_lyric_scan`, `request_loudness_analysis`
- **巡检任务与站内通知（`tasks:write` / `notifications:read`）**：`submit_inspection`, `get_task`, `list_tasks`, `cancel_task`, `resume_task`, `list_notifications`
- **受控联网检索（`web:search`）**：`get_search_settings`, `search_web`, `read_webpage`（仅读取最近 24 小时检索返回的 `source_id`，不接受任意 URL）
- **系统诊断（`diagnostics:read`，管理员专属）**：`get_system_status`, `search_log_events`, `get_operation_trace`, `get_task_diagnostics`, `test_external_services`

不存在任意 URL/SQL/Shell 工具。

## 草案

`GET /drafts?status=&limit=&offset=`；`POST /drafts {kind,title,payload,evidence:[]}`；`GET /drafts/{id}`。支持 6 种草案类型（`kind`）：
- `playlist`：歌单创建或追加（`{name,track_ids:[真实ID],playlist_id?,playlist_version?}`）
- `metadata`：单曲元数据覆盖（`{track_id,metadata_version,overrides}`）
- `metadata_batch`：专辑/多曲原子批量元数据修改
- `cover`：固定封面候选快照草案
- `intake`：待整理导入项修复草案（`{item_id,version,overrides}`）
- `lyrics`：歌词候选选用草案（`{candidate_id,...}`）

草案字段：`id,kind,title,payload,evidence,status:pending|approved|applied|rejected,version,approved_version,created_at,updated_at,result,trace_id`。`result` 为对象或 null；客户端必须接受显式 null。列表待处理（pending/approved）优先，其余按 updated_at 倒序；按 status 过滤时也按最近处理时间排列。Android 默认待处理视图，已应用/已拒绝自动进入处理记录；Web 既有已应用/已拒绝视图保留。共享曲库修改（元数据、封面、歌词、导入项）仅管理员可创建和应用。证据为 `{source,summary,url?}`，最多 20 项。元数据更新合并既有人工覆盖，不清空无关修改。

`PATCH /drafts/{id} {version,title?,payload?,evidence?}` 修改后回到 pending 并清除批准；已应用不可修改。`POST /drafts/{id}/approve {version}` 只能从站内 Cookie 批准当前具体版本；`POST /drafts/{id}/reject {version}`；`POST /drafts/{id}/apply {version,idempotency_key}` 返回草案（result 包含 playlist_id 或 track_id）。重复同幂等键返回原结果；其他对象版本过期 409。应用、审计、事件、站内通知一个事务。

## 通知

`GET /notifications?limit=&offset=&cursor=` 返回 `{items,total,limit,offset,next_cursor,unread_count,high_watermark}`。`cursor` 是上次响应的 next_cursor；全量首次不传，增量按收件箱变更序列递增返回，包含跨设备已读变化。游标过期 410 `notification_cursor_expired`，应全量重拉。item：`id,event_id,event_type,title,summary,severity:info|warning|error,task_id,draft_id,trace_id,created_at,read_at,version,detail_route`。

Web／Android 默认仅显示未读通知，已读通知保留在「已读记录」，不删除事件或草案依据。读取列表不标已读。`POST /notifications/read {ids:[…]}` 只处理本人消息；`POST /notifications/read-all {high_watermark}` 仅已拉取快照内消息。`GET /notification-preferences` 和 `PUT /notification-preferences {telegram_enabled:false,event_types:[],min_severity:info,quiet_start:null,quiet_end:null,timezone:Asia/Shanghai}`。站内不关闭。`GET /deliveries`；`POST /deliveries/{id}/retry {acknowledge_unknown:true?}`，unknown 必须明确确认。投递字段 `id,event_id,target_id,status,attempt,next_attempt_at,error_code,message_id,trace_id`。

## Telegram

`GET /telegram-targets`；`POST /telegram-targets {name,bot_token,chat_id,topic_id?,proxy_mode:inherit|direct,enabled:false}`。返回不含 token/chat_id 的目标摘要 `{id,name,has_token,verified,enabled,version,created_at}`。`POST /telegram-targets/{id}/verify-send {}` 显式发送短效验证码（不返回验证码）；`POST /telegram-targets/{id}/verify {code}` 回填验证并启用；`POST /telegram-targets/{id}/test {}` 仅已验证目标显式测试；`PATCH /telegram-targets/{id} {enabled,version}`；`DELETE /telegram-targets/{id}` 撤销且取消未发投递。只实现出站通知，不接受 Telegram 批准。

## 巡检与计划

`GET /tasks`；`POST /tasks {track_ids:[]?,max_tracks:500,max_calls:0,connection_id?:null,use_ai:false}`，默认规则巡检，不调用模型、不自动应用。`GET /tasks/{id}` 返回 `id,status,stage,checkpoint,counts,parameters,error_code,created_at,updated_at,trace_id,version,results:[]`。结果 `{track_id,title,issues:[missing_album|missing_cover|missing_lyrics|…],metadata_version}`，不泄漏路径。`POST /tasks/{id}/cancel {}` 协作取消；`POST /tasks/{id}/resume {}` 恢复暂停/中断/失败，保留 checkpoint。状态 `queued,running,retry_wait,paused_authorization,paused_budget,cancel_requested,cancelled,succeeded,partial,failed,interrupted`。

`GET /schedules`；`POST /schedules {name,enabled:false,interval_hours:24,timezone:Asia/Shanghai,parameters:{…任务参数}}`；`PATCH /schedules/{id}` 同字段加 version；`DELETE /schedules/{id}`。interval 1–720 小时，错过多周期只补一次，任务去重；timezone 校验 IANA，next_run_at 为 UTC。计划默认关闭，AI 后台需连接明确授权。

已登录的 UI 通过 `POST /tasks` 显式选择 `use_ai=true`、连接及调用上限，授予本次任务使用该连接的权限，无需 `background_allowed`，可以选择只读的 `legacy` 实例连接。仅该入口在服务端持久记录单次授权，不增加客户端可写字段，也不开放配置编辑权限。定时计划及 `submit_inspection` 工具仍要求 `background_allowed=true`；恢复任务不提升原来的授权。所有模型请求继续检查连接版本、当前用户权限、每日额度及任务调用上限。旧任务没有单次授权记录时保留原限制。

## 连接与助手

`GET /endpoint-policy` 管理员读取；`PUT /endpoint-policy {allowed_hosts:[域名/IP],allow_private:false}` 管理员设置个人连接允许的精确端点；私网需显式 allow_private 和主机允许。管理员自己的连接可以配置局域网。`GET /connections` 包含本人连接、显式共享实例连接和现有 legacy 连接（id=`legacy`，read_only=true）。`POST /connections {name,scope:personal|instance,base_url,model,api_key?,timeout:30,shared:false,background_allowed:false,daily_call_budget:100,enabled:true}`；`PATCH /connections/{id}` 同字段加 version；`DELETE /connections/{id}`；`POST /connections/{id}/test {}` 返回文本/工具能力及检测时间。仅管理员可创建 instance/shared。字段 `id,name,scope,base_url,model,timeout,shared,background_allowed,daily_call_budget,enabled,has_api_key,version,capabilities,created_at`。不返回密钥。

`GET /conversations`；`POST /conversations {title?:"新对话",connection_id?:null}`（空或 `local` 为本地检索；不自动选择付费连接）；`GET /conversations/{id}` 包含 messages；`DELETE /conversations/{id}`；`POST /conversations/{id}/messages {content,connection_id?:null,max_calls:4}` 同步有界多轮（客户端先显示发送状态，断连后 GET 恢复）；省略 connection_id 才沿用会话连接，显式 null 或 `local` 切换为本地模式，绝不自动更换付费路径。响应完整 conversation，messages 含 `{id,role:user|assistant,content,created_at,run_id}`，runs 含 `{id,status,connection_id,error_code,tool_calls,draft_ids,trace_id}`。运行固定连接版本，最多 8 次模型调用，每次最多 8 个工具调用；只能调用读工具和创建草案，不能批准或应用。显式选择本地模式时标记 local_fallback；模型请求失败标记 failed，不自动更换连接，本地找歌仍可单独使用。`DELETE /conversations` 清除本人历史。`GET/PUT /assistant-preferences {retention_days:30}`，保留范围 1–365 天。

`PATCH /conversations/{id} {title}` 修改本人对话名称，首尾空白会去除，长度 1–200；消息、所选连接和草案不变。对话列表提供改名和逐条删除，删除前需用户确认。删除正在生成回复的对话返回 `409 conversation_busy`；删除会清理该对话消息和运行记录，已有草案和业务对象独立保留。

聊天使用最近 19 条历史消息及本次提问，系统指令独立保留；单轮工具结果只参与该轮模型循环。保留天数控制数据库清理，不代表全部历史都会送给模型。在 `max_calls` 内预留最后一次调用直接生成回答（`tool_choice=none`），不追加付费调用；提供方忽略该要求时不再执行工具。对话上下文摘要、本人显式长期记忆及受控联网检索配置见下方 `0.5.0 助手扩展`。

## 安全和运行边界

共享曲库只有一份，个人对象全部用户隔离；角色和 enabled 在每个调用及后台批次重新检查。外部输出仅业务投影，无绝对路径、密钥、歌词或音频。模型/Telegram 明确启用后才调用。Telegram 已确认 sent 不重发；响应丢失记 unknown，不自动重试。真实服务验证与合成自动化结果分别记录。

## 0.5.0 助手扩展

模型连接增加可选 `protocol`、`provider`、`reasoning_effort`、`max_output_tokens`、`native_search`；未提交选项时保留原值。`GET/PUT /search-settings` 管理本人的独立检索连接，`POST /search-settings/test` 消耗一次检索请求（缓存命中除外）。密钥只接受写入，不回传。

`GET/POST /memories` 与 `PATCH/DELETE /memories/{id}` 为本人显式记忆管理，修改使用版本校验；不开放为模型或 MCP 写工具。`assistant-preferences` 增加 `context_summary` 与 `long_term_memory`，旧客户端只提交保留天数不会重置开关。

对话返回可选 `context_summary`，消息返回 `sources`；`DELETE /conversations/{id}/summary` 清除摘要，生成中拒绝操作。来源 URL 保留必要查询参数。来源数组表示检索取得的资料，不代表每条资料都支持全部回答。

详细执行和验证边界见[助手联网与记忆](../docs/architecture/assistant-research.md)。


## 用户选择应用方式（当前开发分支）

详见 [整理方式与接口](../docs/product/agent-application-policy.md)。新增仅会话可写的 `application-policy` 和原子 `drafts/{id}/accept`；MCP 只能读取应用策略。默认仍需审核；明确开启自动整理且拥有应用 scope 时，授权类型的 `create_draft` 可能返回 `applied`。调用方必须按真实状态反馈。旧版 approve/apply 接口保留兼容。

## 专辑批量核对

管理员会话可读取 `GET /metadata-review/albums` 与 `GET /metadata-review?album_id=...`（或 `track_id`），查看当前、文件原始值、人工覆盖及待核对来源。每个候选带 `candidate_digest`；`POST /metadata-review/accept` 提交 `items[{track_id,suggestion_id,metadata_version,candidate_digest,fields}]`、`idempotency_key` 和可选 `cover_draft_id`，返回 applied 草案或 conflict 列表。最多 500 首，批次所有写入同一事务，重试同键同内容只执行一次。

`POST /metadata-review/cover` 只准备 cover 草案与快照，不受账号自动应用设置影响；可带同专辑 `targets[{track_id,metadata_version}]`。固定封面与文字一起接受时，子草案也原子标记已应用，每曲元数据版本只增加一次。客户端不能提交伪造的 `cover_snapshot`。这些审核路由仅限登录会话；MCP 继续使用现有草案工具。

## Web MCP 接入引导（2026-11-05）

个人设置的 MCP 与外部工具沿用现有按账号、scope、期限签发和撤销凭据接口。
新增 Codex、Cursor、Antigravity、OpenCode 和通用提示词的本地模板生成。
用户填写连接名称和外部客户端能访问的单个 `/mcp` 完整地址；支持部署子路径，
拒绝 URL 用户信息、query、fragment，HTTP 必须明确允许。
复制提示词和配置不含本次生成的令牌；令牌仍只在签发时显示一次、单独复制。
Codex 使用 bearer_token_env_var，Cursor 使用 headers 环境变量插值，OpenCode 使用
remote + headers + oauth=false，Antigravity 使用 serverUrl + headers 占位符，不能臆造环境语法。

提示词要求保留现有配置、核对同名冲突、通过用户安全输入设置凭据、初始化 MCP、
列工具并执行只读查询。禁止仅因写出配置就宣称接入成功。浏览器不自动修改外部客户端文件。
不把原生多线路 Fallback 套用到外部客户端。网页引导不向指定地址发送令牌或测试请求。

文档核对来源：
- https://developers.openai.com/codex/mcp
- https://cursor.com/docs/context/mcp
- https://antigravity.google/docs/mcp
- https://opencode.ai/docs/mcp-servers/
