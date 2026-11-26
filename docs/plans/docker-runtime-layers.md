状态：已实施

# Docker 运行镜像独立应用层

## 目标

仅修改 Python 业务源码时，旧镜像可复用基础系统、媒体工具、Node、第三方 Python 依赖与 Web 静态文件层。

## 方案

- 从 `uv.lock` 导出带哈希的第三方运行依赖清单，避免应用版本号使依赖缓存失效。依赖阶段按清单同步 `/app/.venv`，并放置静态 `.pth`，把 `/app/app-site` 加入 Python 的包搜索路径。
- 保留 `builder` 阶段与其中的 uv。将应用及其分发元数据安装到 `/app/app-site`，在 Web 静态文件之后复制到运行镜像。
- 保留现有 Debian 媒体工具、多架构基础镜像、运行账户和 Compose 文件系统权限。

## 验收

- 容器打包验收按 L0 静态检查和 Docker 冒烟执行。使用隔离构建上下文，两次构建间只改变一处 Python 注释，比较镜像文件系统层摘要与应用层大小。
- 单独更新应用版本号时，复查依赖层摘要和新版本元数据。
- 验证镜像内版本和 `python -I` 下的插件载入，以及 `builder` 与测试镜像的构建链。
- 用隔离 Compose 项目执行 `make docker-up docker-smoke`。

在本机 `linux/amd64` 固定基础镜像摘要后，仅修改一处 Python 注释的两次构建复用了前 10 层。最后一层解压后为 2.27 MB，OCI 压缩层为 419,979 字节。单独更新应用版本号也复用了前 10 层，并返回新版本元数据。

`python -I` 插件导入、Compose 冒烟及 `builder` → `Dockerfile.tests` 构建链已通过，测试镜像中的曲库用例 22 个通过。`linux/arm64` 及 GHCR 跨版本拉取未实测。
