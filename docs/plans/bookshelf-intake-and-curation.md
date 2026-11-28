状态：已确认

# 书架导入治理、章节批量管理与 AI 整理草案

## 目标

基于真实 94 GB / 39 本有声书库巡检结果，将书架导入与整理升级为「确定性扫描 + 显性待确认处置 + ABS 式章节批量管理 + AI 整理草案」四层闭环，避免代码硬编码猜词，同时支撑数百至两千余集的大型有声书合集。

按三个独立可交付阶段推进，每阶段独立评审、验收并合入 `main`：

- **阶段 1（导入治理，schema 65）**：外部侧车安全清洗策略（兼容 Audiobookshelf `metadata.json` 并可关闭）、书库级忽略规则、扫描跳过/待确认文件队列与显式处置（吸收为简介 / 作为电子书导入 / 忽略并沉淀规则），补齐 Web 管理与单书详情处置入口。
- **阶段 2（章节与音轨管理，schema 66）**：有声书章节书内分组（`section_title`）与非正片隐藏跳过（`hidden`）、便携侧车持久化、批量章节编辑 / 音轨重排 / 音轨重置为章节，以及 Web 双栏章节编辑器与 Web / Android 书内分组、大列表搜索定位与剩余时长展示。
- **阶段 3（AI 书目整理草案）**：复用 `agent_platform` 受控工具与草案体系，开放书架只读工具与 `book_curation` 整理草案（预览 diff → 确认 → 原子应用），覆盖杂项 `.txt` 提纯、复杂目录名拆角色、批量章节清洗、书内季/篇分组与广告轨识别；无模型时完全降级可用。

## 不碰的边界

- 只读导入源目录严禁修改、移动或删除；任何吸收、导入、忽略与整理动作只操作数据库、托管副本与便携侧车。
- 所有公开 API 严禁向非 `owner`（及待确认列表本身）泄露服务器物理绝对路径，只暴露相对路径与安全 ID。
- 不修改五端版本号与发布标签；不将第三方侧车无条件覆盖用户已锁定或手工编辑的字段。
- 修改或删除任何契约、接口字段、i18n 键值或测试断言前，先用 `git grep` 反查并同步关联测试（含后端、Web E2E 与 Android 契约测试）。

## 方案

### 阶段 1 · 导入治理与待确认文件队列

阶段 1 已实施。schema 65 与本地扫描、待确认处置 API 已接通，Web 管理中心和单书详情复用队列界面。当前行为见[书架契约](../../contracts/bookshelf.md#扫描待确认文件)。阶段 2 与阶段 3 仍待实施，方案整体保留「已确认」状态。

1. **数据库迁移（`SCHEMA_VERSION = 65`）**
   - `book_libraries` 新增：
     - `external_metadata_mode TEXT NOT NULL DEFAULT 'sanitized' CHECK(external_metadata_mode IN ('off','sanitized'))`
     - `ignore_patterns_json TEXT NOT NULL DEFAULT '[]'`
   - 新增表 `book_scan_skipped_files`：记录被扫描门禁跳过的只读源 `.txt` 文件（`id`, `library_id`, `book_id`, `source_root`, `source_path`, `relative_path`, `file_size`, `reason`, `status`, `preview_text`, `cleaned_preview`, `updated_at`），唯一约束 `(library_id, source_path)`，索引 `(library_id, status, book_id)`。
2. **外部侧车安全兼容清洗（`directory_metadata`）**
   - `external_metadata_mode = 'off'` 时仅读取 `.wildstring/manifest.json`、`desc.txt`、`reader.txt`，跳过第三方 `metadata.opf` / `metadata.json`。
   - `external_metadata_mode = 'sanitized'`（默认）时：
     - 兼容解析 ABS `metadata.json` 的 `series: ["系列名 #1"]` 数组（拆分 `series_name` / `series_index`）及 `publishedYear`；
     - 剥离 `description` 中的 HTML 标签与实体为干净纯文本，过滤已知转码器签名噪声（如 `Bilibili VXCode Swarm Transcoder ...`、`Lavf...`）；
     - 过滤明显把父级多卷系列目录名误填为 `authors` 的脏数据；
     - 始终尊重 `locked_fields_json` 与 `overrides_json`。
3. **书库级忽略规则与待确认文件收集**
   - 书库配置支持维护 `ignore_patterns`（最多 64 条、单条 1–200 字符的 glob 模式，按大小写不敏感匹配文件名或相对路径），`scan()` 与 `watch_probe()` 共用同一忽略判定，确保被忽略文件不建书、不入待确认队列、不触发监听空转。
   - 被客观 `.txt` 门禁跳过的未入库文件写入 `book_scan_skipped_files`，自动关联同目录归属书目 `book_id`，生成原始预览（`preview_text`）与剥离 BBCode（`[img]`/`[b]`/`[color]`/`[size]`）及常见版权免责段落后的推荐纯文本预览（`cleaned_preview`）。
   - 已人工处置（`absorbed_description` / `imported_ebook` / `ignored`）且源文件未变更的记录在重扫时不被翻回 `pending`；源文件已删除或已入库时清理失效 `pending` 项。
4. **管理 API（`books:manage_libraries` + 书库访问授权 + 客户端标头）**
   - `POST/PUT /api/v1/book-libraries` 与 `GET /api/v1/book-libraries` 支持 `external_metadata_mode` 与 `ignore_patterns`。
   - `GET /api/v1/book-libraries/{library_id}/skipped-files`：按 `status`、`book_id`、分页返回待确认项与 `pending_count`（只返回 `relative_path`，不暴露物理绝对路径）。
   - `POST /api/v1/book-libraries/{library_id}/skipped-files/{item_id}/resolve`：支持三种动作：
     - `absorb_description`：可指定同库 `book_id` 与编辑后文本，写入并锁定书目 `description`，导出便携侧车；
     - `import_ebook`：校验源文件仍位于已注册来源且非符号链接，显式绕过扫描门禁按书库存储模式导入为电子书（支持配对目标书或独立建书）；
     - `ignore`：标为 `ignored`，可选附带 `add_pattern` 沉淀至书库 `ignore_patterns` 并批量忽略该库内匹配的其他 `pending` 项。
5. **Web 管理与单书详情处置 UI**
   - 「管理中心 → 书架 → 书库与存储」表单增加「外部侧车兼容」与「扫描忽略规则」；选中书库下展示「待确认文件」区块（预览原文/清洗预览、吸收为简介可编辑确认、作为电子书导入、忽略或按同名规则忽略全部）。
   - 单书详情页对有管理权限的账号，仅在该书存在 `pending` 待确认文件时展示紧凑折叠条，支持就地处置。

### 阶段 2 · 章节/音轨批量管理与书内分组（后续 PR）

- `SCHEMA_VERSION = 66`：`book_audiobook_chapters` 新增 `section_title` 与 `hidden` 列并写入便携侧车；新增批量章节编辑、音轨重排与「将音轨设为章节」端点；Web 双栏章节管理页 + Web / Android 书内分组、大列表检索定位与剩余时长展示。

### 阶段 3 · AI 书目整理草案（后续 PR）

- 扩展 `agent_platform` 书架只读工具与 `book_curation` 受控草案（元数据修正、章节批量清洗/分组/隐藏广告轨、待确认文本处置建议），Web 接入预览 diff 与一键应用。

## 验收（按 `AGENTS.md` §3 定级：阶段 1 为 L2）

- `make check` 全绿（含 Ruff、Bandit、Web TypeScript/Prettier、i18n 键值、文档链接与过期测试断言）。
- 后端测试覆盖：schema 64→65 升级与幂等性、ABS `metadata.json` 清洗（`series` 数组、HTML 剥离、转码器签名过滤、父目录脏作者拦截）与 `off` 模式、`ignore_patterns` 在扫描与监听中的一致性、BBCode 清洗预览、`absorb_description` / `import_ebook` / `ignore` + `add_pattern` 批量忽略、越权（`editor`/`listener`/无授权库）与符号链接越界拒绝、响应不泄露物理路径。
- Web E2E（`frontend/web/tests/bookshelf.spec.ts`）覆盖书库策略配置、待确认文件预览与三种处置流程（含单书详情快捷处置），渲染桌面与 390px 手机、浅深主题截图并逐张视觉复查。

## 风险与回滚

- **CodeQL 路径安全**：所有 resolve / import 操作必须只使用从数据库查出的 `library["id"]`、`book["id"]`、`source_root` 与 `relative_path`（结合 `open_source` 边界校验），不将 URL 路径参数或用户可控路径直接拼入文件操作。
- **监听空转风险**：`watch_probe()` 必须同步应用 `ignore_patterns` 与待确认跳过逻辑，保证被跳过的 `.txt` 不会反复触发增量扫描。
- **回滚**：每阶段为独立 PR；阶段 1 新增表与列均带向后兼容默认值，不破坏现有读写接口与旧客户端请求体。
