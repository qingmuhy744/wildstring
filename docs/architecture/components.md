# 组件分工

后端使用 **Python 3.12 模块化单体（FastAPI）**，客户端覆盖 **Web（React 19 + TypeScript）、macOS（SwiftUI + AppKit）、iOS（SwiftUI）与 Android（Kotlin + Jetpack Compose + Media3）**。存储采用 SQLite（WAL）与本地托管文件目录，不依赖外部数据库、Redis 或独立消息队列。

## 当前工程

| 组件 | 当前实现 |
| --- | --- |
| `backend/src/wildstring/config.py` & `server_settings.py` | 环境配置、目录与端口校验、服务器名称与 HTTP/HTTPS 连接安全策略（支持数据库覆盖） |
| `backend/src/wildstring/main.py` | FastAPI 工厂、健康检查、诊断中间件、Streamable HTTP MCP 挂载与可选 Web 静态托管 |
| `backend/src/wildstring/database.py` | SQLite 演进式迁移（当前 `SCHEMA_VERSION = 48`）、WAL、独立读写连接、按请求绑定 `active_user` 与就绪检查 |
| `backend/src/wildstring/auth.py` & `permissions.py` | 四角色多用户体系（`owner` / `admin` / `editor` / `listener`）、scrypt 密码、持久可撤销会话、按用户音乐库授权与登录限流防护 |
| `backend/src/wildstring/library/` | 多音乐库与只读导入源管理、托管副本复制整理、WAV/CUE 分轨转 FLAC、增量扫描、专辑/艺人/曲目查询、封面继承、双语/逐字歌词、个人歌单/收藏/统计、Range 原音串流与按需 AAC 实时转码 |
| `backend/src/wildstring/podcasts.py` & `podcast_*.py` | 播客 RSS 订阅、Apple Podcasts 多区并行目录搜索、OPML 导入导出、热门探索、按用户关注与收听进度、后台音频下载与零引用资源保留期清理 |
| `backend/src/wildstring/providers.py` & `music_sources.py` | MusicBrainz / AcoustID / CAA / Last.fm 联网元数据与同步，以及独立 ZIP 数据源插件（QQ / 酷狗 / 网易云 Node 运行时与 Nuitka 原生扩展） |
| `backend/src/wildstring/agent_*.py` & `mcp_*.py` | AI 助手多协议连接（Chat Completions / Responses）、可选联网检索与长期记忆、受控业务工具、6 类整理草案与批量核对、定时规则/AI 巡检、站内与 Telegram 通知、stdio 及 Streamable HTTP MCP 接入 |
| `backend/src/wildstring/diagnostics.py` | 结构化脱敏日志、可配置采集等级（`INFO` / `DEBUG` 等）、异常调用栈因果链采集与限时模块级调试 |
| `frontend/web` | 响应式桌面与移动 Web 端：三栏播放壳层、曲库浏览、电台、每日推荐、AI 音乐助手、个人设置（含 MCP 接入模板生成）与管理中心 |
| `frontend/macos` | 原生 macOS 客户端：多服务器与多线路切换、全屏封面/黑胶/磁带/电台播放、毛玻璃抽屉待播队列、桌面悬浮逐字歌词、菜单栏控制、AI 助手与 GitHub Releases 自动更新检测 |
| `frontend/android` | 原生 Android 客户端：多服务器与多线路连接、曲库/发现/电台/每日推荐、离线缓存、跨设备接续、AI 助手与本地崩溃日志收集导出 |
| `frontend/ios` | 原生 iOS 客户端（`WildStringKit` + SwiftUI）：多线路连接、曲库与播客播放、迷你与全屏播放器、锁屏媒体控制与进度同步 |
| `deploy` & `.github/workflows` | 包含 Web 与 FFmpeg 的非 root 生产容器镜像、只读源挂载、持久数据卷，以及全量 CI、Android/macOS/iOS 构建、CodeQL 与 Release 流水线 |

`/health` 表示进程存活；`/health/ready` 检查运行目录可写、音乐目录可读与 SQLite 可查询。它不测试浏览器解码或外部模型可用性；播放与多端交互通过独立集成测试验收。

## 数据与安全不变量

- **只读导入源与托管副本**：导入源目录严格只读，导入时复制到托管曲库并整理路径；播放、整理和未来显式写回只针对托管副本。用户修正与 AI 建议先存 SQLite 覆盖层，显式操作才写回副本标签。
- **显式 Schema 迁移**：数据库使用 `PRAGMA user_version` 标记并事务初始化（当前版本 `48`）；高于应用支持版本时拒绝启动，不自动降级。
- **权限与工具同源校验**：内部主键由野弦生成，外部平台 ID 作为映射。AI 助手与 MCP 工具复用普通业务服务与权限校验（含多库授权与角色边界），模型不可用绝不阻断基础浏览与播放。

[服务端修复与写回设计](metadata-repair.md) · [Agent 平台契约](../../contracts/agent-platform.md) · [多库与个人关注](../../contracts/multiple-libraries.md)
