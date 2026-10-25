# 播客出品方与本服节目聚合

出品方是本服共享的节目资料；节目与单集仍使用各自原有 ID。来源 `author`
保留原值，不根据作者同名、RSS 更新或节目名称自动确认归属。第一版只展示本服
已经收录、经用户明确关联的节目，不从外部目录发现或自动订阅其他节目。

## 读取

所有读取要求有效登录。现有节目列表和节目详情的 `podcast` 增加：

```json
{"publisher": {"id": "publisher-id", "name": "声动活泼"}, "publisher_version": 2}
```

尚未关联时 `publisher` 为 `null`，初始 `publisher_version` 为 1。

- `GET /api/v1/podcasts/publishers` 返回已关联至少一档节目的出品方数组，
  每项为 `{id,name,podcast_count}`，按名称排序。
- `GET /api/v1/podcasts/publishers/{id}` 返回
  `{publisher:{id,name,podcast_count},podcasts:[PodcastSummary]}`。
  只含本服节目；各节目的未听数量仍按请求账号计算。未知 ID 返回 404。

## 手动确认、修改和解除

`PUT /api/v1/podcasts/{podcast_id}/publisher` 要求客户端标头和
`metadata:write` 权限（所有者、曲库管理员、资料编辑员）。听众写入返回 403。

请求均携带读取到的 `version`，并采用以下一种选择：

```json
{"version": 1, "name": "声动活泼"}
```

```json
{"version": 2, "publisher_id": "existing-publisher-id"}
```

```json
{"version": 3, "publisher_id": null}
```

`name` 与非空 `publisher_id` 互斥。名称为 1–120 个字符，整理空白并按
Unicode 规范化及大小写折叠去重；同名确认会复用同一个稳定出品方 ID。
此规则仅用于用户明确输入的名称，不会把来源作者自动合并为出品方。
无效请求返回 422，未知节目或出品方返回 404，旧版本返回 409，失败不产生
新出品方或覆盖其他人的修改。

成功返回最新 `PodcastDetail`；每次成功确认都会递增 `publisher_version`。
解除关联保留原作者、节目和单集；修正某个节目的归属只影响该节目。
RSS 刷新不会覆盖人工归属。出品方名称暂不提供全局重命名或批量合并入口。

## 多用户边界

复用现有账号、会话、客户端校验和权限。出品方与节目库共享，个人收听进度、
已听状态和接续偏好按账号保留。本地播放队列仍由客户端管理。
当前的服务端 RSS 收录与未来的个人关注是不同关系，本次不新增个人关注功能。

数据库升级至 schema 35，只增加出品方及其节目关联，旧节目默认不关联。
接口结构以应用生成的 `/openapi.json` 为准；本契约说明行为和权限。
