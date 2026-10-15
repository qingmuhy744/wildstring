# 野弦 WildString

[![CI](https://github.com/qingmuhy744/wildstring/actions/workflows/ci.yml/badge.svg)](https://github.com/qingmuhy744/wildstring/actions/workflows/ci.yml)

**AI native 的私人音乐播放器。** 从自己的音乐收藏出发，用自然语言找歌、生成歌单，让收藏的音乐有新的回响。

> 音乐不设限，自由有回响。

![野弦主页预览](assets/主页.jpg)

![野弦全屏播放与滚动歌词](assets/全屏播放.png)

## 名字的来处

「野弦」带着一点对中国摇滚的偏爱。

**野**，呼应崔健音乐中自由、不受拘束的气质；**弦**，呼应唐朝乐队的吉他，也代表音乐本身。**WildString** 延续这份意象，而 String 同时是琴弦与程序里的字符串，把热爱的音乐和写代码这件事连在一起。

我们希望野弦让用户保有自己的曲库、整理方式和选择，让 AI 帮助发现与理解音乐。这个名字表达个人喜好与致意，不代表与相关音乐人或乐队存在合作关系。

## 现在做什么

第一阶段使用 **Python 3.12 / FastAPI + React / TypeScript**，提供自托管服务与网页端。MVP 主线：导入本地曲库 → 浏览与播放 → 查看本地歌词 → 自然语言找歌 → 预览、保存并播放 AI 歌单。

当前已有工程基座、SQLite 托管曲库、只读源导入与目录整理、管理员登录、歌曲/专辑/艺人视图、封面与本地滚动歌词，以及原音串流和网页队列。支持全屏播放、下一首播放、队列排序、♥ 收藏、普通/规则歌单与收听次数/时长记录。已增加管理入口、网页导入/扫描、任务历史和单曲元数据覆盖编辑；AI API 配置与连接测试已接入设置。**批量整理、标签写回、转码和 Agent 业务仍待实现。** 详见 [MVP 范围](docs/product/scope.md)。

服务端元数据整理将支持手动/批量编辑、差异预览和显式写回，减少使用 mp3tag 前后下载与上传整首音频的重复传输，见 [整理设计](docs/architecture/metadata-repair.md)。

## 本地开发

准备 Git、[uv](https://docs.astral.sh/uv/)、Node 22.12+ 和 Make；容器运行需要 Docker Compose。

```sh
make setup         # 安装锁定依赖、创建 .env、安装 Git hook
make dev           # 终端一：API http://127.0.0.1:18780
make dev-web       # 终端二：React http://127.0.0.1:18781
make import-music  # 从只读源复制到托管库，整理目录并入库
make scan          # 重扫托管副本
make admin         # 首次交互设置 admin 密码；修改密码会撤销会话
make browser-install # 首次安装浏览器测试使用的 Chromium
make ci            # 提交检查、后端测试、Web 构建、锁文件核验
```

`make setup` 保留已有 `.env`。通过 `WILDSTRING_MUSIC_DIR` 指向自己的音乐目录；个人曲库、运行数据与模型密钥不入库。

仓库根目录 `data/` 已从 Git 和 Docker 构建上下文排除，可存放本地测试音乐。导入使用 `make import-music`；托管副本默认位于 `runtime/library/`。全量重扫使用 `make scan SCAN_ARGS=--full`。按“专辑艺人/专辑/CD01/01 - 歌名”整理副本，保留原件；重复导入不覆盖已有修改，见 [托管规则](contracts/managed-library.md)。

## Docker

```sh
make docker-up       # 构建、启动并等待健康检查
make docker-smoke    # 实测 API、Web、FFmpeg、非 root 与只读音乐目录
make docker-import   # 从只读源导入到持久卷 /data/library
make docker-scan     # 重扫托管副本
make docker-admin    # 首次设置容器的 admin 密码
make docker-status
make docker-down     # 停止服务，保留数据卷
```

容器内包含 Web，访问 [本地野弦](http://127.0.0.1:18780)。默认仅绑定回环地址，导入源只读挂载，托管曲库和运行数据放在持久卷。首次设置管理员后登录；可选在未跟踪的 `.env` 提供 `WILDSTRING_ADMIN_PASSWORD` 仅初始化首次密码，重置使用 Make 命令。HTTPS 部署设置 `WILDSTRING_COOKIE_SECURE=true`。

原音播放遵循浏览器的编码支持；不能解码时有错误提示，暂不自动转码。封面优先内嵌正面图片，再读同名图片或目录 cover/folder/front；同名 LRC 优先于内嵌歌词，点击底栏封面可展开全屏播放，支持逐行滚动与点击跳转；点击收起或按 Esc 返回，播放继续。见 [封面、专辑和歌词](contracts/local-library-assets.md)。收藏与歌单会持久保存，规则歌单支持按艺人、收藏、播放次数和累计收听等条件自动筛选；见 [个人曲库功能](contracts/personal-library.md)。队列仅保存在当前页面。见 [播放与认证接口](contracts/playback-auth-api.md)。管理功能与 AI 连接设置见 [曲库管理](contracts/library-management.md)。

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
- Android 已有 [首版设计](docs/product/android-v1.md) 与手机/平板 [交互草图](docs/design/android-v1.html)，可用 `make android-design` 预览；原生工程尚未实现，Actions 暂不生成 APK、IPA 或桌面安装包。

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
