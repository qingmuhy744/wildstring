# 组件分工

后端使用 **Python 模块化单体**，前端使用 **React + TypeScript**，Go 暂不引入。存储计划采用 SQLite 与本地文件，暂不要求 PostgreSQL、Redis、消息队列或独立向量数据库。

## 当前工程

| 组件 | 当前实现 |
| --- | --- |
| `backend/src/wildstring/config.py` | 环境配置、目录与端口校验 |
| `backend/src/wildstring/main.py` | FastAPI 工厂、健康检查、可选 Web 静态托管 |
| `backend/src/wildstring/database.py` | SQLite v1→v2 迁移、WAL、独立读写连接与就绪检查 |
| `backend/src/wildstring/library` | 本地标签读取、增量扫描、运行记录、需登录的只读查询 API 与 Range 原音串流 |
| `backend/src/wildstring/auth.py` | 单管理员 scrypt 密码、持久可撤销会话与基础登录限流 |
| `frontend/web` | 登录、分页搜索、原音播放器、页面内队列与桌面/手机布局 |
| `deploy` | 包含 Web 的 Python 镜像、FFmpeg、只读音乐与持久数据卷 |
| `.github/workflows` | 提交检查、容器验证和 Release 发布定义 |

`/health` 表示进程存活；`/health/ready` 检查运行目录可写、音乐目录可读与 SQLite 可查询。它不测试浏览器解码或模型可用性；播放链路通过独立浏览器测试验收。

## 规划中的模块

- `library`：曲目、歌手、专辑、文件和外部标识，拥有核心曲库数据。
- `playback`：鉴权后访问文件、Range 响应与播放信息。
- `metadata` / `lyrics`：本地信息、用户覆盖值与可替换数据源。
- `playlists`：歌单与队列业务规则。
- `ai`：模型适配、对话和检索编排；调用受控业务工具，不绕过权限。
- `jobs`：持久任务、执行、重试与恢复；需要隔离计算时使用同一代码库的独立 Worker。

当前已有 SQLite v2、管理员认证和手动扫描进程，尚无通用持久任务调度和自动 Worker。schema 使用 `PRAGMA user_version` 标记并事务初始化；高于应用支持版本时拒绝启动，不自动降级。后续版本变更需编写显式迁移。`contracts` 保存 API 与 AI 工具结构定义。

内部主键由野弦生成，平台 ID 作为外部映射。用户修正先存数据库，显式操作才写回原文件。模型进程的计算资源与音乐服务分开评估。

[服务端修复与写回设计](metadata-repair.md) · [Navidrome 参考范围](../research/navidrome-reference.md)
