# 播客目录搜索契约

状态：`feat/podcast-search` 本地分支实现，未发布。设计依据见调研文档（参考 audiobookshelf 的 iTunes 搜索方式）。

## 范围与原则

- 目录来源仅 Apple Podcasts（iTunes Search API），无需密钥；不接入 Podcast Index。
- 默认并行搜索 `us`、`tw`、`cn` 三个区域，按规范化 RSS 地址与 `collectionId` 合并去重，结果标注来源区域。区域默认值来自 `WILDSTRING_PODCAST_SEARCH_REGIONS`，最多 5 个，非法区域在启动 / 请求时报 `podcast_search_region_invalid`。
- 所有已登录账号都能搜索与预览；能否新增节目沿用 `catalog_policy.require_add`（所有者、曲库管理员，或管理员开启「允许普通用户添加 RSS 并关注」）。
- 少儿不宜节目依据 `collectionExplicitness == "explicit"` 只打标记（`explicit: true`），默认不过滤。
- 预览不写入数据库；只有确认「添加并关注」才调用既有 `POST /api/v1/podcasts`。
- 同一节目只按 `itunes_id` 或规范化 RSS 地址（含重定向后的地址）匹配，绝不按标题匹配。

## 接口

### `GET /api/v1/podcasts/search?q=&limit=`

- 需要会话；`limit` 1–50，默认 25；`q` 去除多余空白后 1–100 字符，否则 `422 podcast_search_query_invalid`；以 `http(s)://` 开头时 `422 podcast_search_query_is_url`（客户端应改走预览）。
- 响应：

```json
{
  "query": "声东击西",
  "provider": "itunes",
  "regions": ["us", "tw", "cn"],
  "failed_regions": [{ "region": "cn", "code": "timeout" }],
  "cached": false,
  "explicit_hidden": 0,
  "results": [
    {
      "itunes_id": "1183662640",
      "title": "声东击西",
      "author": "声东击西",
      "artwork_url": "https://…/600x600bb.jpg",
      "feed_url": "https://feeds.fireside.fm/shengdongjixi/rss",
      "genres": ["Society & Culture"],
      "episode_count": 434,
      "explicit": false,
      "latest_release_at": "2026-10-28T22:00:00Z",
      "page_url": "https://podcasts.apple.com/…",
      "regions": ["us", "tw", "cn"],
      "in_catalog": false,
      "catalog_podcast_id": null,
      "followed": false
    }
  ]
}
```

- 没有公开 `feedUrl` 或标题的条目被丢弃。排序以各区域内的最好名次为准。
- `in_catalog` / `catalog_podcast_id` 只对调用者可见的节目生效（管理员看全部本服节目，普通账号只看自己的关注 / 个人目录），不泄露他人添加的节目。
- 部分区域失败时返回其余结果并列出 `failed_regions`；全部失败时：上游限流 `429 podcast_search_upstream_rate_limited`，超时 `504 podcast_search_timeout`，其它 `502 podcast_search_upstream_failed`。错误不会被吞成空列表。

### `POST /api/v1/podcasts/preview`

- 请求 `{ "feed_url": "https://…", "itunes_id": "可选" }`，需要会话与客户端头；任何已登录账号可用。
- 通过既有 SSRF 防护（`validate_remote_url`、安全重定向处理器、代理策略）抓取 RSS，返回 `feed_url`、`resolved_feed_url`（跟随重定向后的地址）、`title`、`author`、`description`（≤4000 字）、`cover_url`、`episode_count`、按发布时间倒序的 `latest_episodes`（5 条：`title`、`pub_date`、`duration_seconds`）以及与搜索相同的 `in_catalog` / `catalog_podcast_id` / `followed`。
- 失败：`502 podcast_feed_fetch_failed`、`422 podcast_feed_parse_failed`、`422 podcast_feed_invalid`。

### `POST /api/v1/podcasts`（扩展）

- 新增可选 `itunes_id`（`^[1-9][0-9]{0,19}$`）。权限检查把 `feed_url` 与 `itunes_id` 视为添加所需的最小字段。
- 去重顺序：抓取前按原始地址规范化 + 已验证的 `itunes_id` 查找；抓取后再用重定向后的地址查找；写入时在 `BEGIN IMMEDIATE` 事务内复查，避免并发重复。命中已有节目则只为当前账号关注。
- 客户端提交的 `itunes_id` 只有在与搜索缓存或一次 iTunes lookup 中该 ID 的 `feedUrl` 规范化后与原始地址或重定向地址一致时才写入，防止伪造 ID 污染目录。
- 行为变化：RSS 抓取失败由原来的 `400`（中文文本）改为 `502 podcast_feed_fetch_failed`，解析失败为 `422`。

## OPML 导入与导出

导入分两步，解析不产生任何副作用：

### `POST /api/v1/podcasts/opml/parse`

- 需要登录会话与客户端头；请求体 `{"content": "<OPML 文本>"}`，最多 1 MB（超出为 `413 podcast_opml_too_large`）。
- 含 `DOCTYPE`/`ENTITY` 声明、不是 XML 或根元素不是 `opml` 时返回 `422 podcast_opml_invalid`；没有任何 RSS 节目时返回 `422 podcast_opml_empty`；超过 1000 个节目返回 `413 podcast_opml_too_many`。
- 读取任意层级 `outline` 的 `xmlUrl`（属性名不区分大小写；`type="rss"` 时也接受 `url`），按规范化 RSS 地址去重，非 http(s) 地址计入 `invalid`。
- 响应：`{"feeds": [{"title", "feed_url", "html_url", "in_catalog", "catalog_podcast_id", "followed"}], "invalid": n, "duplicates": n}`；`in_catalog`/`followed` 与搜索结果一样只反映当前账号可见的节目。

### `POST /api/v1/podcasts/opml/import`

- 与 `POST /api/v1/podcasts` 相同的添加权限（`podcast_subscriptions_disabled` 等）；请求体 `{"feeds": [{"feed_url"}]}`，每批 1–10 个，网页端自动分批并显示进度。
- 每个地址都走与添加对话框完全相同的路径（网络策略、SSRF 校验、按 iTunes ID/规范化地址/重定向去重、关注、自动下载协调）。单个节目失败不影响同批其余节目。
- 响应：`{"results": [{"feed_url", "status", "podcast_id"?, "title"?, "code"?}]}`，`status` 为 `added`（新入库并关注）、`followed`（本服已有，新关注）、`already_followed`（原本已关注）或 `failed`（附错误码）。

### `GET /api/v1/podcasts/opml/export`

- 任意登录账号都可导出自己关注的节目：OPML 2.0，`outline type="rss" text title xmlUrl`，按标题排序；`Content-Type: text/x-opml`，`Content-Disposition: attachment; filename="wildstring-podcasts.opml"`，不缓存。

网页：节目页顶部「导入 OPML」（仅能添加节目的账号可见）与「导出 OPML」（所有账号）。导入对话框选择文件后列出节目，已关注的不可选，默认勾选其余节目，可「全选未关注」/「全不选」；导入后逐条显示「已添加并关注 / 已关注 / 原本已关注 / 失败：原因」。

## 规范化 RSS 地址

`normalize_feed_url`：去掉协议，主机名小写，去掉默认端口 80/443，合并重复斜杠，去掉末尾斜杠，保留查询串，去掉片段；非 http(s) 或非法地址返回空串。例如 `HTTPS://Feeds.Fireside.fm//shengdongjixi/rss/` → `feeds.fireside.fm/shengdongjixi/rss`。

## 限流与缓存

- 单进程内存实现（WildString 以单个 uvicorn 进程运行）。
- 搜索结果按（区域集合、规范化关键词、limit）缓存 10 分钟，LRU 512 条；预览按规范化地址缓存 5 分钟。命中缓存不消耗配额，配额耗尽时缓存仍可用。
- 对 Apple 的调用全局滑动窗口 18 次 / 分钟（每个区域各算一次，留出余量低于约 20 次 / 分钟的公开限制）；每账号搜索 30 次 / 分钟、预览 12 次 / 分钟。超限返回 `429 podcast_search_rate_limited`（本服限流）或 `podcast_search_upstream_rate_limited`（全局配额 / 上游），`detail.retry_after` 与 `Retry-After` 头给出秒数。
- 上游返回 403 / 429 时进入 60 秒冷却，冷却期间不再请求 Apple。
- 请求超时 10 秒，响应上限 1 MB。

## 搜索设置（schema 44）

### `GET /api/v1/podcasts/search-settings`

任意登录账号可读：`{"version", "regions", "custom_regions", "default_regions", "filter_explicit", "supported_regions", "max_regions", "can_manage"}`。`regions` 为生效的区域（顺序即结果排序优先级）；`custom_regions=false` 表示沿用服务器默认 `WILDSTRING_PODCAST_SEARCH_REGIONS`（未设置时为 `us,tw,cn`）。

### `PUT /api/v1/podcasts/search-settings`

仅所有者。请求体 `{"version", "regions": [...] | null, "filter_explicit": bool}`；`regions` 为空或 `null` 即恢复服务器默认。区域代码不区分大小写、自动去重，必须是受支持的 Apple 店面代码且最多 5 个，否则 `422 podcast_search_region_invalid`；版本过期返回 `409 podcast_search_settings_conflict`。

- `filter_explicit=false`（默认）：成人内容只显示「成人」标记。`true`：从搜索结果中移除，响应 `explicit_hidden` 给出隐藏数量；不影响已添加的节目和 RSS 地址预览。
- 修改立即生效；各区域的缓存仍按区域分别保存 10 分钟。
- 网页：管理 → 设置 →「播客目录搜索」，可添加、移除、调整区域顺序，勾选隐藏成人内容，或「恢复默认区域」。

表 `podcast_search_settings`：单行（`id=1`），`regions TEXT`（逗号分隔，`NULL`=默认）、`filter_explicit INTEGER`、`version INTEGER`、`updated_at TEXT`。

## 已有节目回填与去重（schema 45）

迁移 45 为所有已有节目计算 `feed_url_normalized`，并给 `podcasts` 增加 `itunes_checked_at`、`itunes_check_status`（`NULL`=未检查，`matched`/`no_match`/`failed` 由回填写入，`verified` 为添加时已核实，`existing` 为迁移前已有编号）。

### 回填任务

- `POST /api/v1/podcasts/identity/backfill`（仅所有者，需 `X-Wildstring-Client`）：请求体可选 `{"limit": 1..1000（默认 100）, "retry_unmatched": false}`，在后台线程启动一轮，返回 `202` 与状态；已在运行时 `409 podcast_identity_backfill_running`。
- `GET /api/v1/podcasts/identity/backfill`（仅所有者）：`{"running", "processed", "matched", "no_match", "failed", "ambiguous", "paused_until", "last_run", "total", "with_itunes_id", "unchecked", "counts"}`。
- 每个待检查节目：先请求一次 RSS 以得到重定向后的地址（两次请求至少间隔 2 秒），再以节目名称、必要时「名称 + 作者」在当前设置的区域搜索 Apple（iTunes 没有按 RSS 地址查询的接口）。**只有** Apple 记录的 `feedUrl` 规范化后等于本节目的规范化地址或重定向后的地址时才写入 `itunes_id`，绝不只按名称匹配。同一 RSS 在 Apple 有多个编号时取数值最小（最早上架）的一个，并计入 `ambiguous`。
- 与用户搜索共用每分钟约 20 次的 Apple 预算，并为用户保留 5 次；预算用尽或 Apple 限流时任务等待（`paused_until`，单节目最多等 5 分钟），服务停止时立即结束。
- 幂等：只处理 `itunes_id` 为空且未检查（或上次 `failed`）的节目；`retry_unmatched=true` 时也重试 `no_match`。已有的 `itunes_id` 和重定向地址从不被覆盖。可随时中断，下次从剩余节目继续。

### 重复报告与合并

- `GET /api/v1/podcasts/identity/duplicates`（仅所有者）：成对列出可能重复的节目，`{"duplicates": [{"confidence", "reasons", "itunes_id", "suggested_keep_id", "podcasts": [两条摘要]}], "verified", "possible"}`。`reasons` 取自 `itunes_id`（同一编号）、`feed`（规范化地址或重定向地址相同）、`title`（规范化名称相同且作者相同或其一为空）。
- 只有两条记录的 `itunes_id` 相同（该编号已按 RSS 核实）才是 `verified`；其余都是 `possible`，只报告、不合并。建议保留：未重定向的地址优先，其次关注多、下载多、更早添加。
- `POST /api/v1/podcasts/identity/merge`（仅所有者）`{"keep_id", "merge_id"}`：未核实 `409 podcast_merge_unverified`；任一节目有排队或下载中的单集 `409 podcast_merge_busy`；同一节目 `422 podcast_merge_same`；不存在 `404 podcast_not_found`。在一个事务内：
  - 单集按 `guid`、其次按音频地址对齐；对不上的单集整条移入保留节目（进度、引用、下载随之）。
  - 对齐的单集：同一账号两边都有进度时保留最近收听的一条（版本号递增）；播放缓存、资源引用（手动/自动标记取并集）、保护状态和租约迁到保留的单集。保留的单集没有下载而另一边有时，转移已下载文件；两边都有时删除重复的那份。
  - 关注、个人目录与个人节目设置迁到保留节目（已存在则以保留节目为准）；出品方为空时继承。随后删除被合并的节目。
  - 返回 `{"kept_id", "merged_id", "episodes_moved", "episodes_matched", "progress_moved", "progress_replaced", "downloads_moved", "follows_moved"}`。
- 网页：管理 → 设置 →「播客去重与回填」显示统计、开始回填、进度，以及「已核实 / 疑似」重复列表；已核实的可选择保留哪条后二次确认合并，疑似的只给出核对建议。

## 数据库（schema 43）

`podcasts` 增加 `itunes_id`、`feed_url_normalized`、`resolved_feed_url_normalized`（均为 TEXT，可空）及索引 `podcasts_by_itunes_id`（部分索引）、`podcasts_by_normalized_feed`、`podcasts_by_resolved_feed`。新增节目写入这三列。

## 网页

- 「+ 添加节目」（无添加权限时为「搜索节目」）打开单一输入框：关键词 400 ms 防抖搜索，新输入会中止旧请求；粘贴 `http(s)://` 地址则直接预览。
- 状态：空输入提示、搜索中、无结果、部分区域失败、错误（含 429 剩余秒数）。
- 结果卡片：封面、作者、集数、分类、来源区域、成人内容标记、「已关注」/「本服已有」。
- 点开结果显示预览（桌面右侧、移动端整屏并可返回）：简介、最新单集，按钮为「添加并关注」「关注并打开」或「已关注 · 打开节目」；无权限时按钮禁用并说明。
- 粘贴的地址预览失败仍可尝试添加，由服务端去重并返回自身错误（与旧对话框一致）。
- 错误码的中文提示统一写在 `frontend/web/src/api.ts`。

## 验证

- 后端：`backend/tests/test_podcast_search.py`，使用录制的 us / tw / cn iTunes 响应（`backend/tests/fixtures/itunes/`），不访问网络；`backend/tests/test_podcast_opml.py` 覆盖 OPML 解析、导入与导出；`backend/tests/test_podcast_identity_backfill.py` 覆盖迁移 45、只按 RSS 核实的回填（含 etw.fm 重定向到 fireside、同名不同源、多编号）、幂等与限流等待、重复报告和保留关注/进度/下载的合并。
- 网页：`frontend/web/tests/podcast-search.spec.ts` 、`podcast-opml.spec.ts`、`podcast-search-settings.spec.ts` 与 `podcast-identity-admin.spec.ts`（模拟 API，桌面与移动端），随 `make test-podcast-web` 运行。
