# WildString 工作约定

- 产品定位为 AI native 的自托管音乐播放器。当前 MVP 是 Python 后端与 React 网页端，AI 优先做自然语言找歌和生成歌单。
- 先读 `docs/product/scope.md`。文档中的计划不代表已实现，交付时分别说明实现与验证状态。
- Python 使用 3.12 和 `backend/uv.lock`；前端使用 Node 22 与 `package-lock.json`。开发入口统一放入 Makefile。
- 初始化用 `make setup`，检查用 `make ci`，容器验证用 `make docker-up docker-smoke`。修改依赖后更新对应锁文件。
- Python 使用 Ruff 与 Bandit；pre-commit 工具复用 uv 锁文件，不另维护一套 hook 版本。
- 本地音乐目录默认只读。用户修正与 AI 建议先存入数据库，未经明确操作不写回原始音乐文件。
- AI 工具操作真实曲目 ID，遵守与普通 API 相同的权限和校验。模型不可用不应阻断基础播放。
- Docker 数据放入持久卷，默认只监听宿主机回环地址。停止命令不删除数据卷。
- 凭据仅放在未跟踪的 `.env` 或 CI secrets 中，不打印令牌，不提交本地音乐、运行数据和构建缓存。
- 保留用户已有修改。提交前检查 diff、敏感信息与大文件；推送后核验远程提交和 Actions 结果。
