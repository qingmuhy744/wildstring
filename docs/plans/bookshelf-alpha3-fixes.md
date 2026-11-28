状态：已实施

# Bookshelf Alpha 3 修复与元数据打通方案

以 `v0.9.0-alpha.2`（`8b5c514e`）为基线，集中修复现网导入《盗墓笔记》及日常阅读中暴露的书架问题，并打通后端已有元数据字段到 Web / Android 界面与系列浏览体验。

## 目标

1. **P1 · 有声书分盘归并、章节排序与乱码/角色清洗**
   - 识别 `DISC` / `CD1` / `CD2` / `Disc 01` 等纯分盘子目录，向上归并到所属书目目录作为同一本有声书，继承父目录书名、封面与简介文件。
   - 多文件有声书排序结合盘号（标签 + 分盘目录）与轨号：仅当整组 `(disc, track)` 完整且严格无冲突时按盘/轨排序；一旦存在缺失轨号或同盘重复轨号（如第 25 回标为 `01`），整组回退到相对路径自然排序。既有书目重排时通过 `chapter_remap` 保留各用户在同一文件内的 `chapter_position_ms`、音频书签与手工校对章节标题。
   - 自动吸收的伴随文本仅有简介 `desc.txt` 与演播资料 `reader.txt`（体积上限 64 KiB，支持 UTF-8、GB18030、Big5 与带 BOM 的 UTF-16）。扫描与监听共用 TXT 准入规则。有声书目录（含分盘目录及归并书目目录）和包含可见真实子目录的目录中，未入库的普通 TXT 需达到 16 KiB 或在前 16 KiB 内出现语义章节标题。已跟踪 TXT 与独立叶子目录的普通 TXT 继续扫描，直传沿用上传规则。
   - 无内嵌章节的多文件音轨按清洗和归一化后的标题标签分组。组内有不同文件名时，以文件名作为默认章名，保留唯一标签。修复和单书重扫更新仍与重复标签相同的旧章名，并保留已校对的不同章名。
   - 本地扫描按大小写不敏感的文件名查找封面，依次匹配 `cover`、`folder`、`front`、目录名、书名，跳过隐藏文件和符号链接。扫描封面允许 64 MiB 和 8000 万像素，按 EXIF 方向缩放至 1600×1600 以内。上传与 EPUB 图片沿用原上限。
   - 修复明显乱码的音频中文标签（优先保守还原 Latin-1 误解码的 GB18030/UTF-8，无法确定有效还原时回退可读目录名/文件名）；严格区分作者（`authors`）与演播者（`narrators`），仅从明确标签取值，仅有 `artist` / `albumartist` 而无明确角色标识时作者栏留空（不把演播者错填为作者）。
   - 多卷/多季同父目录自动提取 `series_name` 与 `series_index`（尊重 `locked_fields` 与 `overrides_json`，不覆写用户手动修改）。
   - 提供安全可重复的保进度修复路径（`POST /api/v1/book-libraries/{library_id}/repair` 或扫描 `repair=true`），用于对已有库在不丢失续听进度、阅读进度、书签、批注和锁定字段的前提下重排章节、重解析 TXT 目录并补齐未锁定字段。

2. **P1 · TXT 语义目录与阅读分段解耦**
   - 收紧 TXT 标题正则，杜绝正文句（如「第五个故事，重新回到西沙。」）被误判为章节标题；支持三级语义层级写入已有 `book_ebook_chapters.level` 字段：`1`（季/部/篇/Season/Part）、`2`（卷/册/Volume/Book）、`3`（章/回/节/话/幕/Chapter 及序章/楔子/尾声/番外等短标题），自动切分阅读续段或无标题前置段标记为 `level = 0`（避免出现 `01  1` 裸数字目录项，EPUB 无标题纯图封面页标记为「封面」而非 `"1"`）。
   - 电子书重解析时按文本全局字符位置重映射既有 `book_reading_progress`、电子书书签与 `book_annotations`，保留原阅读位置与批注高亮锚点。
   - Web 与 Android 详情页及阅读器目录按 `level` 呈现清晰层级缩进，支持点击「第一季」「第一卷」跳转，目录计数排除 `level = 0` 自动续段（全书无任何语义标题时再回退展示可读分段）。

3. **P2 · 元数据前端打通与系列体验（零 schema 变更）**
   - 复用 `books` 表已有 13 字段与 `book_audiobooks` / `book_ebooks` 统计列：`GET /api/v1/books` 与 `GET /api/v1/books/{book_id}` 返回 `narrators`、`series_name`、`series_index`、`description`（详情必返）及只读载体摘要（时长/章数/编码或格式/字数）；`GET /api/v1/books?q=` 搜索扩展覆盖 `narrators_json` 与 `series_name`，并支持可选 `series_name` 筛选。
   - Web 与 Android 书目详情页区分展示「作者」与「演播」、系列卷号（含同系列按 `series_index` 排序导航/列表，同系列全本电子书与分卷有声书共处一套系列）与可折叠简介；编辑面板开放 `title`、`authors`、`narrators`、`series_name`、`series_index`、`description` 直接编辑，其余已有字段（`subtitle`、`publisher`、`published_year`、`language`、`isbn10`、`isbn13`、`tags`）收进默认折叠的「更多信息」区，保存同步写入 `locked_fields` 与便携侧车。

4. **P2 · Android 阅读器批注交互重构与弹窗降噪**
   - 选中文字松手后紧贴选区附近弹出统一浮条（复制 + 4 色一键高亮圆点 + 写批注），替换原沉在屏幕底部与系统工具栏上下割裂的「添加批注」浮窗。
   - 新建与编辑批注弹窗只保留一处明确取消/关闭按钮（消除标题栏与操作栏双「关闭」重复），并将 4 个颜色选项收整为单行，消除 390dp 窄屏 3+1 折行。

5. **P2 · 扫描体验与硬链接配置反馈**
   - 区分 `409 scan_busy`（提示「书库正在扫描，完成后重试」）与 `409 library_migration_busy`，不再统一显示通用冲突；Android `friendlyError` 与 Web 错误提示保留并展示诊断 ID（`X-Wildstring-Trace-Id`），服务端诊断日志记录关键书目写操作上下文（含封面上传与写锁冲突）。
   - `Books.scan()` 按书目/批次增量写回 `book_scan_jobs` 计数，Web 书库管理页展示实时进度并明确区分成功、部分失败（`completed_with_errors`）与失败。
   - Web 书库新建与迁移表单选择 `hardlink` 时显示同容器挂载示例（如 `/audiobooks/source` 与 `/audiobooks/managed`），并明确 `hardlink_cross_device` 提示「同一块盘上的两个独立 bind mount 也会失败」。

## 补充管理操作

- 所有者和有书库访问权限的曲库管理员可删除书目、单本重扫和配对拆分。编辑员可修改元数据和章节标题。Web 从卡片与详情进入管理，Android 从详情管理区进入，删除需二次确认。
- 单本重扫复用本地修复规则并保留个人锚点、校对与锁定字段。删除仅清理服务端记录、托管数据与缓存。Android 删除播放中的书目先清空播放器，成功后清理 Room 缓存并返回书架。
- 有访问权限的账号可标记完成或移除个人进度。书库删除及宿主机路径、迁移、建库与成员授权仅所有者操作。书库扫描或迁移期间拒绝删除。
- 回归覆盖四角色授权、源文件保留、单本修复、个人进度、Web 二次确认及 Android 状态操作。接口定义见[书架契约](../../contracts/bookshelf.md)。

## 不碰的边界

- 不修改数据库 schema 版本号（仍保持 `64`），不引入破坏性迁移；充分利用既有 `books` 元数据列与 `book_ebook_chapters.level`、`book_scan_jobs` 计数列。
- 不修改或删除用户只读导入源目录中的任何文件。
- 不在本分支自动操作生产/home 实例数据；home 现有数据修复在代码验收完成后通过新增保进度修复路径单独执行与验收。
- 不改写 Apple 端与与书架无关的音乐/播客模块。

## 方案与分模块改动

1. **后端解析与扫描**
   - `backend/src/wildstring/books/ebooks.py`：收紧 TXT 标题识别、输出语义 `level`（`1/2/3/0`）与可读兜底名称；EPUB 无标题纯图页命名「封面」。
   - `backend/src/wildstring/books/service.py`：分盘子目录归并、盘号+轨号冲突回退自然排序、简介 TXT 过滤与编码探测吸收、乱码修复与回退、作者/演播者分离、同父目录系列提取、增量写回 `book_scan_jobs` 进度、新增保进度修复流程（有声书 `chapter_remap` + 电子书字符偏移重映射阅读进度/书签/批注）。
   - `backend/src/wildstring/books/router.py` / `content.py` / `metadata.py`：扩展书籍列表/详情返回字段与搜索范围、暴露保进度修复入口、补充封面上传与写锁冲突诊断事件。
   - `contracts/bookshelf.md`：同步更新目录层级、分盘与简介识别、元数据返回与修复接口契约。
2. **Web 客户端**
   - `frontend/web/src/bookshelf.tsx`、`book-reader.tsx`、`bookshelf.css`：展示与编辑核心元数据与折叠「更多信息」、系列导航、分级目录与计数、识别 `scan_busy` 提示与诊断 ID。
   - `frontend/web/src/book-libraries-admin.tsx`：扫描任务运行中轮询与实时计数状态展示、部分失败区分、硬链接同容器挂载示例与 `hardlink_cross_device` 说明强化。
   - `frontend/web/src/locales/{zh-CN,en}.json`：同步中英文文案与报错键。
3. **Android 客户端**
   - `frontend/android/app/src/main/java/com/wildstring/app/data/Models.kt`、`Api.kt`、`Repository.kt`：扩展书目模型与元数据读写接口、`friendlyError` 区分 `scan_busy` / `library_migration_busy` 并保留诊断 ID。
   - `frontend/android/app/src/main/java/com/wildstring/app/ui/BookshelfScreen.kt`、`BookReaderPanel.kt`：详情页元数据与系列展示/编辑、分级目录与准确章节计数、选区就近批注浮条、批注弹窗单关闭按钮与单行颜色排布。
   - `frontend/android/app/src/main/res/values{,-zh}/strings.xml`：同步中英文资源。

## 验收（按 AGENTS.md §3 定级：L2）

- **静态与契约检查**：`make check` 通过（Ruff、Bandit、Prettier、TypeScript、i18n 键值、文档链接、过期测试断言检查）。
- **后端自动化测试**（合成文件与隔离书库）：
  - 多文件有声书同盘重复轨号（第 25 回标 `01`）、跨盘轨号重置、`DISC/`/`CD1`/`CD2` 归并、以及修复重排后保留 `book_listening_progress` 原文件位置与 `book_bookmarks`。
  - 覆盖四种伴随文本编码、分盘与父目录中的短杂项 TXT、章节标题和 16 KiB 准入边界、独立短篇、已跟踪 TXT 修复及监听判定一致性。
  - 覆盖重复标签回退文件名、修复与单书重扫保留手工章名，以及本地封面优先级、高清 JPEG 旋转缩放和上传限制。
  - 乱码 MP3 标签回退目录/文件名、有效中文标签保留、仅含 `artist`/`albumartist` 有声书不误填 `authors`、多卷同父目录提取 `series_name`/`series_index` 且不覆盖 `locked_fields`。
  - TXT 解析覆盖「第一季 → 第一卷 → 第一章」、正文句「第五个故事，重新回到西沙。」不误判、超长段 `level=0` 不污染语义目录计数，以及重解析后保住阅读进度与 `book_annotations` 原文锚点。
  - 扫描期间并发封面上传返回 `409 scan_busy` 且记录诊断事件、扫描中可观测到 `book_scan_jobs` 计数递增、区分 `completed` / `completed_with_errors` / `failed`。
- **Web E2E 与视觉验收**：运行受影响 Playwright 测试（`frontend/web/tests/bookshelf.spec.ts` 及管理表单用例），检查桌面与 390px 手机、浅深主题截图（详情元数据/系列/分级目录、编辑面板、硬链接表单与扫描进度状态）。
- **Android 构建、单测与设备验收**：`make android-ci` 通过；本地 KVM 模拟器（`-gpu swangle`）运行 `BookshelfRealBackendTest` 及新增选区批注/弹窗/目录回归，并逐张检查桌面/平板与手机浅深主题截图（重点核对批注选区浮条、单关闭弹窗、4 色单行排布、分级目录与 `scan_busy` 提示）。

## 风险与回滚

- 修改产品规则与文案前，先用 `git grep` 反查 `backend/tests/test_bookshelf.py`、`frontend/web/tests/bookshelf.spec.ts`、`frontend/android/app/src/androidTest/java/com/wildstring/app/BookshelfRealBackendTest.kt` 及 JVM 单测中依赖旧 `authors` 回退、`level=1` 计数或旧「添加批注」浮窗结构的断言，同步更新后再跑全量受影响测试。
- 乱码判定与修复必须保守，避免误伤合法中文、日文或拉丁扩展字符；测试必须包含正反例回归。
- 本次改动不修改 SQLite schema 版本，如遇异常可直接回退分支而不影响既有库结构。
