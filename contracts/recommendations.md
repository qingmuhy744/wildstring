# 推荐、排行与库外收藏建议（0.4.0 / schema 18）

所有端点在 `/api/v1`，要求当前用户登录；写请求继续要求 `X-Wildstring-Client`。响应 `private, no-store`，设置、反馈、批次缓存按用户和曲库隔离。模型与助手使用 `/agent/connections` 的相同连接权限、版本校验和原子每日总调用额度；不会默选第一个付费连接。token 用量仅展示本人，连接使用总量仅返回汇总。

## 偏好与一次性生成

`GET/PUT /recommendations/preferences`：PUT 使用当前 `version` 乐观锁，只覆盖提交的字段；保存不调用外部来源或模型。

| 字段 | 默认 / 约束 |
| --- | --- |
| `connection_id` | `local`；或本人/管理员共享实例连接 ID、只读兼容 `legacy` |
| `count` | 20，1–50 |
| `sources` | `personal,community,discovery,revisit`；可加 `lastfm_similar,lastfm_charts,lastfm_tags` |
| `lastfm_tags` | 最多 3 个、每个 1–50 字符 |
| `external_enabled` | false，显式启用库外建议的惰性刷新 |
| `external_refresh_days` | 7；0（手动）、1、3、7、14、30 |
| `external_sources` | `lastfm_charts,lastfm_tags,lastfm_artists`；可选 `lastfm_similar` |
| `external_use_ai` | false；开启并选择非 local 连接后，外部批次生成才能调用模型 |
| `external_call_limit` | 6，1–8 次来源网络请求/批，缓存命中不占次数 |

兼容字段 `use_ai/use_lastfm` 保留：旧库中此前明确 `use_ai=true` 的偏好迁移成 `legacy`；新账户默认 local。旧客户端单独保存 `use_ai` 切换 legacy/local，单独保存 `use_lastfm` 切换 similar；新客户端以 `connection_id/sources` 为准。`null` 连接明确表示 local。

`POST /ai/discover`：`{prompt,limit?,connection_id?,sources?}`。`GET /recommendations/daily` 使用保存偏好和今日缓存；`POST /recommendations/daily/refresh` 可无 body，或 `{connection_id?,sources?}` 临时覆盖，数量仍来自保存偏好。一次性参数不修改偏好。未显式传 connection_id 时，已保存连接后续被删除、禁用、撤销共享或端点权限取消，返回 local 结果及 `warnings:[{source:"ai",code:"saved_ai_connection_unavailable"}]`、degraded=true；保留偏好原 ID 供用户修复。显式请求无权/失效连接仍返回 403/404，不更换其他付费连接。此警告同样合并到今日缓存与外部关闭/缓存/刷新响应。

每日推荐保留 `id,date,engine,items`，发现保留 `title,mode,items`。两者新增 `connection_id,source_status,warnings,degraded`；item 是 `{track,reason,source_ids,signals:[{source,reason}]}`。每日批次有 `generated_at`。`warnings` 是 `{source,code}`，来源/模型失败返回本地结果和真实降级信息。

`source_status`：`{id,status,matched,candidate_count?,unmatched?,cached?,error_code?}`。状态是 `ok|disabled|empty|unavailable`。本库来源有本地命中才 ok；库外来源有真实外部候选即 ok，未匹配本库不等于来源失败。`community` 只指本实例用户汇总，不是 Last.fm 全球用户。

## 排行榜

`GET /recommendations/rankings?scope=personal|community&period=7d|30d|90d|all&metric=plays|listened_ms&limit=20&offset=0`，limit 最大 100。

响应 `{items:[{rank,track,play_count,listened_ms,reason}],total,limit,offset,scope,period,metric,generated_at,evidence}`。近期使用服务端收听 session 的开始时间窗口和实际 counted/reported_ms；all 才使用累计聚合值。只返回曲目与汇总，不返回其他账号 ID、用户名或个人播放明细。

## 库外建议

- `GET /recommendations/external`：未启用返回 disabled；手动模式无批次时返回 manual；启用后仅本页首次/过期才惰性刷新。切歌、基础播放、本库曲目 GET 不查询此来源。
- `POST /recommendations/external/refresh`：`{}` 或 `{connection_id}`，使用保存的外部来源/AI开关；关闭 external_enabled 时返回 409。
- `POST /recommendations/external/feedback`：`{external_id,action:want|dismiss|clear}`，返回 `{ok:true}`。只操作本账号当前批或已保存的历史条目，未知 ID 404。

响应 `{id,items,wanted_items,generated_at,next_refresh_at,status,cached,stale,warnings,degraded,source_status,connection_id,scope}`。status 是 `disabled|manual|ready|empty|unavailable`；scope 固定 `new_to_library_not_new_release`，表示发现尚未收藏的音乐，不声称是新发行。

条目 `{external_id,name,artists,album,source_url,reason,evidence:[{source,summary,url}],local_track,wanted}`。external_id 为 `lastfm:` 加艺人/标题归一化摘要；无专辑资料时 album=null。source_url 仅 Last.fm 事实页，无下载链接；没有虚构可播放 track_id。local_track 为零或一首真实本库歌曲，按标题和艺人精确归一化匹配，多个版本歧义时保留 null。导入后读取缓存会重新本地匹配，不触发逐首联网。

want 保存当时安全元数据，换批后仍出现在 items 和独立 wanted_items；dismiss 跨批在模型筛选前生效。want 清单不执行下载、导入或文件操作。

官方来源：chart.getTopTracks（公共热门榜）、tag.getTopTracks（按标签计数排序，不能声称近期播放榜）、track.getSimilar（关系）、artist.getSimilar/artist.getTopTracks（关联艺人与热门歌曲）。均使用服务器 Last.fm 应用 API key，不表示已经读取用户授权的 Last.fm 个人历史。来源候选先轮转再限量，模型只能返回已提供的 external_id，事实字段全部取来源数据，拒绝伪造 ID 后以规则选择降级。

来源网络总预算约 25 秒，单次含 provider 锁/限速等待最多 5 秒，模型最多 30 秒且不能放大连接本身的超时。端点最长约 55 秒加少量本地处理，客户端用长请求策略并禁止自动重试付费 POST。公共来源候选缓存 6/24 小时、失败缓存 5 分钟，配置版本参与 key，修改代理/凭据后不会命中旧失败。表最多 300 条并清理过期；来源失败可保留陈旧批次并显示警告，15 分钟后允许惰性重试。未启用外部功能不会后台预热或收费。
