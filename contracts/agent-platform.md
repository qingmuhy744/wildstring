# Agent 平台 API（0.4.0）

基础路径 `/api/v1/agent`；普通客户端使用现有 Cookie 和 `X-Wildstring-Client`；工具可使用独立 `Authorization: Bearer ws_…`。除 `/tools/*`、`/capabilities` 外的修改均需站内 Cookie 会话；工具凭据不能批准草案或读取/更改连接秘密。错误沿用 `{"detail":"stable_error_code"}`，trace 由公共 middleware 提供。所有列表 `{items,total,limit,offset}`，默认 50、上限 100。时间 UTC ISO，版本是整数。

## 权限及工具

`GET /capabilities` 返回 `{version:1,scopes:[…],tools:[{name,description,scope,input_schema,read_only}]}`。scope：`library:read, personal:read, drafts:write, drafts:apply, tasks:write, diagnostics:read, notifications:read`。

`GET /credentials`；`POST /credentials {name,scopes,expires_in_days:30}` 返回 `{id,name,scopes,created_at,expires_at,revoked_at,token}`，token 只在创建响应出现。`DELETE /credentials/{id}` 立即撤销。

`POST /tools/{name}` 直接传工具 arguments。工具包括 `search_tracks {q,limit,offset}`, `search_albums {q,limit,offset}`, `search_artists {q,limit,offset}`, `get_track {track_id}`, `get_metadata_suggestions {track_id}`（管理员读取已有来源证据）, `request_metadata_refresh {track_ids,force?}`（管理员提交既有来源查询队列，不应用结果）, `get_personal_library {kind:playlists|favorites|history,limit,offset}`, `inspect_library {track_ids?,limit}`, `create_draft {kind,title,payload,evidence?}`, `get_draft {draft_id}`, `apply_draft {draft_id,version,idempotency_key}`, `submit_inspection {track_ids?,max_tracks?,max_calls?}`, `get_task {task_id}`, `cancel_task {task_id}`, `list_notifications {limit,offset}`。不存在任意 URL/SQL/Shell 工具。诊断工具由诊断服务另接。

## 草案

`GET /drafts?status=&limit=&offset=`；`POST /drafts {kind:playlist|metadata,title,payload,evidence:[]}`；`GET /drafts/{id}`。草案字段：`id,kind,title,payload,evidence,status:pending|approved|applied|rejected,version,approved_version,created_at,updated_at,result,trace_id`。

歌单 payload `{name,track_ids:[真实ID],playlist_id?:已有本人手工歌单ID,playlist_version?:版本}`；元数据 payload `{track_id,metadata_version,overrides:{字段:值}}`，仅管理员可创建和应用共享元数据草案。证据为 `{source,summary,url?}`，最多 20 项。元数据更新合并既有人工覆盖，不清空无关修改。

`PATCH /drafts/{id} {version,title?,payload?,evidence?}` 修改后回到 pending 并清除批准；已应用不可修改。`POST /drafts/{id}/approve {version}` 只能从站内 Cookie 批准当前具体版本；`POST /drafts/{id}/reject {version}`；`POST /drafts/{id}/apply {version,idempotency_key}` 返回草案（result 包含 playlist_id 或 track_id）。重复同幂等键返回原结果；其他对象版本过期 409。应用、审计、事件、站内通知一个事务。

## 通知

`GET /notifications?limit=&offset=&cursor=` 返回 `{items,total,limit,offset,next_cursor,unread_count,high_watermark}`。`cursor` 是上次响应的 next_cursor；全量首次不传，增量按收件箱变更序列递增返回，包含跨设备已读变化。游标过期 410 `notification_cursor_expired`，应全量重拉。item：`id,event_id,event_type,title,summary,severity:info|warning|error,task_id,draft_id,trace_id,created_at,read_at,version,detail_route`。

读取列表不标已读。`POST /notifications/read {ids:[…]}` 只处理本人消息；`POST /notifications/read-all {high_watermark}` 仅已拉取快照内消息。`GET /notification-preferences` 和 `PUT /notification-preferences {telegram_enabled:false,event_types:[],min_severity:info,quiet_start:null,quiet_end:null,timezone:Asia/Shanghai}`。站内不关闭。`GET /deliveries`；`POST /deliveries/{id}/retry {acknowledge_unknown:true?}`，unknown 必须明确确认。投递字段 `id,event_id,target_id,status,attempt,next_attempt_at,error_code,message_id,trace_id`。

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

聊天使用最近 19 条历史消息及本次提问，系统指令独立保留；单轮工具结果只参与该轮模型循环。保留天数控制数据库清理，不代表全部历史都会送给模型。目前尚无自动摘要或跨对话长期记忆。0.4.1 在 max_calls 内预留最后一次调用直接生成回答（tool_choice=none），不追加付费调用；提供方忽略该要求时不再执行工具。聊天没有实时网页或库外新发行搜索工具，发现页的 Last.fm 收藏建议也不保证最新发行。

## 安全和运行边界

共享曲库只有一份，个人对象全部用户隔离；角色和 enabled 在每个调用及后台批次重新检查。外部输出仅业务投影，无绝对路径、密钥、歌词或音频。模型/Telegram 明确启用后才调用。Telegram 已确认 sent 不重发；响应丢失记 unknown，不自动重试。真实服务验证与合成自动化结果分别记录。

## 0.5.0 助手扩展

模型连接增加可选 `protocol`、`provider`、`reasoning_effort`、`max_output_tokens`、`native_search`；未提交选项时保留原值。`GET/PUT /search-settings` 管理本人的独立检索连接，`POST /search-settings/test` 消耗一次检索请求（缓存命中除外）。密钥只接受写入，不回传。

`GET/POST /memories` 与 `PATCH/DELETE /memories/{id}` 为本人显式记忆管理，修改使用版本校验；不开放为模型或 MCP 写工具。`assistant-preferences` 增加 `context_summary` 与 `long_term_memory`，旧客户端只提交保留天数不会重置开关。

对话返回可选 `context_summary`，消息返回 `sources`；`DELETE /conversations/{id}/summary` 清除摘要，生成中拒绝操作。来源 URL 保留必要查询参数。来源数组表示检索取得的资料，不代表每条资料都支持全部回答。

详细执行和验证边界见[助手联网与记忆](../docs/architecture/assistant-research.md)。
