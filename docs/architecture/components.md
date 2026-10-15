# 组件分工

后端使用 **Python 模块化单体**，前端使用 **React + TypeScript**，Go 暂不引入。存储计划采用 SQLite 与本地文件，暂不要求 PostgreSQL、Redis、消息队列或独立向量数据库。

## 当前工程

| 组件 | 当前实现 |
| --- | --- |
| `backend/src/wildstring/config.py` | 环境配置、目录与端口校验 |
| `backend/src/wildstring/main.py` | FastAPI 工厂、健康检查、可选 Web 静态托管 |
| `frontend/web` | React 工程与真实后端连接状态展示 |
| `deploy` | 包含 Web 的 Python 镜像、FFmpeg、只读音乐与持久数据卷 |
| `.github/workflows` | 提交检查、容器验证和 Release 发布定义 |

`/health` 表示进程存活；`/health/ready` 检查运行目录可写与音乐目录可读。当前不表示数据库、模型或尚未实现的音乐功能已经可用。

## 规划中的模块

- `library`：曲目、歌手、专辑、文件和外部标识，拥有核心曲库数据。
- `playback`：鉴权后访问文件、Range 响应与播放信息。
- `metadata` / `lyrics`：本地信息、用户覆盖值与可替换数据源。
- `playlists`：歌单与队列业务规则。
- `ai`：模型适配、对话和检索编排；调用受控业务工具，不绕过权限。
- `jobs`：持久任务、执行、重试与恢复；需要隔离计算时使用同一代码库的独立 Worker。

目前尚无数据库、任务系统或 Worker 服务，随对应功能落地再加入迁移和运行命令。`contracts` 保存后续 API 与 AI 工具结构定义。

内部主键由野弦生成，平台 ID 作为外部映射。用户修正先存数据库，显式操作才写回原文件。模型进程的计算资源与音乐服务分开评估。
