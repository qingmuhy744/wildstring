# 电台书架

服务端提供书库授权、扫描、载体上传与范围流、个人同步和公共元数据，Web 与 Android 客户端提供书架入口。

## 书库与权限

每个书库有独立托管根目录、库级存储模式、访问设置和自动配对选项。扫描来源统一保存在 `book_library_sources`，每个目录一条，拥有稳定来源 ID 和独立监听开关。配置删除不应删除源文件。

`GET /api/v1/book-libraries` 返回可访问书库的 ID、名称、存储模式、访问策略（`default_access`）、自动配对状态和版本；仅当调用者为 `owner` 时额外返回 `managed_root` 与每条扫描来源 `{id, root, watch_enabled}`，不向普通成员暴露服务器物理路径。所有者可访问全部书库，其他已登录账号可以访问 `default_access=all` 的库和明确授权的 `restricted` 库。默认访问策略为 `restricted`。

`POST /api/v1/book-libraries` 由所有者提交 `{name, source_roots?, paused_source_roots?, managed_root?, storage_mode?, default_access?, auto_pair?}`，`PUT /api/v1/book-libraries/{library_id}` 由所有者提交 `{name, source_roots?, paused_source_roots?, managed_root?, storage_mode?, default_access?, auto_pair?, version}` 更新书库名称、默认访问策略、自动配对、扫描来源与每条目录的 `watch_enabled` 自动监听开关（变更 `managed_root` 或 `storage_mode` 需走存储迁移并返回 409 `library_migration_required`）。后台监听循环按 `watch_enabled=1` 目录的文件快照变化自动增量扫描入库，未开启监听的目录仅在手动扫描时纳入。来源可以留空，默认开启自动配对。省略托管目录时使用服务端运行目录下的 `books/<library_id>`。自定义绝对目录须可写且为空，来源须为现存绝对目录。书库与音乐库的托管目录、扫描来源、已保留的迁移目录，以及运行数据、播客和 Web 目录按[共享存储边界](storage-and-podcast-resources.md)校验。硬链接预检和现有库的显式模式迁移使用共享存储契约。

`GET /api/v1/book-libraries/{library_id}/access` 由所有者查看书库的默认策略与当前明确授权账号列表；`PUT /api/v1/book-libraries/{library_id}/access/{user_id}` 由所有者用 `{granted: true|false}` 保存或收回单个账号的明确授权。操作幂等。建库和授权写请求沿用客户端标头检查。撤销明确授权后，公开库的访问仍由库策略提供。

`GET /api/v1/books` 支持按 `library_id`、`q`（书名、副标题、作者）、`format`（`ebook` / `audiobook` / `audio`）、`progress_status`（`unread` / `in_progress` / `finished`）过滤，以及 `limit`、`offset` 分页，返回 `items`、`total` 与 `has_more`。每本书包含 ID、所属书库、标题、副标题、作者列表（`authors`）、封面可用状态（`has_cover`）及电子书和有声书载体状态。列表包含请求账号的阅读状态和最近进行中的载体，先返回近期继续阅读或收听的书籍。单本详情读取 `GET /api/v1/books/{book_id}`。书库筛选或单本请求中，无权访问与不存在均返回 404。响应不暴露服务器物理路径，音乐库选择标头不影响书库访问。

所有角色具备 `books:read`，仍需实际书库授权。所有者和曲库管理员具备书籍编辑、上传（含上传或更换封面）、书库管理和元数据搜刮能力，资料编辑员具备编辑和搜刮能力。涉及服务器路径注册、账号授予书库访问权限和存储模式迁移的操作由所有者执行。读写与删除自己的进度、书签和批注沿用 `personal:read`、`personal:write`。

### Google Drive 书库

所有者在「管理中心 → 书架 → 书库与存储」选择 Google Drive，按[共享存储契约](storage-and-podcast-resources.md#google-drive-音乐库与书库schema-64)绑定目录和设置本机缓存。书库列表提供 `storage_backend`，所有者可查看绑定、授权状态、最近同步时间与热缓存占用。书库默认授权、明确成员授权与自动配对沿用书架规则。

所选目录首次树扫描、后续变更同步入库。电子书首次解析在有体积上限的临时文件中进行，章节和图片落在 `book_cache`，日常阅读只读本机缓存。电子书原文件以及有声书分章播放走同源既有端点，有声书头部和容器末尾按需通过 Range 获取，需探测 M4B 章节时使用临时文件。远端文件移出或删除时，已解析电子书仍可阅读，受影响的原书下载或有声文件播放需要重新同步或恢复原文件。多文件有声书重新同步时按保留的文件更新章节表。

云端书库的 EPUB/TXT 直传仅向已授权的 `drive.file` 托管书库开放，仍使用 `POST /api/v1/books/upload` 或 `POST /api/v1/books/{id}/ebook`。云端上传需由所有者显式选定书库。省略 `library_id` 的上传继续选择本地独立副本书库。有声书由目录同步入库。配对与拆分转移服务端载体引用和个人状态，源文件继续存放在原 Drive 路径。

## 载体、上传与阅读协议

同一本书可含电子书、有声书或两者。扫描同库识别配对，同文件夹已有外部上传书籍或候选歧义时保持独立，多文件有声书目录追加文件增量保留书目与进度；有管理权限的账号可显式配对（迁移并清理被并入目录的托管副本与侧车）或拆分。章节和媒体请求按书籍真实所属库授权，未授权时返回 404。有声书独立播放和记录进度，音乐和播客继续使用各自的队列、接续和统计。

上传入口只收 EPUB、TXT 和书籍封面（上传封面限制体积与像素解码边界）。`POST /api/v1/books/upload` 的 `library_id` 可选，省略时自动选择当前账号可访问的独立副本（`copy`）书库；若尚无可用独立副本书库，仅 `owner` 会自动初始化受限（`restricted`）默认托管书库，非 `owner` 账号则返回 403 `book_upload_library_required`（始终不向 `hardlink` 库写入手机/网页直传文件）。音频扩展名、音视频 MIME、音频特征字节或 EPUB 内音频均返回 422 `audio_upload_forbidden`，不支持的电子书格式返回 422 `unsupported_ebook_format`。有声书通过只读扫描来源进入书库。具备 `books:write` 和该书库访问权限的成员可以用 `PATCH /api/v1/books/{book_id}/audiobook/chapters/{chapter_index}` 提交 `{title}` 校对标题。校对保留音频和时间范围，保存后刷新托管目录的便携章节信息。

公共书目元数据基础来源（`Apple iTunes` 含电子书与有声书、`Open Library`、`Google Books`）由 `GET /api/v1/books/metadata/sources` 与 `PUT /api/v1/books/metadata/sources` 管理启用状态（默认启用 `itunes` 与 `openlibrary`，`google_books` 默认不启用）；`GET /api/v1/books/{book_id}/metadata/search` 支持按逗号分隔的 `sources` 或单 `provider` 检索，并透传 Fake-IP 拒绝（422 `remote_url_fake_ip`）与上游限流（429 `book_metadata_rate_limited`）。

阅读内容以章节 manifest 和服务端净化后的语义块返回。块包含 `block_index`、`tag`、`runs`（支持行内 `bold` / `italic` / `code` 样式与 `child.tail` 保序）、`text`、`char_len` 和可选 `image_key`。原 EPUB 的脚本、外部样式和远程资源不交给阅读器执行或加载，压缩归档与 `spine` 条目受解压上限约束。正文与图片放入 `book_cache`，缓存图像与音频流使用同一书库授权。滚动与分页使用同一个 `(spine_index, block_index, char_offset)` 阅读锚点。

## 个人状态与同步

书目列表和详情返回同一份账号级状态。没有已存档的载体时，对应摘要为 `null`。`progress_status` 为 `unread`、`in_progress` 或 `finished`，`resume_kind` 为最近进行中的 `reading`、`listening` 或 `null`。阅读摘要 `reading_progress` 包含 `spine_index`、`chapter_title`、`overall_ratio`、`completed`、`updated_at`。有声摘要 `listening_progress` 包含 `chapter_index`、`chapter_title`、`chapter_position_ms`、`book_position_ms`、`total_duration_ms`、`overall_ratio`、`playback_rate`、`completed`、`updated_at`。

Web 在另一个载体有较新且明显不同的位置时提供对齐操作。按章节标题或序号匹配，匹配不到的情况下按全书比例估算。用户选择跳转时写入目标载体的新进度。

批注颜色支持 `amber`、`terracotta`、`sage`、`stone` 和六位十六进制色 `#rrggbb`。服务端将十六进制颜色保存为小写，拒绝其他写法。客户端编辑既有批注时保留其颜色。

读取和写入取当前认证账号。阅读与听书进度分别使用 `reading-progress` 与 `listening-progress` 子路径。写入携带 `session_id`、`device_id`、`base_version`、`sequence`、`intent` 及对应位置；阅读已完成后再开新会话重读时可使用 `intent="restart"` 重置完成标记。阅读位置使用章节、块和字符偏移（支持零块空章节），有声书位置使用章节和章内毫秒数，服务端计算书内毫秒数，并记录倍速。新会话匹配基准版本才接管，当前会话按递增序号保存，过期会话写入返回 409 并附当前状态。同步原则见[播客进度契约](podcast-progress.md)。书签与批注支持创建和删除（`DELETE /bookmarks/{id}`、`DELETE /annotations/{id}`），按账号持久化，均不进入[便携侧车](wildstring-sidecar.md)。
