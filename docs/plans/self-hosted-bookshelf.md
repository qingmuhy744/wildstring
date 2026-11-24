状态：已确认

# 电台自托管书架与全库硬链接／.wildstring 侧车存储（0.9.0-alpha.1）

## 目标

在 WildString `0.9.0a1` / `v0.9.0-alpha.1` 中一次性落地两大核心能力（第一批覆盖规范契约、Python 后端、Web 端与 Android Phone/Pad 端）：

1. **统一书籍实体模型**：在「电台」模块下新增「书架」，单本 `Book` 可仅包含电子书（`.epub` / `.txt`）、仅包含有声书（带章节 `.m4b` 或多文件 `.mp3` / `.m4a` / `.flac` / `.ogg` / `.opus`），或同时配对两者（在「有声书 + 伴读电子书」场景下统一展示与管理，并保留同书自动配对及管理员手动合并/拆分）。
2. **「电台」内部导航整合与播放隔离**：在「电台」顶部分段切换「播客 | 书架」；有声书章节播放、倍速与进度体系独立运作，不进入 `podcast_queue`、音乐 `playback_states`、推荐系统与 Last.fm。
3. **只读多源扫描 + 电子书专属上传边界**：多书库支持从本地只读目录导入有声书与电子书；界面与 HTTP 上传接口严格只接收电子书（`.epub` / `.txt`）与封面图片，任何渠道上传音频文件均被服务端以 `HTTP 422 audio_upload_forbidden` 拒绝。
4. **按用户隔离的跨端进度与批注**：电子书阅读锚点 `(spine_index, block_index, char_offset)`、有声书位置 `(chapter_index, chapter_position_ms, book_position_ms, playback_rate)`、个人书签（支持电子书与音频时间戳）及 4 色暖调划词批注按 `user_id` 严格隔离，并通过版本 CAS 协议实现跨端同步。
5. **双模式安全电子书阅读器**：提供可无损切换的「上下滚动」与「分页翻页」阅读模式，服务端零脚本抽取净化并落盘章节块缓存；支持目录、全书搜索、字号/行高/字体切换以及独立暖纸浅色与暖炭深色主题。
6. **多源元数据提取与在线搜刮**：解析本地 OPF / `metadata.json` / `.wildstring/` / 音频标签与章节 / `reader.txt` / `desc.txt`，支持 `OpenLibrary`、`Google Books` 与 `Apple iTunes Search` 在线检索，覆写值与锁定字段只入库及同步至 `.wildstring/` 侧车，不改动源文件与媒体原件字节。
7. **音乐曲库与书库统一 `copy | hardlink` 双存储模式、`.wildstring/` 便携侧车与 `copy → hardlink` 存量迁移**：
   - 借鉴 MoviePilot 硬链接模式，为**所有音乐曲库与书库**提供 `copy`（独立副本，默认）与 `hardlink`（硬链接保种，库级可选）两种存储模式；
   - 在托管目录中维护 `.wildstring/` 隐藏元数据侧车文件夹，导出并存储精修后的公共作品元数据、封面、歌词与有声书章节信息；当用户分享带有 `.wildstring/` 的专辑或书籍目录时，新实例可直接按文件 `sha256` 读取恢复元数据，实现零重复刮削、零双倍磁盘空间与 100% PT 保种安全；
   - 支持将既有 `copy` 模式的音乐曲库或书库**显式迁移为 `hardlink` 模式**（支持同卷原地重新硬链释放空间，以及跨路径迁往与源同挂载盘并同步转为硬链接）。

相关基线规范与现行代码参考：[AGENTS.md](../../AGENTS.md)、[DESIGN.md](../../DESIGN.md)、[docs/product/scope.md](../product/scope.md)、[contracts/multiple-libraries.md](../../contracts/multiple-libraries.md)、[contracts/managed-library.md](../../contracts/managed-library.md)、[contracts/library-management.md](../../contracts/library-management.md)、[contracts/podcast-progress.md](../../contracts/podcast-progress.md)、[contracts/podcast-queue.md](../../contracts/podcast-queue.md)、[contracts/playback-transcoding.md](../../contracts/playback-transcoding.md)、[contracts/metadata-providers.md](../../contracts/metadata-providers.md) 与 [contracts/storage-and-podcast-resources.md](../../contracts/storage-and-podcast-resources.md)。

---

## 不碰的边界

1. **禁止 AI 书籍衍生功能**：本批不做 AI 阅读摘要、剧透安全回顾、AI 问答、TTS 合成朗读以及任何 MCP 书籍工具；现有音乐/播客基础播放不得因书架或存储升级受损。
2. **禁止网页或上传接口接收音频文件**：`POST /api/v1/books/upload` 与 `POST /api/v1/books/{book_id}/ebook` 只能上传电子书或绑定电子书，禁止直接上传 `.m4b` / `.m4a` / `.mp3` / `.flac` / `.ogg` / `.opus` 等音频，也禁止 `.epub` 内嵌音频条目。有声书只能通过管理员配置的本地只读扫描源导入。
3. **硬链接绝不触碰原文件字节，且跨卷绝不静默退回复制**：
   - 导入源绝对只读且拒绝 symlink（`O_NOFOLLOW`）；
   - 在 `hardlink` 模式下（或检测到托管文件 `st_nlink > 1` 时），代码层强制锁定音频与电子书文件为不可变字节，任何标签写回、封面内嵌或内容改写必须拒绝触碰媒体字节；
   - 创建、切换或迁移至 `hardlink` 模式时若 `source_roots` 与 `managed_root` 不在同一文件系统（`st_dev` 不匹配 / `EXDEV` / `EROFS` / `EPERM`），必须**直接报错**提示调整同盘或同挂载卷路径，**严禁静默退回 `copy` 模式**；
   - `.wildstring/` 只写进授权的 `managed_root` 内部，**绝对不写入只读 `source_roots`**。
4. **`.wildstring/` 导出与导入双向零隐私、零脚本边界**：
   - 无论**导出生成**还是**导入解析**，`.wildstring/` 均视为对外可分享、对内不可信的数据交换载体：**只允许包含公共作品元数据**（标题、作者/艺人/专辑艺人/演播者、专辑/系列与序号、发行年份/语言/ISBN/外部 ID、有声书章节表、`track_lyrics` 同级导出 `.lrc` 歌词、经 Pillow 解码校验重编码的封面以及触发匹配用的文件 `sha256`）；
   - **导出时即严格剔除、导入时亦彻底忽略/拒绝**：任何 `user_id`、账号名、个人播放次数、红心收藏状态、歌单、个人阅读/收听进度、个人书签、个人划词批注、宿主机/容器物理路径（`source_root` / `managed_root`）、认证凭据、插件配置或任意可执行脚本/HTML。
5. **不将正文或音频正文大字段塞入 SQLite**：SQLite 只存书籍索引、章节目录元数据、锚点进度、书签和划词批注；解析后的 `.epub` / `.txt` 规范化块 JSON 与提取图片落盘至 `<data_dir>/book_cache/<book_id>-<sha256[:16]>/`，避免 WAL 检查点与客户端 Room 数据库膨胀。
6. **不执行书籍内嵌脚本或外部 CSS/外链**：Web 与 Android 端均严禁直接把未经净化的 EPUB HTML 交给 `dangerouslySetInnerHTML`、`WebView`（带 JS）或未过滤加载外部资源；阅读器只消费后端抽取后的安全语义块协议。
7. **Batch 1 客户端边界**：本批实现 Backend、Web 与 Android（Phone + Pad）；macOS 与 iOS 原生书架 UI 留待下一批，但必须保证 `0.9.0a1` 后端保持向后兼容，且 [scripts/package_release.py](../../scripts/package_release.py) 对五端版本号与构建号校验完整通过。

---

## 方案

### 阶段一：契约设计、目录边界、权限与 SQLite Schema v56

#### 1.1 契约与权限扩展

- 新建契约文档 `contracts/bookshelf.md` 与 `contracts/wildstring-sidecar.md`，同步修订 [contracts/managed-library.md](../../contracts/managed-library.md)、[contracts/library-management.md](../../contracts/library-management.md) 与 [contracts/storage-and-podcast-resources.md](../../contracts/storage-and-podcast-resources.md)，明确定义：
  - `copy | hardlink` 双存储模式、同文件系统探针与跨卷报错码；
  - `.wildstring/` 侧车目录结构、导出触发机制与双向无隐私字段白名单、音频 `sha256` 绑定校验及冲突优先级；
  - `copy → hardlink` 存量迁移 API、状态机与统计字段；
  - 书籍实体模型、电子书块级渲染协议、仅电子书上传校验错误码及 CAS 进度载荷。
- 同步更新 [docs/product/scope.md](../product/scope.md)，补全「电台 · 书架」及统一存储模式能力入口（发版时再对齐两份 README 与 `CHANGELOG.md`）。
- 扩展 [backend/src/wildstring/permissions.py](../../backend/src/wildstring/permissions.py) 中 `PROFILES` / `PROFILE_SCOPES`：
  - 新增 scope：`books:read`、`books:write`、`books:upload_ebook`、`books:manage_libraries`、`books:scrape_metadata`。
  - 默认角色分配：`owner` 与 `librarian` 拥有全部书籍管理、上传及导出 `.wildstring/` 权限；`editor` 拥有元信息编辑/搜刮及个人读写权限；`listener` 仅对授权书库拥有只读访问及本人进度/书签/批注读写权限；涉及存储模式切换与 `copy → hardlink` 存储迁移沿用 `owner` 最高权限边界。

#### 1.2 存储目录隔离与访问控制

- 修改 [backend/src/wildstring/library/storage.py](../../backend/src/wildstring/library/storage.py) 中的 `LibraryStorage`：
  - 书库默认托管目录位于 `<data_dir>/books/<library_id>`，同时支持管理员建库时通过 `LibraryStorage.destination` 指定同挂载卷自定义绝对路径（例如 Docker 下统一挂载 `/media`，源位于 `/media/downloads/books`，托管位于 `/media/wildstring/books`），使音乐曲库与书库均可真正满足同卷硬链接条件；解析缓存固定位于 `<data_dir>/book_cache`。
  - 更新 `LibraryStorage.available` 与根目录重叠检查：将 `book_libraries.managed_root`、`book_library_sources.root`、`book_library_migrations`（`queued`/`running`/`completed`）与音乐 `libraries`、`library_sources`、`library_migrations`、`podcasts_dir`、`web_dir` 全部纳入统一交叉校验集，禁止任意目录互相包含或重叠。
- 修改 [backend/src/wildstring/library/access.py](../../backend/src/wildstring/library/access.py)：
  - 将 `/api/v1/books` 与 `/api/v1/book-libraries` 纳入认证后由书籍模块自主按 `(user_id, book_library_id)` 执行授权隔离；对于无权访问或不存在的书籍/章节/缓存图片/音频流，统一返回 `HTTP 404`（遵循 [contracts/multiple-libraries.md](../../contracts/multiple-libraries.md) 不泄露未授权资源存在性）。

#### 1.3 SQLite Schema v55 → v56

在 [backend/src/wildstring/database.py](../../backend/src/wildstring/database.py) 将 `SCHEMA_VERSION` 从 `55` 升至 `56`，并同步在 [backend/tests/migration_support.py](../../backend/tests/migration_support.py) 补充旧库迁移测试构造：

1. **现有音乐表增量扩展（向后兼容旧记录默认 `'copy'`，同批修改裸列插入）**：
   - `libraries`：新增 `storage_mode TEXT NOT NULL DEFAULT 'copy' CHECK(storage_mode IN ('copy', 'hardlink'))`
   - `imported_files`：新增 `link_mode TEXT NOT NULL DEFAULT 'copy' CHECK(link_mode IN ('copy', 'hardlink', 'generated', 'managed_only'))`。
   - **同批强制修复**：当前 [importer.py](../../backend/src/wildstring/library/importer.py) 与 [upload.py](../../backend/src/wildstring/library/upload.py) 均使用省略列名的 7 列 `INSERT OR REPLACE INTO imported_files VALUES (?,?,?,?,?,?,?)`；必须在升至 `v56` 的**同一批改动**中改为显式 8 列列表 `(source_root, source_path, target_root, target_path, source_size, source_mtime, sha256, link_mode)`，并同步回归验证新库初始化、`v55` 原库升级（既有行默认 `'copy'`）及升级后的音乐导入与网页上传链路。
   - `library_migrations`：新增 `target_storage_mode TEXT CHECK(target_storage_mode IN ('copy', 'hardlink'))`、`relinked_files INTEGER NOT NULL DEFAULT 0`、`reclaimed_bytes INTEGER NOT NULL DEFAULT 0`、`kept_standalone_files INTEGER NOT NULL DEFAULT 0`、`sidecars_written INTEGER NOT NULL DEFAULT 0`；放宽允许同库在目标模式变化时的原地模式迁移（`target_root == source_root` 且 `target_storage_mode IS NOT NULL`）。
2. **书库、单一来源表、托管路径与迁移**：
   - `book_libraries`：`id`, `name`, `managed_root`, `storage_mode`（`'copy' | 'hardlink'`）, `default_access`（`all` | `restricted`）, `auto_pair`（默认 1）, `version`, `created_at`, `updated_at`
   - `book_library_sources`：`library_id`, `id`, `root`, `watch_enabled`（完全沿用 [catalog.py](../../backend/src/wildstring/library/catalog.py) 中 `library_sources` 的单一数据源表设计，不另存重复的 `source_roots_json`）
   - `book_library_access`：`(library_id, user_id, granted_by, created_at)` 联合主键
   - `book_library_migrations`：镜像 `library_migrations` 结构与迁移统计列（`source_root`, `target_root`, `target_storage_mode`, `copied_files`, `relinked_files`, `reclaimed_bytes`, `kept_standalone_files`, `sidecars_written`, `status`, `error` 等），与音乐库共用同一套存储安全校验与锁契约。
3. **书籍主表与载体子表**：
   - `books`：`id`, `library_id`, `managed_dir`, `title`, `sort_title`, `subtitle`, `authors_json`, `narrators_json`, `series_name`, `series_index`, `publisher`, `published_year`, `language`, `isbn10`, `isbn13`, `description`, `tags_json`, `cover_path`, `cover_hash`, `has_ebook`, `has_audiobook`, `pair_key`, `overrides_json`, `locked_fields_json`, `created_at`, `updated_at`
   - `book_ebooks`：`id`, `book_id`（唯一外键）, `format`（`epub` | `txt`）, `managed_path`, `source_path`, `link_mode`（`copy` | `hardlink` | `managed_only`）, `file_size`, `sha256`, `encoding`, `spine_count`, `total_chars`, `cache_key`, `parsed_at`
   - `book_ebook_chapters`：`(book_id, spine_index)`、`href`, `title`, `level`, `block_count`, `char_count`, `start_global_char`
   - `book_audiobooks`：`id`, `book_id`（唯一外键）, `is_multi_file`, `total_duration_ms`, `chapter_count`, `total_bytes`, `codec_summary`, `created_at`
   - `book_audiobook_files`：`(book_id, file_index)`、`managed_path`, `source_path`, `link_mode`（`copy` | `hardlink`）, `relative_name`, `duration_ms`, `codec`, `bitrate`, `sample_rate`, `channels`, `file_size`, `sha256`, `start_book_ms`
   - `book_audiobook_chapters`：`(book_id, chapter_index)`、`file_index`, `title`, `start_file_ms`, `end_file_ms`, `start_book_ms`, `duration_ms`
4. **扫描与个人状态表（全部按 `user_id` 隔离）**：
   - `book_scan_jobs`：`id`, `library_id`, `status`, `scanned_files`, `added_books`, `updated_books`, `paired_books`, `sidecars_applied`, `error_message`, `started_at`, `finished_at`
   - `book_reading_progress`：`(user_id, book_id)`、`spine_index`, `block_index`, `char_offset`, `chapter_title`, `overall_ratio`, `reading_mode`（`scroll` | `paginated`）, `completed`, `version`, `session_id`, `device_id`, `updated_at`
   - `book_listening_progress`：`(user_id, book_id)`、`chapter_index`, `chapter_position_ms`, `book_position_ms`, `playback_rate`, `completed`, `version`, `session_id`, `device_id`, `updated_at`
   - `book_bookmarks`：`id`, `user_id`, `book_id`, `kind`（`ebook` | `audio`）, `spine_index`, `block_index`, `char_offset`, `chapter_index`, `position_ms`, `excerpt`, `note`, `created_at`, `updated_at`
   - `book_annotations`：`id`, `user_id`, `book_id`, `spine_index`, `start_block_index`, `start_char_offset`, `end_block_index`, `end_char_offset`, `selected_text`, `note`, `color`（`amber` | `terracotta` | `sage` | `stone`）, `created_at`, `updated_at`

---

### 阶段二：全库 `copy | hardlink` 双模式、`.wildstring/` 侧车与 `copy → hardlink` 迁移（音乐 + 书架）

#### 2.1 同文件系统预检与 `link_exclusive` 核心发布原语

- **同文件系统与硬链接可用性预检**：
  - 在 [backend/src/wildstring/library/catalog.py](../../backend/src/wildstring/library/catalog.py)、[backend/src/wildstring/library/storage.py](../../backend/src/wildstring/library/storage.py) 与书籍库服务中新增共享校验器 `validate_hardlink_capability(source_roots, managed_root)`：
    1. `st_dev` 仅作为跨卷初筛：校验每个 `source_root` 与 `managed_root`（不存在则向上追溯已存在父目录）位于相同内核设备 `st_dev`；若不同设备直接抛出 `HTTP 422 hardlink_cross_device`，返回提示包含 Docker/NAS 同父目录挂载说明（如源与托管目录均放在同一个 `/media` 挂载下），绝不回退复制；
    2. **基于真实源文件的只读硬链接权限探针**：遍历定位 `source_root` 下具有代表性的现存普通文件（全程以 `O_NOFOLLOW` 只读打开，绝不向 `source_root` 写入任何探测文件或修改源句柄），向 `managed_root` 内创建临时硬链接并在校验后立即 `unlink` 删除，精确拦截只读挂载目标 `EROFS` 与 Linux `fs.protected_hardlinks=1` 跨属主权限不足 `EPERM`（统一返回 `HTTP 422 hardlink_not_supported`）；若新库启用时 `source_root` 暂为空目录尚无现存文件，则在通过 `st_dev` 与 `managed_root` 可写检查后放行，并在首个真实文件导入/扫描时强制触发硬链接校验、同样绝不退回复制。
- **扩展 [backend/src/wildstring/library/import_files.py](../../backend/src/wildstring/library/import_files.py)**：
  - 新增 `link_exclusive(source, root: Path, relative: Path, expected: str | None = None) -> str`：
    1. 在读取前记录源句柄 `fingerprint(os.fstat(source.fileno()))`，流式校验 `sha256`；
    2. 通过 `target_directory` 无 symlink 穿越定位目标父目录描述符；
    3. 复检源稳定性后优先执行目录描述符相对路径硬链接（遵循 `follow_symlinks=False` 且目标已存在时不覆盖：`FileExistsError` 由调用方按冲突或去重处理）；
    4. 若系统返回 `EXDEV` / `EROFS` / `EPERM` 等错误，明确失败报告（`hardlink_cross_device` / `hardlink_not_supported`），不静默转换为拷贝。
  - **音乐库 [importer.py](../../backend/src/wildstring/library/importer.py) & [intake.py](../../backend/src/wildstring/library/intake.py) 接入**：
    - `storage_mode == "hardlink"` 时，直通音频（`FLAC`/`MP3`/`M4A`）与同源常规 `.lrc`/封面通过 `link_exclusive` 发布（`link_mode = 'hardlink'`）；
    - `Intake` 中需要生成新音频字节的**自然例外**——`WAV → FLAC` 转码与 `CUE` 整轨拆轨——继续输出到新音频并以 `copy_exclusive` 发布（`link_mode = 'generated'`），不影响原做种 WAV，同时 `Intake.stage()` 在源与暂存区同 `st_dev` 时直接硬链接暂存，消除整轨文件暂存期 `size * 2` 额外磁盘占用；
    - 通过网页 [upload.py](../../backend/src/wildstring/library/upload.py) 或电子书上传接口上传的文件没有外部做种源，统一以 `copy_exclusive` 落盘并记为 `link_mode = 'managed_only'`。
    - [file_reorganizer.py](../../backend/src/wildstring/library/file_reorganizer.py) 的单曲重组织（`reorganize_track_file`）在重命名路径时使用同挂载内目录项移动（`os.replace`/硬链接新路径后解绑旧路径），仅修改目录项、不改写内容字节，并同步迁移/刷新 `.wildstring/` 侧车。

#### 2.2 `.wildstring/` 隐藏侧车格式、导出时机与分享导入边界

新建共享模块 `backend/src/wildstring/library/sidecar.py`，音乐与书架统一复用同一套读写与校验引擎（详见新增契约 `contracts/wildstring-sidecar.md`）：

1. **目录结构（严格仅存在于 `managed_root` 内部）**：
   - **音乐专辑目录** `<managed_root>/<artist>/<album>/.wildstring/`：
     - `manifest.json`（`schema = "wildstring.sidecar.music.v1"`）：专辑级有效覆写（`album`、`album_artists`、`locked_fields`、`cover_file`、`cover_sha256`、`external_ids`）与按**音频 `sha256`** 索引的曲目列表 `tracks`（`sha256`、`title`、`artists`、`album_artists`、`track_number`、`disc_number`、`credits`、`external_ids`、`lyric_file`、`locked_fields`）。
     - `cover.jpg`：由当前库生效封面（手动上传、来源选图或提取封面）经 Pillow 重编码校验生成的规范 JPEG，与其 `cover_sha256` 绑定。
     - `lyrics/<sha256>.lrc`：导出库内 `track_lyrics` 中由用户精修/打点/筛选保存的有效歌词内容（UTF-8 纯文本）。
   - **书籍目录** `<book_managed_root>/<book_dir>/.wildstring/`：
     - `manifest.json`（`schema = "wildstring.sidecar.book.v1"`）：公共书目信息（`title`、`sort_title`、`subtitle`、`authors`、`narrators`、`series_name`、`series_index`、`publisher`、`published_year`、`language`、`isbn10`、`isbn13`、`description`、`tags`、`external_ids`、`locked_fields`、`cover_file`、`cover_sha256`）、电子书条目 `ebook`（`format`、`sha256`、章节校对标题覆盖 `toc_overrides`）及有声书条目 `audiobook`（文件列表含 `sha256` 与 `chapters` 校对表）。
     - `cover.jpg`：经 Pillow 校验重编码后的书籍封面。

2. **强制无隐私白名单序列化**：
   - 导出端使用固定 Pydantic 输出模型只序列化上述作品级公共字段：绝不读取、拼接或写入 `users`、`user_track_state`、`playlists`、`listening_sessions`、`book_reading_progress`、`book_listening_progress`、`book_bookmarks`、`book_annotations` 以及任何本机物理路径（`source_root`、`managed_root`、`absolute_path`）。
   - 写入原子性：所有侧车文件均写入 `.wildstring/` 内临时文件、`fsync` 落盘后再 `os.replace`，目录句柄全程 `O_NOFOLLOW`。

3. **导出触发与批量刷新**：
   - **增量自动同步**：每当管理员或编辑者在音乐端保存单曲/批量元数据覆写（`track_metadata`）、保存歌词（`track_lyrics`）、应用元数据来源候选、上传或切换封面（[artwork.py](../../backend/src/wildstring/library/artwork.py)）、执行 `reorganize_track_file`，或在书架端保存元数据/搜刮覆写/封面/章节编辑时，异步或事务后立即刷新对应 `.wildstring/`（无任何自定义覆写、无额外歌词且无自定义封面的纯净目录可按需跳过或清理空 `.wildstring/`）。
   - **迁移自动刷新**：执行 `copy → hardlink` 迁移前自动将该库历史全部已编辑/已匹配元信息全量落入 `.wildstring/`，记录 `sidecars_written`。
   - **手动全量导出入口**：`POST /api/v1/manage/export-sidecars`（音乐库）与 `POST /api/v1/book-libraries/{library_id}/export-sidecars`（书库），供分享或迁移备份前一键全量导出。

4. **分享导入读取、安全校验与扫描器兼容性**：
   - **安全校验**：把任何来自 `source_roots` 的 `.wildstring/` 视为**不可信外部输入**——必须用 `O_NOFOLLOW` 验证目录与内部文件均非 symlink；限制 `manifest.json` 体积上限 `2 MiB`、封面上限 `MAX_COVER_BYTES`、歌词上限 `MAX_TEXT_BYTES`；严格过滤非预期键与脚本标签，禁止任意相对路径（`lyrics/<sha256>.lrc` 仅匹配合法 64 位小写 hex + 规范安全相对检查，封面需通过 Pillow 解码重编码，拒绝 SVG/HTML）；**只有当条目中的音频/电子书 `sha256` 与实际导入文件哈希严格一致时，才导入该条目的元信息/歌词/章节，防止错配**。
   - **扫描器避坑守卫**：[management.py](../../backend/src/wildstring/management.py)、[importer.py](../../backend/src/wildstring/library/importer.py)、[intake.py](../../backend/src/wildstring/library/intake.py) 与书籍扫描器继续跳过其它 `.` 开头隐藏目录/文件，仅在识别媒体专辑/书籍目录时白名单读取同级精确目录名 `.wildstring`；**尤其要在 [scanner.py](../../backend/src/wildstring/library/scanner.py) (`scan_library`) 遍历候选音频文件时把 `.wildstring` 从 `folders[:]` 剪枝**，确保 `.wildstring/` 内的 `.json` / `.lrc` / `.jpg` 不会推高音频扫描的 `counts["skipped"]`，同时允许重建/重扫托管库时从 `.wildstring/` 无损恢复数据库覆写、锁定字段、歌词和封面。
   - **四级优先级合并**：`本实例数据库已锁定覆写 (locked_fields)` ＞ `目录内 .wildstring/ 侧车（sha256 精确匹配）` ＞ `传统旁路文件 (metadata.opf / metadata.json / 同名 .lrc / cover.*)` ＞ `媒体文件内嵌标签`。

#### 2.3 既有 `copy → hardlink` 迁移与双向转换（音乐 + 书架）

扩展 [backend/src/wildstring/library/storage.py](../../backend/src/wildstring/library/storage.py) 中的 `POST /api/v1/libraries/{library_id}/migrations` 迁移管线，并为书库实现同契约的 `POST /api/v1/book-libraries/{library_id}/migrations`：

- 请求参数扩展为 `{version: int, managed_root?: str, target_storage_mode?: "copy" | "hardlink"}`（至少改变目录或存储模式之一，版本过期返回 `409 library_version_conflict`）：
  1. **场景 A：同路径原地 `copy → hardlink` 释放双倍空间**（`managed_root` 不变或省略，且当前 `managed_root` 已与 `source_roots` 处于同一设备 `st_dev`）：
     - 预检同设备与硬链接可行性，并先行触发一次 `.wildstring/` 元数据导出保证历史编辑零丢失；
     - 建立当前库所有 `source_roots` 的 `(sha256, st_ino)` 索引（优先参考 `imported_files` / `book_*` 源映射记录验证，若原路径改名则用源根下同哈希匹配）；
     - 遍历托管文件：对源文件中存在 `sha256` 完全一致且 `st_ino` 尚未对齐源文件的副本，在同目录以 `os.link` 生成临时硬链接 `.wildstring-relink-<uuid>`，校验哈希一致后 **`os.replace` 原子替换**既有独立副本——正在播放中的文件描述符继续读取原 inode 不被中断、对外部读访问无任何空窗，替换完成瞬间系统自动释放重复占用的磁盘块，累计 `relinked_files` 与 `reclaimed_bytes`；
     - **跳过 `os.utime`（严禁改写源 inode 时间戳）**：[storage.py](../../backend/src/wildstring/library/storage.py) 现有复制迁移在写入目标后调用 `os.utime` 同步修改时间；但在一切 `hardlink` 分支（含原地重链与跨目录直链）中**必须显式跳过 `os.utime`**，因为硬链接与做种源文件共用同一底层 inode，对目标调用 `os.utime` 会直接篡改只读源文件的元数据时间戳；
     - **中断续跑与幂等校验**：由于 `os.replace` 仅保证单文件原子替换，若在原地切换中途发生进程重启或崩溃，重试/恢复流程（`retry` / 启动恢复）必须基于 `(target.st_ino == source.st_ino 且 sha256 一致)` 识别已成功硬链接的文件、按已重链处理而不报错或重复计费，并同步修正 `imported_files.link_mode`（或书库子表 `link_mode`）及 `relinked_files` / `reclaimed_bytes` / `kept_standalone_files` 统计，保证中断前后的磁盘物理状态与数据库最终完全一致；
     - 对找不到源文件的独立条目（例如网页端上传、CUE 切轨/WAV 转 FLAC 衍生文件、或外部做种源已被用户清理），**安全保留原托管副本**标记 `link_mode = 'managed_only' | 'generated'` 并计入 `kept_standalone_files`；
     - 事务内切换 `libraries.storage_mode = 'hardlink'`（或 `book_libraries.storage_mode = 'hardlink'`）并刷新 `imported_files.link_mode`。
  2. **场景 B：跨路径搬迁 + 转为 `hardlink` 一步完成**（解决默认 `/data/library` 需迁往与源盘同卷的 `/media/wildstring/library`）：
     - 要求目标 `managed_root` 与 `source_roots` 通过同设备及空目录预检；
     - 先刷全库 `.wildstring/` 侧车；迁移期间命中源 `sha256` 的文件直接从源文件通过 `link_exclusive` 链接至新 `managed_root`（**同样跳过 `os.utime`**，新位置瞬间建立且**几乎零额外磁盘增长**），同时将 `.wildstring/` 与独立文件（网页上传/转码衍生）同步至新位置并核验树完整；
     - 原子切换数据库内 `root`、`storage_mode = 'hardlink'` 及 `imported_files` 映射，原有旧目录按既有存储迁移契约暂留以供管理员核对确认后回收。
  3. **场景 C：反向 `hardlink → copy` 解耦独立**：
     - 允许管理员后续从 `hardlink` 切回独立副本 `copy`：执行前用 `shutil.disk_usage` 核算目标卷剩余空间必须充足（否则报错 `422 insufficient_storage`），然后将 `st_nlink > 1` 文件逐个写出独立副本、`fsync` 并 `os.replace` 解耦硬链接关系，最后更新 `storage_mode = 'copy'`。

---

### 阶段三：后端书架模块与核心业务接口

建议书架核心模块收敛于新包 `backend/src/wildstring/books/`（`router.py`, `scanner.py`, `ebook_parser.py`, `audiobook.py`, `upload.py`, `progress.py`, `metadata.py`, `providers.py`, `service.py`），并注册进主 FastAPI 应用入口。

#### 3.1 只读多源扫描、目录识别与同书自动配对

- **扫描器识别规则**（`scanner.py`）：
  - 遍历授权 `source_roots`，对每个文件或目录使用 `O_NOFOLLOW` 校验，发现 symlink 一律跳过并记录告警，绝不跨越读出外部路径。
  - 若目标书库为 `hardlink` 模式，直通的 `.m4b`/`.mp3`/`.flac`/`.ogg`/`.opus` 与 `.epub`/`.txt` 通过 2.1 的 `link_exclusive` 链入 `<managed_root>/<book_dir>/`；`copy` 模式走 `copy_exclusive`。
  - **单目录优先判定 + `.wildstring/` 还原**：含音频文件的叶目录（或含 `.wildstring/manifest.json`、`metadata.json`、`metadata.opf` 的目录）归组为一本有声书候选；目录中同时存在 `.epub` / `.txt` 与有声书时直接配对进同一本 `Book`；若源目录带有分享而来的 `.wildstring/`，校验对应音频/电子书文件 `sha256` 后直接加载公共书目、封面及校对章节。
  - **跨目录同库自动配对**：当启用 `book_libraries.auto_pair` 时，基于规范化 `pair_key = normalize(author) + "::" + normalize(title)`（去除全半角空格、副标题括号及 `v2`/`典藏版`/`有声版` 等常见修饰）在同一个 `library_id` 内自动合并仅含电子书与仅含有声书的候选为统一 `Book`；存在歧义时保持独立等待人工处理。
- **手动关联与拆分接口**：
  - `POST /api/v1/books/{book_id}/pair` 与 `POST /api/v1/books/{book_id}/split`（拆分或配对后自动更新对应 `.wildstring/` 侧车）。

#### 3.2 有声书章节提取与范围流/转码

- 复用 [backend/src/wildstring/library/metadata.py](../../backend/src/wildstring/library/metadata.py) 与 [backend/src/wildstring/library/conversion.py](../../backend/src/wildstring/library/conversion.py) 模式（`audiobook.py`）：
  - 单文件 `.m4b` / `.m4a` 使用 `mutagen.mp4.MP4.chapters` 读取内嵌章节表，`ffprobe -show_chapters -of json` 兜底；单文件 `.mp3` 读取 ID3 `CHAP`/`CTOC` 帧；多文件按 `track` tag + 自然序排列；若有 `.wildstring/` 校对章节覆盖则按规则优先采用。
- 复用 [backend/src/wildstring/library/streaming.py](../../backend/src/wildstring/library/streaming.py) HTTP Range 响应机制，提供 `GET /api/v1/books/{book_id}/audiobook/files/{file_index}/stream`（支持范围拖动、按 [contracts/playback-transcoding.md](../../contracts/playback-transcoding.md) 兼容可选转码，不改动源字节）。

#### 3.3 安全零脚本电子书解析与 `book_cache`

- **EPUB 安全解析**（`ebook_parser.py`）：
  - `zipfile` 严格限制大小与条目阈值（如单压缩包上限 `256 MiB`、解压总上限 `512 MiB`、条目数上限 `5000`），拒绝 `..` / 前导 `/` 路径穿越与 ZIP symlink 位。
  - **内嵌音频零容忍校验**：解压前即遍历全部 ZIP 条目扩展名与魔数及 OPF `<manifest>` `media-type`，发现任何 `audio/*` 或音视频载荷整包拒绝。
  - 全部 XML 使用 `defusedxml` 解析；将 XHTML 归约为白名单安全 JSON 块数组（含 `block_index`, `tag`, `runs`, `text`, `char_len`, `image_key`），提取图片经格式与像素检查后存至 `book_cache/<cache_key>/images/` 并经 `GET /api/v1/books/{book_id}/ebook/assets/{asset_path}` 鉴权提供。
- **TXT 解析**：探针支持 `utf-8-sig` → `utf-8` → `gb18030` → `big5` → `utf-16`，智能分章并按约 `12,000` 字符平衡切片。
- **阅读器只读接口**：`GET /api/v1/books/{book_id}/ebook/manifest`、`GET /api/v1/books/{book_id}/ebook/chapters/{spine_index}`、`GET /api/v1/books/{book_id}/ebook/search?q=...`、`GET /api/v1/books/{book_id}/ebook/download`。

#### 3.4 电子书专属上传边界（`HTTP 422 audio_upload_forbidden`）

复用 [backend/src/wildstring/library/upload.py](../../backend/src/wildstring/library/upload.py) 流式写临时文件模式新建 `books/upload.py`：

- 仅暴露 `POST /api/v1/books/upload`、`POST /api/v1/books/{book_id}/ebook`、`POST /api/v1/books/{book_id}/cover`（上传文件作为平台自有托管写入 `link_mode = 'managed_only'`）：
  1. 扩展名白名单仅允许 `.epub` / `.txt`（书籍）及 `.jpg` / `.jpeg` / `.png` / `.webp`（封面）；拒绝一切音频扩展名；
  2. 拒绝任何 `audio/*` / `video/*` MIME；
  3. 流式首块 4 KiB 魔数检测（`ID3`、`fLaC`、`OggS`、`RIFF....WAVE`、MP4 音频 `ftyp`、ADTS/MPEG `0xFFEx`），命中立即终止并删临时文件；
  4. `.epub` ZIP 容器内扫描音频条目或音频 `manifest` 载荷，发现即删包拒收。
- 所有音频拒绝均返回 **`HTTP 422 audio_upload_forbidden`**（其余不支持文档如 `.pdf` 返回 `HTTP 422 unsupported_ebook_format`）。

#### 3.5 个人进度 CAS、书签、批注与元数据搜刮

- **双通道 CAS 进度同步**（`progress.py`）：`GET / PUT /api/v1/books/{book_id}/reading-progress` 与 `GET / PUT /api/v1/books/{book_id}/listening-progress`，复刻 [contracts/podcast-progress.md](../../contracts/podcast-progress.md) `session_id` / `device_id` / `base_version` / `sequence` / `intent` 机制（过期心跳返回 `409`，结尾自动完成规则一致）。
- **个人书签与批注 CRUD**：`/api/v1/books/{book_id}/bookmarks` 与 `/api/v1/books/{book_id}/annotations`（仅限定当前登录 `user_id`，批注颜色仅限 `amber` / `terracotta` / `sage` / `stone`）。
- **元信息与在线搜刮**（`metadata.py`, `providers.py`）：支持 **`openlibrary`**、**`google_books`**、**`itunes`**（遵循 [contracts/metadata-providers.md](../../contracts/metadata-providers.md) SSRF 防护与节流），应用后写入 `books.overrides_json` + `locked_fields_json` **并自动同步更新该书 `.wildstring/` 侧车**（绝不写回原媒体文件）。

---

### 阶段四：Web 端 UI、安全阅读器、有声书播放与存储/侧车管理

所有色彩、间距、字号层级、等宽数字（`tabular-nums`）与减少动态效果严格遵循 [DESIGN.md](../../DESIGN.md)。

#### 4.1 「电台 → 书架」与管理员控制面

- 改造 [frontend/web/src/podcasts.tsx](../../frontend/web/src/podcasts.tsx) 等电台壳层，增加分段切换器 **`播客 | 书架`**；新增 `bookshelf.tsx`、`book-detail.tsx`：
  - 书架列表筛选（载体、阅读状态、搜索）、置顶继续栏、明确载体角标，严格提供 `Loading / Empty / Error / 权限不足` 边界状态；
  - 上传对话框前端限定 `accept=".epub,.txt,application/epub+zip,text/plain"`，拦截音频文件并展示平静提示；
  - 书籍详情支持双载体操持、独立章节/书签/批注面板、管理员合配/拆分以及 OpenLibrary / Google Books / Apple iTunes 在线搜刮字段应用（附注修改仅落库与 `.wildstring/`，不修改源文件）。
- **音乐曲库 & 书库管理页扩展存储模式与迁移向导**（面向 `owner`）：
  - 在音乐曲库设置与书库设置内共同新增：
    1. **存储模式选择器**：`独立副本 (Copy)` 与 `硬链接保种 (Hardlink)`，展示当前设备对齐检测结果（若跨卷则明确给出 Docker 同挂载点配置指引，禁用不安全保存）；
    2. **便携 `.wildstring/` 侧车操作**：显示已导出侧车计数与时间戳，提供 `立即导出 .wildstring 元数据` 按钮（清楚说明仅含公共元数据、封面与歌词，绝不导出个人进度与账号信息）；
    3. **「迁移至硬链接模式」任务向导**：支持选择「原地直接重连释放重复空间」或「迁移到新同卷路径并启用硬链接」，任务进度条与历史记录展示精确数字（`relinked_files`、`reclaimed_bytes`、`kept_standalone_files`、`sidecars_written`）。

#### 4.2 Web 双模式电子书阅读器（`book-reader.tsx`）

- 沉浸阅读页（`/books/:bookId/read`）：支持 **`上下滚动` (`scroll`)** ↔ **`分页翻页` (`paginated`)** 一键切换，并在切换、调整字号（`14–24px`）/ 行高 / 字体（衬线/无衬线）/ 视口缩放时通过冻结当前视口首个 `(spine_index, block_index, char_offset)` 锚点无损复原位置；
- 内置独立暖纸浅色（`#F6F3ED`）与暖炭深色（`#181614`）阅读主题（可独立于站点全局主题）、目录抽屉、全书正文搜书跳转、个人书签及 4 色（`amber`, `terracotta`, `sage`, `stone`）划词批注；支持伴读同步启停本书有声书而不污染音乐与播客队列。

#### 4.3 Web 有声书播放器隔离整合

- 扩展 [frontend/web/src/podcast-track.ts](../../frontend/web/src/podcast-track.ts) 相关播控但不污染 `podcast_queue`：新增独立 `bookAudioSession` 通道，全局单一音频焦点（切播前提交原进度），支持章节跳转、`15s`/`30s`、倍速 `0.75x–2.5x`、睡眠定时与右侧/底部浮动章节面板。

---

### 阶段五：Android 端（Phone + Pad 自适应 · Room v3 · 阅读器与 Media3）

Android UI 需同时兼容手机（1080×1920）与平板（2560×1600）标准尺寸，严格遵循 [DESIGN.md](../../DESIGN.md) 尺寸、平板多列骨架、右侧浮动不挤压抽屉及 `MotionAssertions` 动效规范。

#### 5.1 持久化与离线缓存（`QueueDatabase` v2 → v3）

- 升级 [frontend/android/app/src/main/java/com/wildstring/app/data/QueueDatabase.kt](../../frontend/android/app/src/main/java/com/wildstring/app/data/QueueDatabase.kt) 至 `version = 3`（编写正式 `MIGRATION_2_3`，绝不丢失既有队列与播客检查点）：新增 `BookEntity`、`BookEbookChapterMetaEntity`、`BookAudiobookChapterEntity`、`BookProgressSyncEntity`、`BookAnnotationSyncEntity`，章节块 JSON 与缓存图片存入 `filesDir/book_cache/` 并做 LRU 清理。

#### 5.2 Android 导航、书架、双模式阅读器与 Media3

- 「电台」顶栏增加 **`播客 | 书架`**；Phone 与 Pad 自适应多列书架网格与平板专属多列加载骨架；只读提示不支持在移动端/网页上传音频，电子书上传选择器限定 `.epub` / `.txt`；
- 扩展 [frontend/android/app/src/main/java/com/wildstring/app/ui/PodcastArticle.kt](../../frontend/android/app/src/main/java/com/wildstring/app/ui/PodcastArticle.kt) 排版能力构建 `BookReaderScreen`：支持 `LazyColumn` 上下滚动与 `TextMeasurer` + `HorizontalPager` 分页翻页、无损锚点迁移、暖纸浅深独立主题、Reduce Motion 一帧到位、长按 4 色批注及平板右侧浮动章节/书签/目录抽屉（弹出时不挤压左侧正文画面导致宽度闪动）；
- Media3 播放层支持独立有声书域（锁屏章节信息、倍速、`15s`/`30s`、睡眠定时），不写入音乐 `QueueEntry` 与播客 `PodcastCheckpointRow`；存储模式切换与 `copy → hardlink` 重管理仅保留在 Web 端，Android 端无损读取其展示结果与恢复后的元数据/歌词/封面。

---

### 阶段六：版本 `0.9.0a1` / `v0.9.0-alpha.1` 对齐与发布准备

核对 [scripts/package_release.py](../../scripts/package_release.py) 对 prerelease tag `v0.9.0-alpha.1` 的统一版本解析约束（执行阶段最后提交完成）：

| 目标文件 | 现行值（`v0.8.28` 基线） | `v0.9.0-alpha.1` 目标值 | 说明 |
| --- | --- | --- | --- |
| [backend/pyproject.toml](../../backend/pyproject.toml) | `0.8.28` | `0.9.0a1` | 同步执行 `uv lock` 更新 `backend/uv.lock` |
| [frontend/web/package.json](../../frontend/web/package.json) | `0.8.28` | `0.9.0-alpha.1` | 同步更新 `frontend/web/package-lock.json` 根版本号 |
| [frontend/android/app/build.gradle.kts](../../frontend/android/app/build.gradle.kts) | `versionCode = 64` / `0.8.28` | `versionCode = 65` / `0.9.0-alpha.1` | `versionCode` 必须严格大于前版 `64` |
| [frontend/macos/project.yml](../../frontend/macos/project.yml) | `0.8.28` / `63` | `MARKETING_VERSION: "0.9.0"` / `CURRENT_PROJECT_VERSION: "64"` | Apple `MARKETING_VERSION` 按 `package_release.py` 不带 prerelease 后缀，构建号严格递增 |
| [frontend/ios/project.yml](../../frontend/ios/project.yml) | `0.8.28` / `63` | `MARKETING_VERSION: "0.9.0"` / `CURRENT_PROJECT_VERSION: "64"` | 与 macOS 构建号保持同源规则并通过 XcodeGen 生成核验 |

- **既有热更新说明**：核实 [UpdatePolicy.kt](../../frontend/android/app/src/main/java/com/wildstring/app/update/UpdatePolicy.kt) 会在客户端侧跳过 `prerelease == true` 的 GitHub Release（`release_unstable`）；保留为正式渠道保护策略，在发布 `v0.9.0-alpha.1` 时标注 Alpha 包需手动安装验证。
- **发版文档入口**：准备打 tag 前，按 [AGENTS.md](../../AGENTS.md) §1 同步更新中英文 README 最新版本、`docs/product/scope.md`、`CHANGELOG.md` 与 `docs/releases/v0.9.0-alpha.1.md`。

---

## 验收（按 AGENTS.md §3 定级）

本方案触及契约、SQLite Schema、音乐与书架存储核心（导入/扫描/迁移）、后端多模块、Web、Android 双形态及版本号体系，按 [AGENTS.md](../../AGENTS.md) §3 定为 **L3 级验收**：

### 1. 修改前必须执行的现有实现与文案反查

- 实施修改前先运行 `git grep` 反查以下关键标识符与文案影响面，确保不破坏既有曲库导入、迁移与播客功能：
  - `copy_exclusive`、`library_migrations`、`imported_files`、`scan_library`、`reorganize_track_file`
  - `podcast_queue`、`PodcastCheckpoint`、`podcasts_dir`、`EXEMPT_PREFIXES`、`LibraryStorage`、`SCHEMA_VERSION`、`QueueDatabase`
- 任何调整了「电台」、曲库存储设置、空态文案、路由结构或导航元素的改动，必须同步反查并更新 Web / Android UI 自动化测试断言，确保 `make check` 零残留旧文案断言。

### 2. 后端自动化测试验收矩阵

- **迁移与既有音乐回归（阶段一合入即测）**：
  - 基于 [backend/tests/migration_support.py](../../backend/tests/migration_support.py) 构造 `v55` 库（含现有音乐曲库、覆写元数据、歌词、封面、播客进度与多库数据），升级至 `v56` 验证无损迁移及默认值对齐（旧库均为 `storage_mode = 'copy'`、`link_mode = 'copy'`）。
  - 紧随 `v56` 迁移测试立即验证**全新初始化数据库以及由 `v55` 升级而来的数据库**均可正常执行既有 `MusicImporter` 音乐导入与网页音乐上传（验证显式 8 列 `INSERT INTO imported_files` 无列数错误并完整保留既有音乐导入回归通过）。
- **硬链接双模式与防跨卷测试（音乐 + 书架）**：
  - 同挂载卷下创建 `hardlink` 模式音乐曲库与书库，导入直通音频（`.flac` / `.mp3` / `.m4a` / `.m4b`）与电子书（`.epub` / `.txt`）：断言源与托管文件 `st_ino` 完全一致、`st_nlink >= 2`、源目录完全只读；随后在 WildString 内修改元数据覆写、歌词、封面并重组织文件路径，断言源音频/电子书字节与修改时间 `st_mtime_ns` `0` 变化，且不允许任何内嵌标签写回改写源 inode（包括硬链接迁移路径亦严格验证 `st_mtime_ns` 未被 `os.utime` 改写）。
  - 验证 `Intake` 下的 `WAV → FLAC` 与 `CUE` 分轨自然生成新副本（`link_mode = 'generated'`）并保留原始 WAV 源无损。
  - 模拟不同挂载盘 / `EXDEV`、只读目标 `EROFS` 以及 `protected_hardlinks` 权限不足 `EPERM`（通过真实源只读文件探针捕捉）场景新建/切换或迁移到 `hardlink`：断言服务端直接返回 `HTTP 422 hardlink_cross_device` 或 `HTTP 422 hardlink_not_supported`，绝对不会静默回落成双份复制，且绝不向 `source_roots` 写入探测文件。
- **`.wildstring/` 侧车双向零隐私与分享还原测试**：
  - **导出零隐私红线**：在音乐库与书架同时存在 2 个用户、各自的播放次数、红心、歌单、阅读/听书进度、个人书签、4 色批注后执行元数据编辑及全量导出 `.wildstring/`，逐字扫描所有导出的 `.json` / `.lrc` / 图片元数据，断言**绝不含**任何 `user_id`、`username`、进度、红心、歌单、批注、密码/令牌或宿主机/容器绝对路径。
  - **分享跨实例导入恢复**：将带 `.wildstring/` 的导出专辑/书籍目录复制到全新干净的 WildString 测试实例 `source_roots`（联网搜刮禁用），执行导入后断言所有精修元数据、锁定字段、`track_lyrics`（`.lrc`）、Pillow 封面与有声书章节表全部直接还原；另测对空数据库重扫已包含 `.wildstring/` 的托管目录亦可恢复。
  - **不可信输入安全防御 & 扫描回归**：构造含 symlink、路径穿越（`../`）、超限 `manifest.json`、错误 `sha256`、恶意附加私人字段与 `<script>` 的 `.wildstring/` 文件夹，验证被安全拒绝或忽略篡改项；验证现有 [scanner.py](../../backend/src/wildstring/library/scanner.py) 扫描含 `.wildstring/` 的托管目录时 `counts["skipped"]` 保持 `0`（不把侧车计为跳过文件破坏现有回归）。
- **`copy → hardlink` 与 `hardlink → copy` 迁移测试（音乐 + 书架）**：
  - **原地模式迁移与中断恢复**：针对已与 `source_roots` 同卷的 `copy` 库触发原地 `copy → hardlink` 迁移：断言执行前自动刷出 `.wildstring/`，迁移中保持一个打开的音频读文件描述符持续读取不中断、无 `ENOENT`，完成后对应源文件的文件 `st_ino` 对齐源、`reclaimed_bytes > 0`、`storage_mode == 'hardlink'`，而网页上传文件与 CUE 衍生文件作为 `kept_standalone_files` 完整保留不受损；**另构造迁移中途完成一半（部分文件已 `os.replace` 为硬链接、其余仍为独立副本）后进程退出的状态，验证重跑/恢复时可幂等识别已完成项、补齐 `link_mode = 'hardlink'`，最终磁盘硬链关系、库记录与计数完全一致**。
  - **跨目录搬迁 + 转硬链**：将 `/data/libraries/lib1`（`copy`）迁移至源同卷 `/media/wildstring/lib1`（`target_storage_mode='hardlink'`）：断言新路径直接建立硬链接零双倍新写入且源 `st_mtime_ns` 零变化、旧覆写/歌词/封面随 `.wildstring/` 迁移、`root` 原子切换，且支持 `retry` 与重启恢复。
  - **反向解耦**：执行 `hardlink → copy` 后，断言托管文件与源文件 `st_ino` 重新分离（`st_nlink == 1`），空间不足时提前拒绝。
- **书架专属边界、上传红线、配对与 CAS 同步**：
  - `.epub`/`.txt`/封面上传正常入库为 `managed_only`；`.m4b`/`.mp3`/`.flac`/`.ogg`/`.m4a` 上传、音频伪装扩展名（魔数欺骗）与内嵌音频的 `.epub` 均返回 `HTTP 422 audio_upload_forbidden` 且无临时文件残留；EPUB Zip Bomb / `../` / `<script>` 被拒绝或剥离；多用户进度/书签/4 色批注隔离与 `HTTP 409` CAS 冲突正常；Mock `OpenLibrary` / `Google Books` / `Apple iTunes` 搜刮与 `locked_fields` 抗重扫生效且自动同步 `.wildstring/`。

### 3. Web 与 Android 端验收（自动化 + 真机视觉 + 帧采样）

- **Web 端 E2E（隔离合成测试库）与视觉验收**：
  - 生成并逐张查看 **桌面端 + 390px 手机端 × 浅色/深色主题** 截图：
    - 音乐库管理与书库管理中的「存储模式切换（Copy / Hardlink）」、「跨卷失败提示」、「一键导出 `.wildstring/`」与「`copy → hardlink` 迁移向导与计数展示」；
    - 「电台 → 播客 | 书架」切换、书架 `Loading / Empty / Error` 状态与授权空态、音频上传拦截提示；
    - 书籍详情页（双载体、章节、书签批注、在线搜刮）与阅读器全屏「上下滚动 ↔ 分页翻页」切换（锚点无跳动、暖纸浅深主题、目录/搜书/4 色批注与隔离有声书伴听）。
- **Android 端构建、单测、设备回归与帧采样**：
  - 执行 `make android-ci`（构建、Lint、Kotlin/Room `MIGRATION_2_3` 与分页测量单测）。
  - 在本地基准模拟器（Phone `1080×1920` 与 Pad `2560×1600`，开启 `hw.keyboard = yes`）跑通关键路径并截图核对：Pad 多列书架骨架、全屏或阅读器右侧不挤压浮动章节/目录抽屉、双模式阅读器切换与 Media3 有声书播放；确保读取服务端通过 `.wildstring/` 恢复或硬件链接托管的曲目/书籍、歌词、封面与章节完全一致。
  - **动画逐帧采样（L3 强制）**：使用 `MotionAssertions` 对「工具栏显隐」与「平板章节抽屉弹出/收起」逐帧采样确认连续且 Reduce Motion 一帧到位，并令测试在故意注入跳变时失败一次证明判据有效。

### 4. 全局门禁命令

- `make check`、`make ci`、`make android-ci`、`make macos-test`、`make docker-up docker-smoke` 以及 `scripts/package_release.py` 对 `v0.9.0-alpha.1` 的五端校验全通。

---

## 风险与回滚

1. **Docker 默认双挂载卷导致的硬链接误解（`/music:ro` 与 `/data` 跨卷）**：
   - 缓解：在容器配置示例、Web 设置提示与 API 错误码 `hardlink_cross_device` 中显式说明需同一父卷挂载（如共享 `/media`），并在启用时即探针阻断，避免静默回退复制到占满磁盘。
2. **`.wildstring/` 导出或误用导致隐私字段泄漏与扫描误计数**：
   - 缓解：导出与导入共走独立强类型白名单序列化器（仅允许作品公共字段与 `sha256`），单元测试强制双用户夹具全字段扫描零泄露；扫描音频前主动将 `.wildstring` 从遍历目录剪枝，确保不误触发跳过告警。
3. **大体积 `.txt` 或畸形 `.epub` 阻塞扫描与阅读响应，及滚动↔分页锚点漂移**：
   - 缓解：严格限定解压与章节切片上限、异步惰性落盘 `book_cache`；以 `(spine_index, block_index, char_offset)` 作为跨端跨模式唯一规范锚点，切模式及调字号前先冻结锚点再局部复算。
4. **误将有声书混入音乐库或 `podcast_queue` 引发统计污染**：
   - 缓解：`books_dir` / `book_libraries` 与 `libraries` / `podcasts_dir` 强制隔离交叉检查；书架有声书走独立会话通道，严禁写入 `podcast_queue` 与 `playback_states`。
5. **回滚策略（区分存储模式回退与版本降级）**：
   - 本批新增书籍表与增量列均设安全默认值（既有音乐库保持 `storage_mode = 'copy'`）：
   - **(a) 保持 `0.9.0a1` 新版仅退回独立副本模式**：管理员可在界面或 API 发起 `hardlink → copy` 存储迁移，将托管媒体安全解耦为独立副本，不损毁源目录做种文件、既有曲库、书架与播客个人数据；
   - **(b) 服务端程序降级回 `v0.8.28`**：[database.py](../../backend/src/wildstring/database.py) 强制拒绝打开高于自身 `SCHEMA_VERSION` 的数据库（`current > SCHEMA_VERSION`）；因此升级前须常规备份 `v55` `wildstring.db`，若需完整回退至 `v0.8.28` 程序镜像/二进制，须先将受保护的 `v55` 数据库备份恢复后再启动旧版服务。
