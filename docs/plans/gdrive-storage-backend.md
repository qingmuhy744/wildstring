状态：已实施

# 原生 Google Drive 云存储后端（小硬盘 VPS 适配，覆盖音乐库与书架）

## 目标

面向「CPU／内存与公网网络良好、但本地硬盘容量受限」的自托管 VPS，在不依赖宿主机 `rclone mount`／FUSE 特权挂载、不改造四端客户端播放与阅读协议的前提下，在野弦后端原生引入 **Google Drive 存储后端，首期统一覆盖音乐库与书架（电子书 + 有声书）**，并预留后续 S3／Cloudflare R2 扩展接口：

- **VPS 仅存轻量索引、解析缓存与热缓存**：SQLite 曲库与书架元数据、拼音检索键、压缩封面缩略图（`data/covers/`）、歌词文本、电子书分章解析缓存（`data/book_cache/`）、歌单、收听／阅读进度、批注、AI／MCP 索引，以及受容量上限控制的远端媒体热缓存／转码缓存；日常浏览、搜索、阅读电子书、AI 助手与 Gemini MCP 全程本地响应，对 Google Drive 零额外请求。
- **媒体大文件托管在用户自己的 Google Drive**：支持两种符合 Google API 政策的接入模式（使用用户自建的 Google Cloud OAuth 凭据，即 BYO Client）：
  1. **托管上传模式（`drive.file`，推荐默认）**：用户通过野弦网页上传音频、电子书与歌词，后端流式转发至 Google Drive 专用目录（不长期落盘），权限最小化、免 Google CASA 年度安全审计。
  2. **目录同步模式（`drive.readonly`，可选）**：所有者绑定已有 Google Drive 音乐／书架目录，基于 `changes.list` 增量游标同步，避免 POSIX 遍历扫盘触发 403／429 限流。
- **四端零协议改造**：Web、Android、macOS、iOS 继续使用现有 `/api/v1/tracks/{id}/stream`、`/playback`、`/cover`、`/lyrics` 与 `/api/v1/books/{id}/...` 接口，保留离线下载、无损实时转 AAC、电子书阅读下载、有声书分章播放与多用户库权限隔离。

## 不碰的边界

- 不移除、不改动现有本地音乐库与书库的 `copy` / `hardlink` 存储模式、只读导入源校验、本地库迁移（`library_migrations` / `book_library_migrations`）与便携侧车（`wildstring-sidecar`）语义。
- 不引入 `rclone` 或 FUSE 宿主机依赖，保持单镜像无特权容器部署。
- 不在开源仓库或服务端中硬编码公用 Google OAuth Client ID／Secret；必须由部署者自备 Google Cloud OAuth 凭据（BYO Client），密钥按现有 `data_dir` 受限权限秘密文件模式存放，不以明文写入 SQLite，也不下发浏览器或写入日志。
- 不自动向 Google Drive 写回或修改用户原有音频标签与原书文件；`drive.readonly` 模式下严禁发起任何写入／删除请求。
- 首期不把播客音频缓存迁入 Google Drive（播客继续沿用现有本地共享资源与容量／保留天数清理策略）。
- 不引入客户端直连 Google Drive 播放链路（四端保持同源 `/stream` 鉴权模型，不放宽 Android `PlaybackResolver` / `AudioCache` 的同源校验）。

## 方案

### 1. 合规与防限流设计（Google Drive ToS / API Policy）

- **个人／家庭私有媒体定位**：定位为私有自托管媒体库，不生成公开共享链接、不做匿名分发；每实例独立使用部署者自己的 Google Cloud 项目（BYO OAuth Client），独享 API 配额、隐私零中转。
- **权限分级**：
  - `https://www.googleapis.com/auth/drive.file`（Non-sensitive Scope，免 CASA 审计）：覆盖“由野弦上传并整理到 Drive 专用文件夹”的托管流程；
  - `https://www.googleapis.com/auth/drive.readonly`（Restricted Scope）：覆盖“用户自行往 Google Drive 放文件、野弦增量同步”的只读目录模式；管理页明确提示须在自建 Google Cloud 项目中将 OAuth Consent Screen 切为 **In Production**（个人自用不提交公开审核，避免 `Testing` 模式 7 天 Refresh Token 强过期）。
- **出站安全复用**：全部 Google OAuth／Drive API 请求统一复用 `backend/src/wildstring/outbound.py` 的代理策略（`direct` / `environment` / `custom`）与日志脱敏规则，绝不记录 `access_token`、`refresh_token` 或下载 URL。

### 2. 数据库迁移（预计 `SCHEMA_VERSION = 64`）

保持 `libraries.storage_mode` 与 `book_libraries.storage_mode`（`copy | hardlink`）语义不变，通过正交字段与统一远端附表接入，避免重建旧表或破坏既有迁移约束：

- `libraries` 与 `book_libraries` 各自新增列：`storage_backend TEXT NOT NULL DEFAULT 'local' CHECK(storage_backend IN ('local', 'gdrive'))`。
- 新增 `remote_storage_accounts` 表：记录所有者配置的远端存储账号（`id`、`provider` 目前为 `'gdrive'`、`name`、`scope_mode` 为 `'drive_file' | 'drive_readonly'`、`client_id`、`secret_ref`、`token_ref`、`account_email`、`status`、`last_error`、`created_at`、`updated_at`、`version`）；其中 `client_secret`、`refresh_token`、`access_token` 存入 `data_dir/storage-secrets/`（`0o600` 原子替换），不落 SQLite 明文。
- 新增 `library_remote_storage` 表（`PRIMARY KEY(collection, library_id)`，`collection IN ('music', 'books')`）：绑定 `account_id`、`root_folder_id`、`root_folder_name`、`changes_page_token`、`last_synced_at`、`cache_max_mb`（默认 `2048`，支持设为 `0` 纯透传不落盘）、`version`。
- 新增 `remote_media_objects` 表（`PRIMARY KEY(entity_kind, entity_id)`，`entity_kind IN ('track', 'book_ebook', 'book_audiobook_file')`）：记录 `collection`、`library_id`、`provider`、`account_id`、`remote_file_id`、`remote_md5`、`remote_modified_at`、`remote_version`、`size_bytes`，并建唯一索引 `(account_id, entity_kind, remote_file_id)`。
- 新增 `remote_media_cache` 表（复用 `transcoding_cache` 同款有界 LRU 模式）：记录 `cache_key`（`{entity_kind}:{entity_id}`）、`library_id`、`remote_version`、`filename`、`size_bytes`、`accessed_at`，缓存目录位于 `data_dir/remote-cache/`，按每库 `cache_max_mb` 自动淘汰与支持手动清理。

### 3. 极薄 `MediaStore` 抽象与 Google Drive 驱动

在 `backend/src/wildstring/storage/` 新增统一存储接口（后续可扩展 S3／Cloudflare R2）：

- `MediaStore` 协议：
  - `open_range(ref, start, end) -> AsyncIterator[bytes]`：单次或分段 `Range` 透传读取（供直放与头部解析）；
  - `materialize(ref, cache_store) -> Path`：按需下载至有界 LRU 缓存目录并返回只读本地路径（供无损转 AAC、M4B 章节探测、EPUB 首次解析与整曲复听复用）；
  - `upload_stream(folder_id, rel_path, stream, size, mime_type) -> RemoteObject`：Google Drive Resumable Upload 分块上传（单块 8 MiB，支持断点续传，不占用 VPS 持久硬盘）；
  - `list_tree(root_folder_id)` 与 `list_changes(root_folder_id, page_token)`：首次列表分页（`pageSize=1000`）与后续增量变更拉取。
- **Range 支撑的轻量标签读取（避免全文件下载）**：
  - 实现 `RemoteRangeFile`（可 `seek/read`、256 KiB 内存分块缓存），直接喂给 `mutagen.File(...)` 解析 MP3／FLAC／M4A／OGG／OPUS 标签与内嵌封面；
  - 音乐与有声书音频扫描时仅拉取头部 256 KiB–2 MiB（M4A／M4B 的 `moov` 位于尾部时按需拉尾部块），解析完成后立即将封面写入既有 `data_dir/covers/`、歌词写入 `track_lyrics`；
  - M4B 章节探测与 EPUB／TXT 分章解析在入库阶段通过临时文件执行一次，提取章节表与 `data_dir/book_cache/` 后立即释放临时文件（不长期占盘）。

### 4. 与现有音乐库、书架、播放、转码与管理链路对接

- **音乐与有声书串流（`backend/src/wildstring/library/streaming.py`、`backend/src/wildstring/books/content.py`）**：
  - 音乐 `GET /HEAD /api/v1/tracks/{id}/stream` 与有声书 `GET /HEAD /api/v1/books/{id}/audiobook/files/{file_index}/stream` 共享同一远端串流路径：
    1. 若该库 `cache_max_mb > 0` 且命中 `remote_media_cache`（版本与 `remote_md5` 一致），直接走现有本地 `AudioResponse` 零延迟返回并刷新 `accessed_at`；
    2. 未命中时，按 `Range` 透传给客户端首包秒播，并对完整顺序读取做并发合并（singleflight）与可选后台回填热缓存；当 `cache_max_mb = 0` 时纯透传不落盘；
    3. 上游鉴权失效返回 503 `remote_storage_auth_required`，上游限流返回 503 `remote_storage_rate_limited`（附带 `Retry-After`），不暴露任何上游 Token。
- **电子书阅读与原书下载（`backend/src/wildstring/books/content.py`）**：
  - 章节阅读（`/books/{id}/ebook/chapters/{index}`）全程读取 VPS 本地 `data_dir/book_cache/`，零 Drive 请求；
  - 原书下载（`/books/{id}/ebook/download`）走 `MediaStore` 从 Google Drive 透传或命中 LRU 缓存下发。
- **实时转码（`backend/src/wildstring/library/transcoding.py`）**：
  - 对无损云端曲目请求 AAC 转码时，通过 `MediaStore.materialize()` 获取临时／缓存源文件交给现有 `ffmpeg` 管线与 `transcoding_cache` 复用，受原有容量与并发上限约束。
- **网页上传入库（`backend/src/wildstring/library/upload.py`、`backend/src/wildstring/books/content.py`）**：
  - 目标音乐库或书库为 `storage_backend = 'gdrive'` 且账号为 `drive_file` 时，上传的音频、歌词、EPUB／TXT 经临时缓冲提取元数据、封面与章节缓存后，通过 Resumable Upload 写入 Drive 对应目录结构，登记远端对象后立即清理 VPS 临时文件。
- **增量同步扫描器（`backend/src/wildstring/library/scanner.py`、`backend/src/wildstring/books/service.py`）**：
  - 对 `gdrive` 音乐库与书库使用统一增量同步器：首次拉取绑定目录下的文件树，之后每次同步仅调用一次 `changes.list`（游标失效自动降级全量校对）；书库沿用现有电子书／有声书自动配对逻辑（`auto_pair`）；远端删除或移出根目录的条目按现有缺失策略处理。
- **管理中心 UI（Web，所有者专属）**：
  - 在「管理中心 → 存储与曲库」新增云存储账号连接卡片（填写自建 Client ID／Secret、选择 `drive.file` 或 `drive.readonly`、通过 OAuth 回调绑定 Google 账号、测试连接与解除授权，并内嵌简明 BYO 配置指引）；
  - 新建音乐库与新建书库时允许选择「本地目录」或「Google Drive（绑定远端文件夹 + 设置本机 LRU 缓存上限 MB，默认 `2048`，支持 `0` 纯透传）」，库卡片展示同步状态、最近同步时间、热缓存占用与一键清理缓存按钮。

### 5. 已确认决策

- **接入模式**：同一套 BYO Google OAuth Client，同时支持 `drive.file`（野弦托管上传）与 `drive.readonly`（已有 Drive 目录增量同步）；
- **首期覆盖范围**：音乐库 + 书架（电子书与有声书）；
- **本机热缓存默认上限**：每库 `2 GB`（`2048 MB`），可调整并支持设为 `0` 纯透传不落盘。

## 验收（按 AGENTS.md §3 定级）

- **级别：L2**（新增存储后端抽象、数据库 schema 64、音乐库与书架共享的串流／转码／扫描／上传路径与管理中心设置 UI；四端原生客户端无代码改动，仅做兼容回归）。
- **必做检查**：
  - `make check`（Ruff、Bandit、Prettier、Web typecheck、i18n 键值、文档链接、旧测试断言）。
  - 后端 pytest：新增 `backend/tests/test_gdrive_storage.py`（使用本地 Mock Google OAuth／Drive HTTP 服务，覆盖 OAuth 绑定与 Token 刷新、Secret 文件 `0o600` 与脱敏、音乐与电子书 Resumable Upload、音乐库与书库首次树扫描与 `changes.list` 增量同步、`RemoteRangeFile` 解析真实 MP3／FLAC／M4A 头部与封面缓存、EPUB 缓存本地阅读与原书云端下载、有声书分章流式播放、Range 透传 + singleflight + LRU 淘汰 + `cache_max_mb=0` 纯透传、FLAC 云端源文件实时转 AAC、401／429 错误降级、v63→v64 迁移），以及既有 `test_importer.py`、`test_bookshelf.py`、`test_music_rebind.py`、`test_auth.py`、`test_openapi_operation_ids.py`、`test_combined_feature_migrations.py`。
  - Web Playwright 回归（桌面 + 390px 手机，浅深主题截图逐张检查）：管理中心云存储账号配置、新建 Google Drive 音乐库与书库、热缓存清理、错误与未授权状态展示，以及播放云端 Mock 曲目与阅读云端 Mock 电子书／有声书。
  - 本地 CodeQL 扫描确认零新增安全告警（重点排查 OAuth 回调重定向、SSRF 与 Token 泄漏路径）。

## 风险与回滚

- **回滚约束**：`database.py` 拒绝由旧版本代码打开高于其 `SCHEMA_VERSION`（64）的数据库；升级前须按 `docs/development.md` 备份 SQLite 与 `data_dir`。
- **已有测试与规则排查**（基于 `git grep "storage_mode"` 核对）：
  - `backend/tests/conftest.py:85`、`backend/tests/migration_support.py:217`、`backend/tests/test_bookshelf.py`、`backend/tests/test_importer.py`、`backend/tests/test_music_rebind.py`、`frontend/web/tests/music-rebind.spec.ts:149` 均断言本地库的 `storage_mode` 为 `'copy'` 或 `'hardlink'`；本方案保持 `storage_mode` 枚举不变、通过新增正交列 `storage_backend` 隔离云端库，不破坏上述任何现有断言。
  - `backend/tests/test_auth.py` 已改用 `SCHEMA_VERSION` 常量而非硬编码数字，但仍需同步检查 `migration_support.py` 中的迁移路径夹具。
- **运行风险与缓解**：
  - **Google API 限流／7 天 Token 失效**：单文件请求做 singleflight 合并、播放优先命中 LRU 缓存、扫描全程走 `changes.list`；管理页明确指引使用 `In Production` 自建项目，Token 失效时曲目与书籍保留索引并在管理页给出平静的一键重新授权提示，不影响本地库与播客使用。
  - **大文件解析临时占盘**：EPUB／M4B 首次入库解析按单文件串行临时落盘，解析完成即刻删除临时文件，受文件体积上限保护，不会撑爆小硬盘 VPS。
  - **VPS 流量消耗**：音频经 VPS 中转产生等量上下行流量；在管理页文档中写明流量特征，并允许通过调大本机热缓存或后续扩展 S3／R2 预签名直连来降低中转流量。
