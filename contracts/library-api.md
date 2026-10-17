# 曲库 API v1

当前接口读取托管曲库，为只读，所有接口均需已登录的管理员或普通用户会话；未登录返回 401。部署默认仅绑定宿主机回环地址。认证与串流接口见 [播放与登录](playback-auth-api.md)；管理操作另见 [曲库管理](library-management.md)。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v1/tracks?q=&limit=50&offset=0` | 分页查询当前曲库中 available 的文件；limit 为 1–200，offset 不小于 0 |
| GET | `/api/v1/tracks/{id}` | 按内部曲目 ID 查询，含 available、missing、unreadable 状态；不存在返回 404 |
| GET | `/api/v1/albums?q=&limit=50&offset=0` | 分页查询专辑；limit 为 1–100 |
| GET | `/api/v1/artists?q=&role=&limit=50&offset=0` | 分页查询贡献者；limit 为 1–100，role 可限制贡献角色 |
| GET | `/api/v1/browse-index?kind=tracks&q=` | 查询整个筛选结果的名称分组数量和首项偏移；kind 为 tracks、albums 或 artists |
| GET | `/api/v1/scans?limit=20` | 最近扫描记录，limit 为 1–100 |
| GET | `/api/v1/scans/{id}` | 指定扫描结果，不存在返回 404 |

分页结果包含 `items`、`total`、`limit`、`offset`。歌曲和专辑的 q 对标题、艺人、专辑与专辑艺人的归一化文本做字面子串匹配；艺人列表的 q 只匹配贡献者名称。支持中文、Unicode NFKC 与大小写折叠；`%`、`_` 不作为通配符。当前没有拼音搜索、简繁互转、模糊搜索或语义检索。

## 名称排序与字母定位

歌曲、专辑、艺人以及某艺人的歌曲／专辑，在按名称浏览时共用服务端排序：数字组在前，随后 A–Z，最后 `#`。中文使用 uv.lock 锁定的 pypinyin 词典生成无声调拼音；全角字符、大小写和拉丁字母音调统一后参与排序。多音字依赖词典的固定选择，保证分页和索引一致，不承诺所有人名和作品名的读音都正确。标点开头、无法转为上述首字母的文字归入 `#`。组内按拼音／归一化名称排序，最后以内部 ID 打破同名，展示标签保持原样。

以下集合保持原有次序：专辑内歌曲按碟号、曲号排列（含艺人页面附加 album_id 的歌曲）；手工歌单按用户排列；播放次数、收听时长、最近听过按对应指标倒序。客户端仅在按名称浏览时显示字母栏。

`/tracks`、`/albums/{id}/tracks`、`/artists/{id}/tracks` 均接受 `sort=title|play_count|listened_ms|last_played_at`，默认 `title`。专辑曲目在默认值下保持碟号／曲号；选择统计排序时优先按当前登录用户的对应指标倒序，再按专辑曲序处理相同指标。普通用户与管理员的统计独立，非法 sort 返回 422。统计排序仍支持相同的 limit／offset 分页，不使用字母索引。

`GET /api/v1/browse-index` 返回当前**完整筛选结果**的索引，不受已加载分页影响。例如：

```json
{
  "kind": "tracks",
  "total": 133,
  "groups": [
    {"key": "0–9", "offset": null, "count": 0},
    {"key": "A", "offset": 0, "count": 12},
    {"key": "B", "offset": null, "count": 0}
  ]
}
```

示例省略了后续组；实际始终返回 28 组，依次为 `0–9`（en dash，U+2013）、`A` 至 `Z`、`#`。`offset` 是零起始偏移，空组为 `null`，`count` 为该组数量。客户端可用对应曲库分页接口及 `offset` 直接跳到未加载的分组。

筛选参数与被定位的曲库接口保持一致：

| 定位的列表 | 索引请求 |
| --- | --- |
| 全部歌曲 | `/api/v1/browse-index?kind=tracks&q=关键词` |
| 全部专辑 | `/api/v1/browse-index?kind=albums&q=关键词` |
| 艺人列表 | `/api/v1/browse-index?kind=artists&role=artist&q=关键词` |
| 某艺人的歌曲 | `/api/v1/browse-index?kind=tracks&artist_id=内部ID&role=artist&q=关键词` |
| 某艺人的专辑 | `/api/v1/browse-index?kind=albums&artist_id=内部ID&role=artist&q=关键词` |

`role` 可选 `artist`、`album_artist`、`vocalist`、`lyricist`、`composer`、`arranger`，不传即原列表接口的全部贡献角色；如果列表选了角色，索引也必须带相同角色。`q` 最长 256 字符。艺人不存在返回 404；不合法 kind／role 返回 422。专辑内曲目和歌单没有名称索引：传入任何 `album_id`，或者对 `kind=artists` 传入 `artist_id`，返回 400 `browse_index_not_supported`。

曲目返回原始展示标签、标题来源、相对路径、时长、格式、采样率、声道、封面存在标记与文件大小，不返回宿主机根目录、锁文件或内部搜索文本。封面与歌词接口见 [本地资源](local-library-assets.md)。

扫描记录含 ID、状态、开始/结束时间、计数与最多 100 个错误明细；`counts.errors` 保留完整错误数量。错误码为 `metadata_invalid`、`file_unreadable`、`file_changed`、`directory_unreadable` 或 `root_unavailable`。

扫描状态为 `running`、`completed`、`completed_with_errors`、`failed` 或 `interrupted`。扫描由 `make scan` / `make docker-scan` 运行，不在 HTTP 进程的临时 BackgroundTasks 中执行。

内部 ID 在同一根目录、相对路径不变的重扫、标签更新及缺失后恢复中保留。外部重命名/移动当前按旧文件缺失、新文件导入处理；未实现 Navidrome 的 PID 移动识别。
