# 野弦 WildString

[![CI](https://github.com/qingmuhy744/wildstring/actions/workflows/ci.yml/badge.svg)](https://github.com/qingmuhy744/wildstring/actions/workflows/ci.yml)

**AI native 的私人音乐播放器。** 从自己的音乐收藏出发，用自然语言找歌、生成歌单，让收藏的音乐有新的回响。

> 音乐不设限，自由有回响。

## 名字的来处

「野弦」带着一点对中国摇滚的偏爱。

**野**，呼应崔健音乐中自由、不受拘束的气质；**弦**，呼应唐朝乐队的吉他，也代表音乐本身。**WildString** 延续这份意象，而 String 同时是琴弦与程序里的字符串，把热爱的音乐和写代码这件事连在一起。

我们希望野弦让用户保有自己的曲库、整理方式和选择，让 AI 帮助发现与理解音乐。这个名字表达个人喜好与致意，不代表与相关音乐人或乐队存在合作关系。

## 现在做什么

第一阶段使用 **Python 3.12 / FastAPI + React / TypeScript**，提供自托管服务与网页端。MVP 主线：导入本地曲库 → 浏览与播放 → 查看本地歌词 → 自然语言找歌 → 预览、保存并播放 AI 歌单。

当前已建立工程基座：配置、健康检查、React 服务连接页、依赖锁定、pre-commit、Make、Docker 与 GitHub Actions。**音乐导入、播放器、歌词和 AI 业务尚未实现。** 详见 [MVP 范围](docs/product/scope.md)。

## 本地开发

准备 Git、[uv](https://docs.astral.sh/uv/)、Node 22.12+ 和 Make；容器运行需要 Docker Compose。

```sh
make setup         # 安装锁定依赖、创建 .env、安装 Git hook
make dev           # 终端一：API http://127.0.0.1:18780
make dev-web       # 终端二：React http://127.0.0.1:18781
make ci            # 提交检查、后端测试、Web 构建、锁文件核验
```

`make setup` 保留已有 `.env`。通过 `WILDSTRING_MUSIC_DIR` 指向自己的音乐目录；个人曲库、运行数据与模型密钥不入库。

## Docker

```sh
make docker-up       # 构建、启动并等待健康检查
make docker-smoke    # 实测 API、Web、FFmpeg、非 root 与只读音乐目录
make docker-status
make docker-down     # 停止服务，保留数据卷
```

容器内包含 Web，访问 [本地野弦](http://127.0.0.1:18780)。默认仅绑定回环地址，音乐目录只读挂载，运行数据放在持久卷。当前基座尚无账号认证，不应直接开放到公网。

## 分支与提交规范

`main` 为默认集成分支，日常开发从最新 `main` 创建短期分支，通过 PR 合并；暂不设长期 `develop` 分支。

| 前缀 | 用途 | 示例 |
| --- | --- | --- |
| `feat/` | 新功能 | `feat/ai-playlists` |
| `fix/` | 缺陷修复 | `fix/audio-range` |
| `docs/` | 文档 | `docs/provider-research` |
| `chore/` | 工程、依赖、CI | `chore/update-python-deps` |
| `refactor/` | 保持行为的重构 | `refactor/library-scanner` |
| `test/` | 测试与测试样本 | `test/chinese-track-matching` |

主题使用简短英文小写与连字符；需要关联 Issue 时可用 `feat/123-ai-playlists`。一个分支聚焦一项工作，合并后删除。只有需要版本稳定维护时才使用 `release/0.1`，不为每次发布强制建立发布分支。

提交建议采用 `type(scope): description`，例如 `feat(ai): add playlist preview`、`docs: explain project naming`。PR 前运行 `make ci`；修改运行或部署行为时同时验证 Docker。

发布使用 `v0.1.0`、`v0.1.0-rc.1` 等 **Git 标签与 GitHub Release**，与开发分支分别管理。这些是协作约定，仓库级分支保护另行配置。

## CI/CD

- `main` 提交和 PR：检查、测试、Web 构建与容器实测。
- 发布 GitHub Release：先通过完整检查，再发布 amd64/arm64 镜像到 `ghcr.io/qingmuhy744/wildstring`，附加 Web ZIP 与 `SHA256SUMS`。
- 正式 Release 更新 `latest`；预发布保留独立版本标签。
- 当前没有原生客户端，暂不生成 APK、IPA 或桌面安装包。

见 [开发与部署](docs/development.md)、[发布流程](docs/releasing.md)。

## 目录

```text
backend/          Python 项目、src/wildstring、测试与 uv.lock
frontend/web/     React + TypeScript + Vite 与 package-lock.json
contracts/        后续 API 契约与结构化 AI 工具定义
docs/             产品、架构、调研、技术决策与工程说明
deploy/           Dockerfile 与 Compose
scripts/          初始化、全量 hooks 检查与发布打包
tests/fixtures/   后续使用的合法测试样本
```

[组件分工](docs/architecture/components.md) · [技术决策](docs/decisions/0001-python-web-foundation.md) · [原始讨论](docs/research/README.md)

许可证沿用仓库已有的 [GPLv3](LICENSE)。
