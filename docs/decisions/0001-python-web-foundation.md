# ADR 0001：Python 后端与 Web 优先

状态：已采用。日期：2026-10-15。

用户确定 AI native 定位，首版优先自然语言找歌与生成歌单，选择纯 Python 后端和 React 网页端。

采用 Python 3.12、FastAPI、React、TypeScript 和 Vite。后端按模块化单体组织，计算任务按需拆进程，共用代码；首版存储方向为 SQLite 和本地目录。

工程规范参考 QuicStudio 当前的 Makefile、pre-commit、Python 项目与 Docker 配置：采用 uv 锁文件、Ruff、Bandit、pytest、Make 和 Docker，保留版本一致、数据持久化和真实运行验证的做法，不复制其复杂基础设施。

pre-commit 使用本地 system hooks，通过同一份 uv.lock 调用 Python 工具。前端使用 npm 锁文件。外部 Actions 固定完整提交 SHA。Release 发布双架构 GHCR 镜像与 Web ZIP，原生安装包待客户端工程和签名方案确定后接入。

Python 原生依赖、计算资源与任务恢复仍需认真设计；实测发现明确性能或部署约束后再评估 Go。
