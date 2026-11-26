状态：已实施

# 音乐库全面深化 `.wildstring/` 便携侧车方案（Schema 58）

## 目标

将音乐库的公共作品级元信息（元数据覆写与锁定、多层双语/逐字歌词、专辑及分曲自定义封面、内容哈希缓存与目录级侧车扫描状态）彻底沉淀为托管专辑目录 `<album>/.wildstring/` 内的自包含便携侧车，同时让 SQLite 退化为可随时重建的高性能检索索引与用户私有状态库：

1. **无损多层与逐字歌词侧车**：选中在线/多语言候选歌词后除导出兼容的 `lyrics/<sha256>.lrc` 外，同步保存结构化 `lyrics/<sha256>.json`（`schema = "wildstring.sidecar.lyrics.v1"`，含逐字时间轴 `words`、行结束时间 `end_ms`、翻译层 `translation` 与音译层 `romanization` 及生效时间偏移），删库重扫后可无损还原。
2. **封面去重与运行时直读 `.wildstring/`**：`TrackAssets.cover` 直接从 `.wildstring/cover.jpg` 及按曲 `covers/<sha256>.jpg` 读取原图生成缩略图，上传、导入或导出后不再向 `<data_dir>/artwork/` 长期双存自定义封面；专辑编辑弹框默认仅写入 `.wildstring/`，传统专辑根目录 `cover.jpg` 作为按需显式勾选的外部兼容选项。
3. **音频 `sha256` 持久化缓存**：在 `tracks` 表缓存与 `(size_bytes, mtime_ns)` 绑定的音频内容 `sha256`，单曲编辑/路径重排刷新侧车时复用缓存哈希、避免整专音频重读计算；源文件大小或修改时间变化时自动失效重算。
4. **增量扫库感知 `.wildstring/` 外部变化**：新增 `music_sidecar_states` 记录目录级 `.wildstring/manifest.json` 的 `mtime_ns` 与内容哈希；`scan_library(full=False)` 检测到外部新增、修改或删除 `.wildstring/` 时（即使音频本体字节与时间均未变），自动同步未锁定字段并保留本地锁定覆写，无需人工触发全量重扫。

## 不碰的边界

1. **保持用户私有状态与检索索引留在 SQLite**：红心收藏、歌单、播放次数与进度、AI 草案与在线候选搜索历史绝不写入 `.wildstring/`；列表筛选、排序、全文检索与智能歌单规则继续由 SQLite 索引承担。
2. **保护只读来源与硬链接字节不可变**：绝不向 `source_roots` 写入 `.wildstring/`，也绝不改动音频媒体文件内嵌字节或时间戳；严格校验文件大小、白名单字段、禁用 `symlink` 并拦截 HTML/路径注入。
3. **向后兼容既有传统旁路与客户端接口**：不破坏同名 `.lrc` / `.txt` 与传统 `cover.jpg` 读取，不改变 Web/Android/macOS/iOS 播放器及曲库浏览 API 契约。

## 方案

- **数据库迁移（`SCHEMA_VERSION = 58`）**：新增 [music_sidecar_schema.py](../../backend/src/wildstring/library/music_sidecar_schema.py)，在 `tracks` 增加 `sha256`（由 `imported_files` 回填）、在 `track_lyrics` 增加 `portable_bundle`、新建 `music_sidecar_states(library_id, folder, manifest_mtime_ns, manifest_sha256)`，同步更新 [database.py](../../backend/src/wildstring/database.py)、[repository.py](../../backend/src/wildstring/library/repository.py) 与迁移测试夹具 [migration_support.py](../../backend/tests/migration_support.py)、[conftest.py](../../backend/tests/conftest.py)。
- **富文本歌词链路**：在 [music_sources.py](../../backend/src/wildstring/music_sources.py)、[lyric_scans.py](../../backend/src/wildstring/lyric_scans.py) 与 [lyric_edits.py](../../backend/src/wildstring/library/lyric_edits.py) 持久化与维护 `portable_bundle`；用户手工编辑纯文本 LRC 或重置时自动清理或保留一致，在 [sidecar.py](../../backend/src/wildstring/library/sidecar.py) 实现 `lyrics/<sha256>.json` 双向序列化与白名单清洗。
- **封面去重与直读**：扩展 [sidecar.py](../../backend/src/wildstring/library/sidecar.py) 支持专辑 `cover.jpg` 与分曲 `covers/<sha256>.jpg`（复用已有规范化字节避免二次有损转码）；升级 [assets.py](../../backend/src/wildstring/library/assets.py) 优先直读 `.wildstring/` 封面与未覆写歌词；简化 [management.py](../../backend/src/wildstring/management.py) 专辑封面落地路径，并将 [album-editor.tsx](../../frontend/web/src/album-editor.tsx) 的传统目录 `cover.jpg` 复选框默认改为 `false`。
- **增量侧车扫描感知**：在 [sidecar.py](../../backend/src/wildstring/library/sidecar.py) 与 [scanner.py](../../backend/src/wildstring/library/scanner.py) 按专辑目录探测 `manifest.json` 状态（`unchanged` / `touched` / `changed` / `removed`），仅在变更时幂等回灌未锁定元数据、歌词和封面。
- **规则与契约同步**：更新 [wildstring-sidecar.md](../../contracts/wildstring-sidecar.md) 与 [library-management.md](../../contracts/library-management.md)。

## 验收（按 AGENTS.md §3 定级）

- 本次同时触及 Python 后端共享存储／扫描契约与 Web 共享弹窗组件 `album-editor.tsx`，按 `AGENTS.md` §3 执行 **L1 + 后端契约回归**：
  1. `make check` 全项通过（含 Ruff、Bandit、i18n parity、文档链接与状态检查）。
  2. 新增 [test_music_sidecar.py](../../backend/tests/test_music_sidecar.py) 覆盖富文本歌词无损删库重建、封面去重与分曲封面直读、增量扫描同步外部 `.wildstring/` 变更与本地锁保护、`tracks.sha256` 缓存免重算；回归既有的导入、歌词、专辑管理、资源与迁移测试套件。
  3. Web 构建、静态检查与 `album-editor` 桌面/`390px` 手机浅深主题视觉核验。

## 风险与回滚

- **回滚约束**：`database.py` 强制拒绝由低于 `SCHEMA_VERSION`（58）的服务端打开已升级的 v58 数据库；生产升级前需备份 v57 SQLite 数据库以支持程序降级回退。
- **并发与冲突**：跨实例同时编辑同一受管目录时遵循「本实例锁定字段与本地歌词锁优先 + 显式导出刷新」原则，外部 `.wildstring/` 未锁定变更在增量扫库时同步，已锁定字段不被覆盖。
