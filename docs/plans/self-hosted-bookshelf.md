状态：已确认

# 电台自托管书架（电子书与有声书 · 0.9.0-alpha.1）

## 目标

在 WildString 的「电台」模块下新增面向自托管电子书与有声书的「书架」能力（第一批覆盖规范契约、Python 后端、Web 端与 Android Phone/Pad 端，目标版本 `0.9.0a1` / `v0.9.0-alpha.1`）：

1. **统一书籍实体模型**：单本 `Book` 可仅包含电子书（`.epub` / `.txt`）、仅包含有声书（带章节 `.m4b` 或多文件 `.mp3` / `.m4a` / `.flac` / `.ogg` / `.opus`），或同时配对两者（在「有声书 + 伴读电子书」场景下统一展示与管理，并保留同书自动配对及管理员手动合并/拆分）。
2. **「电台」内部导航整合与播放隔离**：在「电台」顶部分段切换「播客 | 书架」；有声书章节播放、倍速与进度体系独立运作，不进入 `podcast_queue`、音乐 `playback_states`、推荐系统与 Last.fm。
3. **只读多源扫描 + 电子书专属上传边界**：多书库支持从本地只读目录导入有声书与电子书；界面与 HTTP 上传接口严格只接收电子书（`.epub` / `.txt`）与封面图片，任何渠道上传音频文件均被服务端以 `HTTP 422 audio_upload_forbidden` 拒绝。
4. **按用户隔离的跨端进度与批注**：电子书阅读锚点 `(spine_index, block_index, char_offset)`、有声书位置 `(chapter_index, chapter_position_ms, book_position_ms, playback_rate)`、个人书签（支持电子书与音频时间戳）及 4 色暖调划词批注按 `user_id` 严格隔离，并通过版本 CAS 协议实现跨端同步。
5. **双模式安全电子书阅读器**：提供可无损切换的「上下滚动」与「分页翻页」阅读模式，服务端零脚本抽取净化并落盘章节块缓存；支持目录、全书搜索、字号/行高/字体切换以及独立暖纸浅色与暖炭深色主题。
6. **多源元数据提取与在线搜刮**：解析本地 OPF / `metadata.json` / 音频标签与章节 / `reader.txt` / `desc.txt`，支持 `OpenLibrary`、`Google Books` 与 `Apple iTunes Search` 在线检索，覆写值与锁定字段只入库，不改动源文件与托管原件。

相关基线规范与现行代码参考：[AGENTS.md](../../AGENTS.md)、[DESIGN.md](../../DESIGN.md)、[docs/product/scope.md](../product/scope.md)、[contracts/multiple-libraries.md](../../contracts/multiple-libraries.md)、[contracts/managed-library.md](../../contracts/managed-library.md)、[contracts/podcast-progress.md](../../contracts/podcast-progress.md)、[contracts/podcast-queue.md](../../contracts/podcast-queue.md)、[contracts/playback-transcoding.md](../../contracts/playback-transcoding.md)、[contracts/metadata-providers.md](../../contracts/metadata-providers.md) 与 [contracts/storage-and-podcast-resources.md](../../contracts/storage-and-podcast-resources.md)。

---

## 不碰的边界

1. **禁止 AI 书籍衍生功能**：本批不做 AI 阅读摘要、剧透安全回顾、AI 问答、TTS 合成朗读以及任何 MCP 书籍工具；现有音乐/播客基础播放不得因书架模块受损。
2. **禁止网页或上传接口接收音频文件**：`POST /api/v1/books/upload` 与 `POST /api/v1/books/{book_id}/ebook` 只能上传电子书或绑定电子书，禁止直接上传 `.m4b` / `.m4a` / `.mp3` / `.flac` / `.ogg` / `.opus` 等音频，也禁止 `.epub` 内嵌音频条目。有声书只能通过管理员配置的本地只读扫描源导入。
3. **不修改导入源且不改写托管原件**：延续 [contracts/managed-library.md](../../contracts/managed-library.md)，导入源绝对只读，拒绝 symlink；用户元信息覆写与锁定（`book_metadata_overrides`）及个人进度/批注只存 SQLite，不回写托管的 `.epub` / `.txt` / 音频文件标签。
4. **不将正文或音频正文大字段塞入 SQLite**：SQLite 只存书籍索引、章节目录元数据、锚点进度、书签和划词批注；解析后的 `.epub` / `.txt` 规范化块 JSON 与提取图片落盘至 `<data_dir>/book_cache/<book_id>-<sha256[:16]>/`，避免 WAL 检查点与客户端 Room 数据库膨胀。
5. **不执行书籍内嵌脚本或外部 CSS/外链**：Web 与 Android 端均严禁直接把未经净化的 EPUB HTML 交给 `dangerouslySetInnerHTML`、`WebView`（带 JS）或未过滤加载外部资源；阅读器只消费后端抽取后的安全语义块协议。
6. **Batch 1 客户端边界**：本批实现 Backend、Web 与 Android（Phone + Pad）；macOS 与 iOS 原生书架 UI 留待下一批，但必须保证 `0.9.0a1` 后端保持向后兼容，且 [scripts/package_release.py](../../scripts/package_release.py) 对五端版本号与构建号校验完整通过。

---

## 方案

### 阶段一：契约设计、目录边界、权限与 SQLite Schema v56

#### 1.1 契约与权限扩展

- 新建契约文档 `contracts/bookshelf.md`，定义书籍实体模型、扫描与配对规则、电子书块级渲染协议、仅电子书上传校验错误码、CAS 进度同步载荷及元数据搜刮结构。
- 同步更新 [docs/product/scope.md](../product/scope.md)，补全「电台 · 书架」及版本状态入口（在发版时再对齐两份 README 与 `CHANGELOG.md`）。
- 扩展 [backend/src/wildstring/permissions.py](../../backend/src/wildstring/permissions.py) 中 `PROFILES` / `PROFILE_SCOPES`：
  - 新增 scope：`books:read`、`books:write`、`books:upload_ebook`、`books:manage_libraries`、`books:scrape_metadata`。
  - 默认角色分配：`owner` 与 `librarian` 拥有全部书籍管理与上传权限；`editor` 拥有元信息编辑与搜刮权限及个人读写权限；`listener` 仅对授权书库拥有只读访问及本人进度/书签/批注读写权限（任何个人端点均以当前登录用户 `user_id` 强制过滤，禁止越权传参读取或修改他人数据）。

#### 1.2 存储目录隔离与访问控制

- 修改 [backend/src/wildstring/library/storage.py](../../backend/src/wildstring/library/storage.py) 中的 `LibraryStorage`：
  - 托管书籍根路径默认为 `<data_dir>/books`（支持环境变量配置），解析缓存位于 `<data_dir>/book_cache`。
  - 在配置书库扫描源（`book_libraries.source_roots`）与托管书籍目录校验时，复用既有重叠加与包含检查，禁止 `books_dir` 与音乐 `libraries`、`library_sources`、`library_migrations`、`podcasts_dir`、`web_dir` 或书库源目录互相包含/重叠。
- 修改 [backend/src/wildstring/library/access.py](../../backend/src/wildstring/library/access.py)：
  - 核对 `LibraryAccess` ASGI 中间件与 `EXEMPT_PREFIXES`：将 `/api/v1/books` 与 `/api/v1/book-libraries` 纳入认证后由书籍模块自主按 `(user_id, book_library_id)` 执行授权隔离；对于无权访问或不存在的书籍/章节/缓存图片/音频流，统一返回 `HTTP 404`（遵循 [contracts/multiple-libraries.md](../../contracts/multiple-libraries.md) 不泄露未授权资源存在性）。

#### 1.3 SQLite Schema v55 → v56

在 [backend/src/wildstring/database.py](../../backend/src/wildstring/database.py) 将 `SCHEMA_VERSION` 从 `55` 升至 `56`，并同步在 [backend/tests/migration_support.py](../../backend/tests/migration_support.py) 补充旧库迁移测试构造：

1. **书库与授权**：
   - `book_libraries`：`id`, `name`, `source_roots_json`, `default_access`（`all` | `restricted`）, `auto_pair`（默认 1）, `version`, `created_at`, `updated_at`
   - `book_library_access`：`(library_id, user_id, granted_by, created_at)` 联合主键
2. **书籍主表与载体子表**：
   - `books`：`id`, `library_id`, `title`, `sort_title`, `subtitle`, `authors_json`, `narrators_json`, `series_name`, `series_index`, `publisher`, `published_year`, `language`, `isbn10`, `isbn13`, `description`, `tags_json`, `cover_path`, `cover_hash`, `has_ebook`, `has_audiobook`, `pair_key`, `overrides_json`, `locked_fields_json`, `created_at`, `updated_at`
   - `book_ebooks`：`id`, `book_id`（唯一外键）, `format`（`epub` | `txt`）, `managed_path`, `source_path`, `file_size`, `sha256`, `encoding`, `spine_count`, `total_chars`, `cache_key`, `parsed_at`
   - `book_ebook_chapters`：`(book_id, spine_index)`、`href`、`title`、`level`、`block_count`、`char_count`、`start_global_char`
   - `book_audiobooks`：`id`, `book_id`（唯一外键）, `is_multi_file`, `total_duration_ms`, `chapter_count`, `total_bytes`, `codec_summary`, `created_at`
   - `book_audiobook_files`：`(book_id, file_index)`、`managed_path`、`source_path`、`relative_name`、`duration_ms`、`codec`、`bitrate`、`sample_rate`、`channels`、`file_size`、`sha256`、`start_book_ms`
   - `book_audiobook_chapters`：`(book_id, chapter_index)`、`file_index`、`title`、`start_file_ms`、`end_file_ms`、`start_book_ms`、`duration_ms`
3. **扫描与元信息任务**：
   - `book_scan_jobs`：`id`, `library_id`, `status`, `scanned_files`, `added_books`, `updated_books`, `paired_books`, `error_message`, `started_at`, `finished_at`
4. **个人状态表（全部按 `user_id` 隔离）**：
   - `book_reading_progress`：`(user_id, book_id)`、`spine_index`, `block_index`, `char_offset`, `chapter_title`, `overall_ratio`, `reading_mode`（`scroll` | `paginated`）, `completed`, `version`, `session_id`, `device_id`, `updated_at`
   - `book_listening_progress`：`(user_id, book_id)`、`chapter_index`, `chapter_position_ms`, `book_position_ms`, `playback_rate`, `completed`, `version`, `session_id`, `device_id`, `updated_at`
   - `book_bookmarks`：`id`, `user_id`, `book_id`, `kind`（`ebook` | `audio`）, `spine_index`, `block_index`, `char_offset`, `chapter_index`, `position_ms`, `excerpt`, `note`, `created_at`, `updated_at`
   - `book_annotations`：`id`, `user_id`, `book_id`, `spine_index`, `start_block_index`, `start_char_offset`, `end_block_index`, `end_char_offset`, `selected_text`, `note`, `color`（`amber` | `terracotta` | `sage` | `stone`）, `created_at`, `updated_at`

---

### 阶段二：后端实现（扫描配对、电子书解析、音频章节、上传限制、进度同步、搜刮）

建议后端代码统一收敛于新包 `backend/src/wildstring/books/`（`router.py`, `scanner.py`, `ebook_parser.py`, `audiobook.py`, `upload.py`, `progress.py`, `metadata.py`, `providers.py`, `service.py`），并注册进主 FastAPI 应用入口。

#### 2.1 只读扫描、目录识别与同书自动配对

- **扫描器识别规则**（`scanner.py`）：
  - 遍历授权 `source_roots`，对每个文件或 symlink 使用 `O_NOFOLLOW` 校验，发现 symlink 一律跳过并记录告警，绝不跨越读出外部路径。
  - **单目录优先判定**：含音频文件的叶目录（或含 `metadata.json` / `metadata.opf` 的专辑目录）归组为一本有声书候选；目录中同时存在 `.epub` / `.txt`（最多匹配同书电子书）与多文件音频或 `.m4b` 时直接配对进同一本 `Book`。
  - **跨目录同库自动配对**：当启用 `book_libraries.auto_pair` 时，基于规范化 `pair_key = normalize(author) + "::" + normalize(title)`（去除全半角空格、副标题括号及 `v2`/`典藏版`/`有声版` 等常见修饰）在同一个 `library_id` 内自动将仅含电子书与仅含有声书的候选合并为统一 `Book`；若存在多本同名歧义（`count > 1`）则保持独立并标注待确认，避免误合并。
  - **托管拷贝与幂等增量**：计算 `sha256` 与 `mtime + size`，复用 [contracts/managed-library.md](../../contracts/managed-library.md) 独占硬链接/副本发布到 `<books_dir>/<book_id>/`；重扫发现已存在托管书且源文件指纹未变时跳过复制，且若用户已有 `locked_fields`，绝不覆写被锁定字段。
- **手动关联与拆分接口**：
  - `POST /api/v1/books/{book_id}/pair`：管理员可将另一本仅含另一载体的同库 `Book` 合并到当前 `Book`（原子迁移 `book_ebooks` 或 `book_audiobooks` + 章节/进度归口并删去空壳书）。
  - `POST /api/v1/books/{book_id}/split`：管理员可将已配对的 `Book` 拆分为两本独立 `Book`，分别保留各自个人进度、书签与批注（阅读进度归电子书、收听进度归有声书）。

#### 2.2 有声书章节提取与范围流/转码

- 复用 [backend/src/wildstring/library/metadata.py](../../backend/src/wildstring/library/metadata.py) 与 [backend/src/wildstring/library/conversion.py](../../backend/src/wildstring/library/conversion.py) 模式（`audiobook.py`）：
  - 单文件 `.m4b` / `.m4a`：使用 `mutagen.mp4.MP4.chapters` 读取内嵌章节表，并以 `ffprobe -show_chapters -of json` 作为兜底；无内嵌章节时生成单章（书名）。
  - 单文件 `.mp3`：使用 `mutagen.id3` 的 `CHAP` / `CTOC` 帧提取章节。
  - 多文件目录有声书：按音频内嵌 `track` 标签及自然文件名序号排序；若单文件内部无章节标记，则每个文件映射为一个章节（标题优先取文件 `title` tag，回退去除编号前缀的文件名）；若多文件本身自带 `CHAP`，按全局时间偏移串联展平章节表并计算 `start_book_ms`。
- **播放与转码**：
  - 复用 [backend/src/wildstring/library/streaming.py](../../backend/src/wildstring/library/streaming.py) 的 HTTP Range 响应机制，提供 `GET /api/v1/books/{book_id}/audiobook/files/{file_index}/stream`（支持范围拖动、缓存头 `ETag` 与认证鉴权，按 [contracts/playback-transcoding.md](../../contracts/playback-transcoding.md) 补齐可选转码参数给不兼容格式，如 `.ogg`/`.opus` 对特定客户端提供按章按需 AAC/FLAC 转码兜底）。

#### 2.3 安全零脚本电子书解析与 `book_cache`

- **EPUB 安全解析**（`ebook_parser.py`）：
  - 使用 `zipfile` 严格限制解压安全阈值：最大压缩包大小（如 `256 MiB`）、最大解压总字节（如 `512 MiB`）、单条目上限、条目数量上限（如 `5000`），检查条目名称拒绝路径穿越（`..`、前导 `/`）与 ZIP symlink 位。
  - **内嵌音频零容忍校验**：解压前即遍历全部 ZIP 条目扩展名与魔数，以及 OPF `<manifest>` `media-type`，发现任何 `audio/*` 或音视频载荷直接抛错拒绝（供上传校验返回 `audio_upload_forbidden`，扫描路径则跳过文件并记录错误原因）。
  - 全部 XML（`container.xml`、OPF、NCX、XHTML 章节）一律使用 `defusedxml` 解析（禁用外部实体与 DTD 注入）。
  - 将每章 XHTML 递归归约为结构化安全 JSON 块数组，每块结构含 `block_index`、`tag`（`h1`–`h6`, `p`, `blockquote`, `pre`, `ul`, `ol`, `li`, `hr`, `figure`）、`runs`（纯文本、加粗/斜体/行内代码/安全内部链接 `#block:anchor`）与纯文本串 `text`、`char_len`、图片资源键 `image_key`；章节内嵌相对图片安全校验图像头部格式与最大像素后拷贝至 `book_cache/<cache_key>/images/`，通过 `GET /api/v1/books/{book_id}/ebook/assets/{asset_path}` 鉴权返回。
- **TXT 解析**：
  - 探针编码顺序：`utf-8-sig` → `utf-8` → `gb18030` → `big5` → `utf-16`，记录置信编码至 `book_ebooks.encoding`。
  - 使用通用中英文章节正则识别章目并划分 `spine_index`；对无明显章目或单章超过 `12,000` 字符的长章按自然段边界智能切分虚拟分页单元，保障长文档翻页与搜索响应速度。
- **阅读器只读接口**：
  - `GET /api/v1/books/{book_id}/ebook/manifest`：返回书籍标题、格式、目录树（`toc`）、各 `spine_index` 字数与起始全局偏移。
  - `GET /api/v1/books/{book_id}/ebook/chapters/{spine_index}`：返回规范化后的安全 `blocks` JSON（直接命中 `book_cache` 磁盘缓存；若缓存缺失或版本递增自动惰性重建）。
  - `GET /api/v1/books/{book_id}/ebook/search?q=...`：基于缓存正文分块检索并返回 `(spine_index, block_index, char_offset, snippet)` 列表（限流与最大命中上限保护）。
  - `GET /api/v1/books/{book_id}/ebook/download`：允许有权限的用户下载托管 `.epub` / `.txt` 原件。

#### 2.4 电子书专属上传边界（`HTTP 422 audio_upload_forbidden`）

复用 [backend/src/wildstring/library/upload.py](../../backend/src/wildstring/library/upload.py) 的流式落盘与临时文件清理模式新建 `books/upload.py`：

- 仅暴露以下 3 类上传/绑定端点（均要求 `books:upload_ebook` 或 `books:write` 权限，且受书库归属校验）：
  1. `POST /api/v1/books/upload`：上传单本 `.epub` / `.txt`（可选同步表单字段指定目标 `library_id`、书名、作者及可选封面图），直接入库为独立电子书或按目标库配置尝试配对。
  2. `POST /api/v1/books/{book_id}/ebook`：为已存在但尚无电子书的有声书补充绑定一本 `.epub` / `.txt`（若该书已存在电子书返回 `409 ebook_already_exists` 或需传 `replace=true` 显式确认）。
  3. `POST /api/v1/books/{book_id}/cover`：上传单张 `.jpg`/`.png`/`.webp` 封面，使用 Pillow 校验并重编码规范化。
- **四层防御拒绝音频**：
  1. 文件名与扩展名白名单校验：仅 `.epub` / `.txt`（书籍）及 `.jpg` / `.jpeg` / `.png` / `.webp`（封面）；扩展名属于音频列表（`.m4b`, `.m4a`, `.mp3`, `.flac`, `.ogg`, `.opus`, `.wav`, `.aac`, `.wma`, `.alac`, `.aiff`, `.ape`, `.dsf`）直接拦截。
  2. MIME 头检验：拒绝任何 `audio/*`、`video/*`。
  3. 流式首块魔数探针：流式读取前 4 KiB 检测常见音频头（`ID3`、`fLaC`、`OggS`、`RIFF....WAVE`、MP4 `ftypM4A`/`ftypM4B`/`ftypmp42` 非封面箱体、ADTS/MPEG 帧头 `0xFFEx`），命中后立即中止接收、删除临时文件并拒绝。
  4. `.epub` ZIP 容器深度检测：在发布到托管目录前运行 2.3 的 `ebook_parser` 安全与无音频校验，若压缩包内含音频文件或媒体音频项则删除临时包并拒收。
- 所有音频拒绝与伪装文件拒绝均返回稳定 JSON 错误体：`HTTP 422`，`code = "audio_upload_forbidden"`（其余无效格式如 `.pdf` 返回 `HTTP 422 unsupported_ebook_format`），明确写入 API 契约并设全覆盖安全单测。

#### 2.5 个人进度 CAS、书签、批注与元数据搜刮

- **双通道 CAS 进度同步**（`progress.py`）：
  - `GET / PUT /api/v1/books/{book_id}/reading-progress` 与 `GET / PUT /api/v1/books/{book_id}/listening-progress`：复刻 [contracts/podcast-progress.md](../../contracts/podcast-progress.md) 的 `session_id`、`device_id`、`base_version`、`sequence`、`event`、`intent` 语义；强意图（`seek`, `chapter_jump`, `mark_complete`, `mode_switch`, `manual_resume`）优先并递增 `version`，常规节流心跳过期返回 `409 conflict` 连带最新服务器状态给前端决策。
  - **结尾自动完成边界**：电子书到达最后一章末块 98%+ 或手动点完结置 `completed=1`；有声书复用播客结尾留白规则（剩余不足 5% 且夹紧于 30s–120s 内视为完听），并保留单键切换「已完结 / 重置进度」。
- **个人书签与批注 CRUD**：
  - `GET / POST / PATCH / DELETE /api/v1/books/{book_id}/bookmarks`
  - `GET / POST / PATCH / DELETE /api/v1/books/{book_id}/annotations`（严格校验 `color in ("amber", "terracotta", "sage", "stone")` 与锚点范围合法性 `start <= end`）
- **元信息与在线搜刮**（`metadata.py`, `providers.py`）：
  - 本地提取整合：EPUB OPF → Calibre `metadata.opf` → Audiobookshelf `metadata.json` → `reader.txt`/`desc.txt` → 音频标签 → 同级目录封面。
  - 在线聚合搜刮：`POST /api/v1/books/{book_id}/metadata/search`（与仅查单条 `POST /api/v1/book-metadata/search`），支持选择组合提供商 **`openlibrary`**、**`google_books`**、**`itunes`**；复刻 [contracts/metadata-providers.md](../../contracts/metadata-providers.md) 的出站 SSRF 检查（禁止内网/回环 URL 封面下载）、代理配置、超时控制与速率节流。
  - 字段应用：`POST /api/v1/books/{book_id}/metadata/apply`（带书籍编辑乐观锁或 `locked_fields` 控制），写入 `books.overrides_json` 与 `locked_fields_json`；封面下载同样经 Pillow 解码校验后写为派生封面文件。

---

### 阶段三：Web 端 UI、安全阅读器与有声书播放器

所有色彩、间距、字号层级、等宽数字（`tabular-nums`）与减少动态效果严格遵循 [DESIGN.md](../../DESIGN.md)。

#### 3.1 「电台 → 书架」导航与管理入口

- 改造 [frontend/web/src/podcasts.tsx](../../frontend/web/src/podcasts.tsx) 及相关电台壳层：
  - 在「电台」头部引入统一分段切换器 **`播客 | 书架`**，并同步路由支持（如 `/podcasts` 与 `/books` 或同壳内状态路由 `/podcasts/books`、`/books/:bookId`、`/books/:bookId/read`，保持现有书签与播客链接兼容）。
  - 书架主页（`bookshelf.tsx`）：
    - 顶部过滤与操作条：载体筛选（`全部` / `电子书` / `有声书` / `双载体`）、状态筛选（`进行中` / `未开始` / `已完成`）、搜索框（书名/作者/演播者/标签）与排序。
    - 置顶继续卡：显示最近阅读与最近收听的书籍，明确显示双进度胶囊（如「第 4 章 · 42%」与「12:34 / 38:10」）。
    - 书籍网格卡片：统一封面容器比与标题/作者层级，小角标克制区分介质类型（仅 1 行克制信息，无废话副标题）；提供完整的 `Loading`（匹配卡片骨架）、`Empty`（按权限区分引导管理员添加书库/上传电子书，或普通用户平静提示联系管理员授权）、`Error`（明确原因 + 重试）。
    - 上传入口（仅权限用户可见）：交互文件选择器严格配置 `accept=".epub,.txt,application/epub+zip,text/plain"`，明确文案「上传电子书（`.epub` / `.txt`）」；若用户拖入音频文件或服务端返回 `audio_upload_forbidden`，内联平静提示「网页仅支持上传电子书；有声书请由管理员添加至书库扫描目录」。
- **书籍详情页**（`book-detail.tsx`）：
  - 展示主元信息（作者、演播者、系列及卷号、语言、出版年、ISBN、由 [podcast-description.tsx](../../frontend/web/src/podcast-description.tsx) 同级安全纯文本/白名单渲染的简介）。
  - 主操作区按可用载体动态组装（容器自动组内对齐）：有电子书则主按钮「继续阅读 / 开始阅读」+ 绑定格式/字数；有有声书则按钮「继续收听 / 从第 X 章播放」+ 总时长。
  - **独立章节列表**（有声书章节 tab、电子书目录预览 tab）、**个人书签与批注管理 tab**（支持点按跳转到阅读器或有声书对应位置）、**管理员配对/拆分/元信息搜刮面板**（搜刮 OpenLibrary / Google Books / iTunes 候选对比预览与逐字段锁定应用）。

#### 3.2 Web 双模式电子书阅读器（`book-reader.tsx`）

- 沉浸阅读路由 `/books/:bookId/read`（可从书架卡片、继续栏、详情页或有声书伴读按钮进入；全屏布局脱离常规音乐底栏遮挡，顶部与底部工具栏可单按正文中央显隐切换）：
  - **双模式与无损锚点迁移**：
    - Toolbar 内一键切换 **`上下滚动` (`scroll`)** ↔ **`分页翻页` (`paginated`)**，并在切换前捕获当前视口首个可见文本 `(spine_index, block_index, char_offset)`。
    - **上下滚动模式**：以章节切片流式按需挂载当前与前后相邻 `spine_index` 安全块 DOM，IntersectionObserver + 精确文本Range 计算读取首可见字符偏移；滚动节流 1.5s + 章节切换/退出页面触发 CAS 上报。
    - **分页翻页模式**：利用单章水平多栏分列视图（CSS Multi-Column `column-width: 100%; column-gap: var(--reader-page-gap); overflow: hidden`）配合整数页索引平移（不出现横向滚动条与切半字符），支持左右 30% 点击翻页、键盘 `ArrowLeft` / `ArrowRight` / `Space`、触控滑动手势，并在跨章末/章首无缝衔接下一/上一 `spine_index`；切模式、调整字号（`14–24px`）、行高、字体（衬线/无衬线）或窗口 resize 时重新测算页码并跳回捕获锚点。
  - **暖纸质独立主题**：阅读器右上支持直接切换「浅色纸感 `#F6F3ED` / 墨灰 `#1F1D1A`」与「深色暖炭 `#181614` / 浅米灰 `#E6E0D4`」（或跟随系统），严格遵循 [DESIGN.md](../../DESIGN.md) 对比度规则；切换阅读器内纸张主题不强迫改写用户全局站点主题选择。
  - **工具抽屉**：目录定位、全书正文搜索（点击命中结果精确高亮短闪烁定位）、个人书签（一键打签与跳转）、划词浮条与批注面板（选中文本弹出 4 色圆点 `amber` / `terracotta` / `sage` / `stone` + 写笔记）。
  - **双载体伴读便捷条**：若本书同时含有声书，可在阅读器顶部小控制栏快速启停或调速伴听，但保持阅读与听书两套独立进度互不覆盖。

#### 3.3 Web 有声书播放器整合

- 修改或独立扩展 [frontend/web/src/podcast-track.ts](../../frontend/web/src/podcast-track.ts) 周边播放器状态机，但与 `podcast_queue` 彻底分轨：
  - 引入明确 `bookAudioSession` 通道（复用 HTMLAudioElement / MediaSession 单一全局音频实体，确保切换音乐、播客或有声书时自动先提交当前播放位置再停掉前一个媒体源）。
  - 底栏与全局扩展播控展示书籍封面、书名、当前章节名、`chapter_position_ms / chapter_duration_ms`、`15s` 后退 / `30s` 前进、倍速选择器（`0.75x`–`2.5x`，记忆至个人听书进度）、睡眠定时（`15m`/`30m`/`45m`/`60m`/`本章结束`）及浮动章节/书签面板，且支持「打开伴读电子书」一键跳转。

---

### 阶段四：Android 端（Phone + Pad 自适应 · Room v3 · 阅读器与 Media3）

Android UI 需同时兼容手机（1080×1920）与平板（2560×1600）标准尺寸，严格遵循 [DESIGN.md](../../DESIGN.md) 尺寸、平板双栏骨架及 `MotionAssertions` 动效规范。

#### 4.1 持久化与离线缓存（`QueueDatabase` v2 → v3）

- 升级 [frontend/android/app/src/main/java/com/wildstring/app/data/QueueDatabase.kt](../../frontend/android/app/src/main/java/com/wildstring/app/data/QueueDatabase.kt) 至 `version = 3`（编写正式 `MIGRATION_2_3`，绝不使用破坏性重建丢弃用户既有队列与播客检查点）：
  - 新增本地表：`BookEntity`、`BookEbookChapterMetaEntity`、`BookAudiobookChapterEntity`、`BookProgressSyncEntity`（待提交的读/听 CAS 进度队列）、`BookAnnotationSyncEntity`（离线新增书签与 4 色批注待回传队列），阅读章节块 JSON 与缓存图片按文件存于应用专属 `filesDir/book_cache/` 并在退出或超额时 LRU 清理。

#### 4.2 Android 导航、书架与详情页

- 在「电台」顶栏加入分段切换 **`播客 | 书架`**，新增对应屏幕与 ViewModel 状态流：
  - **Phone**：单列/双列紧凑书架网格，点击进入详情页（展示可用载体、章节清单、个人书签批注与上传电子书入口 —— 若权限允许，使用系统文件选择器限制 `application/epub+zip` 与 `text/plain`）。
  - **Pad（平板宽屏）**：加载骨架必须匹配平板网格列数，禁止复用手机单列骨架；详情页与有声书章节面板采用自适应双栏与桌面式轻量右侧浮动抽屉，避免弹出章节面板时挤压左侧封面与正文画面造成闪动。
  - 若后端返回 `audio_upload_forbidden` 或文件挑选器返回音频 MIME，客户端本地亦先拦截并展示清晰原因与引导。

#### 4.3 Android Compose 双模式阅读器与动态交互

- 参考并扩展 [frontend/android/app/src/main/java/com/wildstring/app/ui/PodcastArticle.kt](../../frontend/android/app/src/main/java/com/wildstring/app/ui/PodcastArticle.kt) 的排版字体与阅读舒适区能力，构建独立 `BookReaderScreen`：
  - **上下滚动模式**：分块 `LazyColumn` + `SelectionContainer`/自定义长按划词手柄，通过首个可见 item + 行偏移反算 `(spine_index, block_index, char_offset)`。
  - **分页翻页模式**：纯 Kotlin 确定性分页器（基于 `TextMeasurer` 按实际内容区宽高、字号、行高与章节边界预分页，支持字号/主题/横竖屏变动后异步重算并基于锚点恢复准确页码）配合 `HorizontalPager`；支持左右点击区域翻页、滑动翻页及设置内可选音量键翻页。
  - **暖纸浅深独立主题 + 减少动态效果**：支持阅读器内独立切换暖纸浅色（`#F6F3ED`）与暖炭深色（`#181614`）；检测系统 Reduce Motion / 动画缩放关闭时，工具栏显隐与分页切换一帧到位。
  - **4 色划词批注与全书搜书**：长按选词菜单提供 `amber`、`terracotta`、`sage`、`stone` 四色高亮与随手笔记弹窗；目录/搜索/书签复用 Material3 自适应 `ModalBottomSheet`（Phone）与右侧浮动侧栏（Pad）。

#### 4.4 Android Media3 有声书播放隔离

- 在 `AudioPlaybackService` / 播放协调层中为有声书增加独立域状态（不干扰音乐播放列表 `QueueEntry` 与播客 `PodcastCheckpointRow`）：
  - 支持章节 `MediaMetadata`、通知栏与锁屏显示当前书名与章节名、跳转上下章、倍速调节（`PlaybackParameters`）、`15s`/`30s` 跳过、睡眠定时、蓝牙线控，并通过独立 CAS Worker 节流同步与离线断点续播。

---

### 阶段五：版本 `0.9.0a1` / `v0.9.0-alpha.1` 对齐与发布准备

核对 [scripts/package_release.py](../../scripts/package_release.py) 对 prerelease tag `v0.9.0-alpha.1` 的统一版本解析约束（执行阶段最后一个版本对齐提交完成）：

| 目标文件 | 现行值（基线） | `v0.9.0-alpha.1` 目标值 | 说明 |
| --- | --- | --- | --- |
| [backend/pyproject.toml](../../backend/pyproject.toml) | `0.8.27` | `0.9.0a1` | 同步执行 `uv lock` 更新 `backend/uv.lock` |
| [frontend/web/package.json](../../frontend/web/package.json) | `0.8.27` | `0.9.0-alpha.1` | 同步更新 `frontend/web/package-lock.json` 根版本号 |
| [frontend/android/app/build.gradle.kts](../../frontend/android/app/build.gradle.kts) | `versionCode = 63` / `0.8.27` | `versionCode = 64` / `0.9.0-alpha.1` | `versionCode` 必须严格大于前版 `63` |
| [frontend/macos/project.yml](../../frontend/macos/project.yml) | `0.8.27` / `62` | `MARKETING_VERSION: "0.9.0"` / `CURRENT_PROJECT_VERSION: "63"` | Apple `MARKETING_VERSION` 按 `package_release.py` 不带 prerelease 后缀，构建号严格递增 |
| [frontend/ios/project.yml](../../frontend/ios/project.yml) | `0.8.27` / `62` | `MARKETING_VERSION: "0.9.0"` / `CURRENT_PROJECT_VERSION: "63"` | 与 macOS 构建号保持同源规则并通过 XcodeGen 生成核验 |

- **既有热更新说明**：核实 [UpdatePolicy.kt](../../frontend/android/app/src/main/java/com/wildstring/app/update/UpdatePolicy.kt) 会在客户端侧跳过 `prerelease == true` 的 GitHub Release（`release_unstable`）；该行为可保留为正式渠道保护策略，并在发布 `v0.9.0-alpha.1` 时于 Release 说明中标注 Alpha 包需手动安装验证，不打断正式版通道用户。
- **发版文档入口**：在准备打 tag 提交前，按 [AGENTS.md](../../AGENTS.md) §1 同步更新中英文 README 最新版本、`docs/product/scope.md`、`CHANGELOG.md` 与 `docs/releases/v0.9.0-alpha.1.md`。

---

## 验收（按 AGENTS.md §3 定级）

本方案触及契约、SQLite Schema、后端多模块、Web、Android 双形态及版本号体系，按 [AGENTS.md](../../AGENTS.md) §3 定为 **L3 级验收**：

### 1. 修改前必须执行的现有测试与文案反查

- 实施修改前先运行 `git grep` 反查以下关键标识符与文案影响面，确保不破坏既有播客与电台功能：
  - `podcast_queue`、`PodcastCheckpoint`、`podcasts_dir`、`EXEMPT_PREFIXES`、`LibraryStorage`、`SCHEMA_VERSION`、`QueueDatabase`
- 任何调整了「电台」标题、空态文案、路由结构或导航元素的改动，必须同步反查并更新 Web / Android UI 自动化测试断言，确保 `make check` 零残留旧文案断言。

### 2. 后端自动化测试验收矩阵

- **迁移测试**：基于 [backend/tests/migration_support.py](../../backend/tests/migration_support.py) 构造 `v55` 库（含现有曲目、播客进度与多库数据），升级至 `v56` 验证无损迁移及索引生效。
- **上传与安全防御（核心红线）**：
  - `.epub`、`.txt`、图片封面上传成功并生成托管副本与 `book_cache`。
  - `.m4b`、`.mp3`、`.flac`、`.ogg`、`.m4a` 上传返回 `HTTP 422 audio_upload_forbidden`。
  - 将音频文件伪装改名为 `.epub` 或 `.txt` 上传（魔数欺骗）被流式探测器拦截，返回 `HTTP 422 audio_upload_forbidden`，且临时目录无残留文件。
  - 构造内嵌音频条目或超限嵌套（Zip Bomb / `../` 路径穿越 / `<script>` 标签 / `onerror=` 属性 / 外部 `href`）的 `.epub`：内嵌音频或非法路径包整体拒收；合法包内脚本与危险标签被 `defusedxml` + 白名单净化完全剥离，输出安全块 JSON。
  - 上传界面权限校验：`listener` 调用上传/扫描/合并/搜刮接口返回 `403`；跨用户查询进度、书签、批注返回各自独立隔离结果；访问未授权书库返回 `404`。
- **扫描、配对与章节解析**：
  - 只读目录扫描含 symlink 时被 `O_NOFOLLOW` 安全跳过且源目录文件零字节改动。
  - 同书 `.epub` + 多文件 `.mp3` / `.m4b` 自动配对成功，手动 `/pair` 与 `/split` 状态迁移正确。
  - `.m4b` 章节与多文件有声书章节总偏移 `start_book_ms` 精确无偏移，Range 流分片可正常 seek；UTF-8 / GB18030 `.txt` 长短文本分章与搜书返回准确偏移。
- **CAS 进度与元数据**：
  - 过期 `base_version` 后台心跳触发 `HTTP 409`，强意图 `seek` / `mode_switch` / `mark_complete` 正确覆盖；4 色批注非法枚举被拒绝；Mock 外部 HTTP 验证 `OpenLibrary` / `Google Books` / `Apple iTunes` 搜刮与 `locked_fields` 抗重扫覆写。

### 3. Web 与 Android 端验收（自动化 + 真机视觉 + 帧采样）

- **Web 端 E2E（隔离合成测试库）与视觉验收**：
  - 运行受影响模块与 Playwright 端到端测试，生成并在本地/CI 逐张查看 **桌面端 + 390px 手机端 × 浅色/深色主题** 截图：
    - 「电台 → 播客 | 书架」切换、书架 `Loading / Empty / Error` 状态与授权空态。
    - 上传 `.mp3`/`.m4b` 时的禁用态与清晰错误说明。
    - 书籍详情页（双载体、章节表、书签批注列表、元信息搜刮弹窗）长文案折行与按钮组对齐。
    - 阅读器全屏「上下滚动 ↔ 分页翻页」切换（验证锚点文字无跳动回归到同段首字）、浅深暖纸主题、目录/搜索/4 色划词批注及有声书浮动章节播放条（验证不覆盖或污染音乐/播客队列）。
- **Android 端构建、单测、设备回归与帧采样**：
  - 执行 `make android-ci`（构建、Lint、Kotlin/Room `MIGRATION_2_3` 与分页测量单测）。
  - 在本地 Android 基准模拟器（Phone `1080×1920` 与 Pad `2560×1600`，开启 `hw.keyboard = yes`）跑通关键路径并截图检查：
    - Pad 书架加载骨架（确认为多列平板网格而非手机骨架）、全屏或阅读器侧边章节浮层（不挤压主内容区导致闪动）。
    - 阅读器「上下滚动 ↔ `HorizontalPager` 分页翻页」切换、锚点保持、暖纸浅深色与 Media3 有声书播放。
  - **动画逐帧采样（L3 强制）**：使用 `MotionAssertions` 对 Android 端「工具栏显隐」与「平板章节抽屉弹出/收起」进行逐帧位置采样，确认在开启动画时连续且无二次跳动、在关闭动画时一帧到位，并令测试在旧实现/故意注入跳变时失败一次以验证判据有效。

### 4. 全局门禁命令

- `make check`、`make ci`、`make android-ci`、`make macos-test`（确认 Apple 端与新版本配置构建无破坏），必要时验证 `make docker-up docker-smoke`（确认容器挂载与权限无回归）以及 `scripts/package_release.py` 参数自检通过。

---

## 风险与回滚

1. **大体积 `.txt` 或畸形 `.epub` 阻塞扫描与阅读响应**：
   - 缓解：限制单本解压与章节尺寸阈值，解析与图片转码异步入队列并在首次读取时支持断点缓存；不合规或损坏书记录明确 `scan_error` 而不拖垮整批扫描任务。
2. **双模式阅读器（滚动 ↔ 分页）锚点漂移与跨设备窗口差异**：
   - 缓解：进度不存易变的像素/页码，统一以 `(spine_index, block_index, char_offset)` 作为唯一规范锚点，页码仅在各端本地实时推导；切模式前先冻结锚点再重排。
3. **误将有声书混入音乐库或 `podcast_queue` 引发统计污染**：
   - 缓解：`books_dir` 强制与 `libraries` / `podcasts_dir` 隔离校验；所有书架播放走独立 Session 与路由，严禁复用 `podcast_queue` 与 `playback_states`。
4. **prerelease 版本校验链不一致**：
   - 缓解：严格按照 `scripts/package_release.py` 对 `v0.9.0-alpha.1` 的五端规则同步提交版本文件与锁文件，并通过 `make check` / `make ci` 校验。
5. **回滚策略**：
   - 本批表结构与功能全部集中于新增表与 `books` 命名空间，不修改音乐曲库与播客既有核心表结构（`tracks`, `albums`, `podcast_feeds`, `podcast_episodes`, `podcast_queue`）；若 `0.9.0a1` 期间需紧急停用书架功能，可通过特性开关/路由下线或回退特性分支提交实现零数据损毁回滚（托管曲库与音乐/播客数据完全保留），Android 端在降级前亦可导出本地队列与已同步状态而不影响既有播客库。
