状态：进行中

# 电台书架

服务端已接入书库授权、扫描、载体上传与范围流、个人同步和公共元数据。Web 与 Android 提供书架入口。范围及待验收项见[实施方案](../docs/plans/self-hosted-bookshelf.md)。

## 书库与权限

每个书库有独立托管根目录、库级存储模式、访问设置和自动配对选项。扫描来源统一保存在 `book_library_sources`，每个目录一条，拥有稳定来源 ID 和独立监听开关。配置删除不应删除源文件。

`GET /api/v1/book-libraries` 返回可访问书库的 ID、名称、存储模式、自动配对状态和版本。所有者可访问全部书库，其他已登录账号可以访问 `default_access=all` 的库和明确授权的 `restricted` 库。默认访问策略为 `restricted`。

`POST /api/v1/book-libraries` 由所有者提交 `{name, source_roots?, managed_root?, storage_mode?, default_access?, auto_pair?}`。来源可以留空，默认开启自动配对。省略托管目录时使用服务端运行目录下的 `books/<library_id>`。自定义绝对目录须可写且为空，来源须为现存绝对目录。书库与音乐库的托管目录、扫描来源、已保留的迁移目录，以及运行数据、播客和 Web 目录按[共享存储边界](storage-and-podcast-resources.md)校验。硬链接预检和现有库的显式模式迁移使用共享存储契约。

`PUT /api/v1/book-libraries/{library_id}/access/{user_id}` 由所有者用 `{granted: true|false}` 保存或收回单个账号的明确授权。操作幂等。建库和授权写请求沿用客户端标头检查。撤销明确授权后，公开库的访问仍由库策略提供。

`GET /api/v1/books` 支持按 `library_id` 过滤与 `limit`、`offset` 分页。返回书籍 ID、所属书库、标题、副标题及电子书和有声书载体状态。列表包含请求账号的阅读状态和最近进行中的载体，先返回近期继续阅读或收听的书籍。单本详情读取 `GET /api/v1/books/{book_id}`。书库筛选或单本请求中，无权访问与不存在均返回 404。响应不暴露服务器物理路径，音乐库选择标头不影响书库访问。

所有角色具备 `books:read`，仍需实际书库授权。所有者和曲库管理员具备书籍编辑、上传、书库管理和元数据搜刮能力，资料编辑员具备编辑和搜刮能力。涉及服务器路径注册、账号授予书库访问权限和存储模式迁移的操作由所有者执行。读写自己的进度、书签和批注沿用 `personal:read`、`personal:write`。

## 载体、上传与阅读协议

同一本书可含电子书、有声书或两者。扫描同库识别配对，候选歧义时保持独立；有管理权限的账号可显式配对或拆分。章节和媒体请求按书籍真实所属库授权，未授权时返回 404。有声书独立播放和记录进度，音乐和播客继续使用各自的队列、接续和统计。

上传入口只收 EPUB、TXT 和书籍封面。音频扩展名、音视频 MIME、音频特征字节或 EPUB 内音频均返回 422 `audio_upload_forbidden`，不支持的电子书格式返回 422 `unsupported_ebook_format`。有声书通过只读扫描来源进入书库。

阅读内容以章节 manifest 和服务端净化后的语义块返回。块包含 `block_index`、`tag`、`runs`、`text`、`char_len` 和可选 `image_key`。原 EPUB 的脚本、外部样式和远程资源不交给阅读器执行或加载。正文与图片放入 `book_cache`，缓存图像与音频流使用同一书库授权。滚动与分页使用同一个 `(spine_index, block_index, char_offset)` 阅读锚点。

## 个人状态与同步

读取和写入取当前认证账号。阅读与听书进度分别使用 `reading-progress` 与 `listening-progress` 子路径。写入携带 `session_id`、`device_id`、`base_version`、`sequence`、`intent` 及对应位置。阅读位置使用章节、块和字符偏移，有声书位置使用章节和章内毫秒数，服务端计算书内毫秒数，并记录倍速。新会话匹配基准版本才接管，当前会话按递增序号保存，过期会话写入返回 409 并附当前状态。同步原则见[播客进度契约](podcast-progress.md)。书签、批注及进度按账号持久化，均不进入[便携侧车](wildstring-sidecar.md)。
