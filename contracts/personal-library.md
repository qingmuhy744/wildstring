# 艺人、歌单、收藏与收听记录

当前支持各用户独立的个人数据，SQLite v10（个人曲库功能最初在 v5 引入）。以下能力已实现；验证结果见 PR 与交付说明。所有接口要求用户会话，写操作还要求 `X-Wildstring-Client: web|android`。收藏、普通/规则歌单和收听统计按登录用户隔离，历史数据迁移给原 admin；见 [账号与访问](users-and-access.md)。它们不修改音频标签、封面、导入源或托管音频。

## 艺人

- `GET /api/v1/artists?q=&limit=50&offset=0`：按名称检索，返回稳定 ID、名称、歌曲数、专辑数、时长及封面曲目 ID。
- `GET /api/v1/artists/{id}`、`/{id}/tracks`、`/{id}/albums`：查看歌曲与专辑；歌曲查询支持 `album_id` 与 `q` 的交集。
- 歌曲艺人与专辑艺人都计入浏览；相同艺人在一首歌里的多次署名只计一次。使用 NFKC、大小写与空白归一化后的完整标签确定身份，不把 AC/DC 或带分隔符的艺人名称盲目拆开。同名不同人暂不能靠外部身份 ID 区分。
- 只统计当前托管库可用曲目。按艺人打开合辑仍保留艺人筛选，专辑卡片的歌曲数也是该艺人的匹配数。艺人视图先复用曲库封面，不请求网络头像和简介。
- 艺人/专辑列表每页最多 100 项，歌曲最多 200 项。艺人身份从现有标签查询聚合，不需要重新导入。

## 默认收藏与普通歌单

每个托管库自动建立一个“♥ 我喜欢”歌单，心形对应 `tracks.loved`；重复设置幂等。该歌单不能删除、改名或手动增删曲目。`PUT /api/v1/tracks/{id}/favorite` 接收 `{loved: true|false}`，`GET /api/v1/favorites/ids` 返回本库收藏 ID。

普通歌单保存真实曲目 ID 与顺序，支持创建、改名、单曲/整页加入、移除与排序。加入重复曲目保留原顺序，每个普通歌单最多 5000 首。缺失曲目的引用保留，浏览时仅显示可用曲目；恢复并保留原 ID 后重新出现。

- `GET/POST /api/v1/playlists`：分页检索/创建；创建体为 `{name, kind: "manual"|"smart", definition}`。
- `GET/PUT/DELETE /api/v1/playlists/{id}`：详情/修改/删除。修改携带 `version`；删除通过查询参数携带版本。类型创建后不可转换。
- `GET/POST /api/v1/playlists/{id}/tracks`：分页读取/追加 `{version, track_ids}`。
- `DELETE /api/v1/playlists/{id}/tracks/{track_id}?version=...`：移除。
- `PUT /api/v1/playlists/{id}/order`：提交 `{version, track_ids}`，必须与完整已有集合一致，不能借排序增删。
- `POST /api/v1/playlists/{id}/move`：提交 `{version, track_id, direction: -1|1}`，可跨页移动。

写操作检查曲库归属，事务内核对版本并递增；版本过期返回 409，失效 ID 返回 404。批量加入中任一 ID 无效会整体回滚。只操作页面内存的播放队列与持久歌单分别管理。

## 规则歌单

参考 [Navidrome Smart Playlists](https://www.navidrome.org/docs/usage/features/smart-playlists/) 的 `all` / `any`、字段条件、排序和数量限制，提供可视化编辑及高级 JSON。当前支持其规则语义的以下子集，不承诺完整 `.nsp` 文件兼容或文件导入。

```json
{
  "all": [
    {"is": {"loved": true}},
    {"any": [
      {"contains": {"artist": "崔健"}},
      {"gt": {"playCount": 3}}
    ]}
  ],
  "sort": "listened",
  "order": "desc",
  "limit": 100
}
```

| 字段 | 单位/含义 | 运算 |
| --- | --- | --- |
| `title`, `album`, `artist`, `albumartist`, `filetype` | 原始标签/音频扩展名；艺人按多值标签分别匹配 | `is`, `isNot`, `contains`, `notContains`, `startsWith`, `endsWith` |
| `loved` | 布尔收藏状态 | `is`, `isNot` |
| `duration`, `playCount`, `listened` | 歌曲时长（秒）、有效播放次数、累计收听（秒） | `is`, `isNot`, `gt`, `lt`, `inTheRange` |
| `lastPlayed`, `dateAdded`, `dateLoved` | 最近播放、首次入库、收藏时间；条件值为正整数天数 | `inTheLast`, `notInTheLast` |

`notInTheLast` 包含从未发生的事件。排序支持标题、歌曲艺人、专辑、歌曲时长、播放次数、累计收听以及三个日期字段，`order` 为 asc/desc，ID 作为稳定次序；`limit` 为 1–5000。每组 1–30 个条件、最多 50 个节点、嵌套最多 5 层。未知字段/运算或无效类型返回 422；文本通配符按字面转义，所有用户值参数化，无 eval、任意 SQL 或文件路径访问。

每次读取按当前数据库重新筛选，无需定时任务。先应用规则、排序、总数限制，再在这个结果上搜索和分页。规则歌单不能手动增删或重排曲目；编辑规则后下次读取生效。已经开始播放的队列是快照，不随规则结果变化而打断播放。

当前不包含流派、发行年份、评分、跳过次数、随机/每日混音、规则引用其他歌单、多字段排序或分享；不能读取的元数据不生成虚构值。

## 收听统计

`POST /api/v1/listening` 接收 `{session_id: UUID, track_id, listened_ms}`，其中时长是同一次播放的累计实际收听毫秒数。浏览器在真实播放时累计媒体前进量与单调时钟的较小值；暂停、缓冲和跳转不累计。每约 5 秒，以及暂停、结束、切歌、页面隐藏/退出时尽力上报。重试使用相同 UUID 与累计值，服务端只增加差值，乱序和重复报告不会重复计数。

- 一次播放实际累计听满 **曲长一半或 4 分钟，取较短值** 后，播放次数增加一次。暂停后继续仍属同次播放；主动重播或切歌后重新开始使用新 UUID。
- 累计收听时间包含未达到计次阈值的片段；最近播放时间在有实际新增收听时更新。
- 服务端检查曲库归属、禁止 UUID 跨曲目复用，并按服务器经过时间限制报告增长，初次上报最多容许 10 秒延迟、单会话最多 6 小时。这是自用播放器统计，不作为独立防作弊审计证据。
- 统计保存到 SQLite，数据库升级不补造历史播放记录。旧曲目的加入曲库时间以升级前最近一次扫描时间兜底；新曲目记录首次入库时间，增量重扫不覆盖。`GET /api/v1/listening/summary` 返回累计次数、时长、听过的歌曲数与收藏数；`GET /tracks?played_only=true&sort=last_played_at|play_count|listened_ms` 浏览明细。
- 断网时当前页面在内存中重试，正常退出使用 keepalive；崩溃、强制关闭或网络持续失败可能丢失未送达的尾段，尚无离线持久上报队列。

## 播放队列与首页文案

歌曲操作提供“下一首播放”与“加入播放队列”：前者插入当前曲目后，没有当前曲目时直接开始。队列允许同曲重复，通过三横杠手柄用鼠标或触摸拖动，靠近边缘时自动滚动；也可聚焦手柄后用上下方向键调整。重排和移除其他条目保留当前曲目、暂停状态及音频元素，不重载串流。队列仍只保存于当前页面。

首页副标题内置 24 条短句；每次进入曲库/刷新选择一句，并用浏览器本地存储排除上次文案。播放、搜索与切视图不会反复更换；存储不可用时仍能使用其余功能。
