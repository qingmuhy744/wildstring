状态：已交付于 PR #140

# 私有图片条件缓存与曲目物理路径权限收口

## 目标

1. 为 4 个已鉴权高频图片端点（`/api/v1/tracks/{track_id}/cover`、`/api/v1/podcasts/{podcast_id}/cover`、`/api/v1/podcasts/directory-cover/{key}`、`/api/v1/auth/avatar`）启用强内容哈希 `ETag`、`Cache-Control: private, no-cache`、`Vary: Cookie, Authorization, X-Wildstring-Library` 与 `If-None-Match` → `304 Not Modified` 条件协商，减少客户端重复传输封面与头像字节，同时保持退出登录与越权访问后的缓存安全隔离。
2. 修复 `get_track_file_info` 返回字段与 Web `TrackFileInfoDialog` 读取 `absolute_path` 不一致的既有缺陷，并将宿主机物理路径（`absolute_path`、`full_path`、`library_root`、`source_path`）的可见性在两条路由（`/api/v1/tracks/{track_id}/file-info` 与 `/api/v1/manage/tracks/{track_id}/file-info`）统一收口为仅 `owner` 可见、其余角色返回 `null`，同步隐藏 Web 弹窗中非 `owner` 的物理路径区块。
3. 同步更新 `contracts/local-library-assets.md`、`contracts/library-management.md` 与 `contracts/storage-and-podcast-resources.md` 中的图片缓存语义、文件信息权限边界及 `slow_download` 平缓下载契约说明。

## 不碰的边界

- 不放开 `/api/v1/*` JSON 接口、音频流（`/stream`）、歌词（`/lyrics`）或管理端候选预览（`/agent/drafts/{id}/cover-preview`、`/manage/providers/suggestions/{id}/cover-preview`）的 `private, no-store` 策略。
- 不改变 `PUT /api/v1/podcasts/{id}/download-settings` 允许已关注普通用户切换 `slow_download` 的既有行为。
- 不修改专辑发行锁与手工元数据编辑的现有权限规则。

## 方案

1. **条件图片缓存公共工具与白名单包装器放行**（`backend/src/wildstring/http_cache.py`、`site_access.py`）：
   - 实现 RFC 9110 §13.1.2 `etag_matches`（支持 `*`、逗号列表、`W/` 弱前缀）与 `private_image_response`，基于响应体 SHA-256 生成强 `ETag`，统一写入 `Cache-Control: private, no-cache`、`Vary: Cookie, Authorization, X-Wildstring-Library` 与 `X-Content-Type-Options: nosniff`，在 `GET`/`HEAD` 匹配 `If-None-Match` 时返回 `304 Not Modified`（空体）。
   - `HostAllowlist.private_send` 仅在 `/api/v1/` 内层响应显式声明 `cache-control: private, no-cache` 时保留该头，其余全部继续强制 `private, no-store`。
2. **接入 4 个画像/封面路由**：
   - `library/api.py`（`/tracks/{track_id}/cover`）、`podcast_artwork.py`（`/podcasts/{podcast_id}/cover`）、`podcast_search.py`（`/podcasts/directory-cover/{key}`）与 `avatars.py`（`/auth/avatar`）严格在会话与库/节目/账号授权校验通过后调用 `private_image_response`。
3. **文件物理路径字段对齐与权限收口**：
   - `file_reorganizer.py`：`get_track_file_info(repository, track_id, *, include_host_paths: bool = False)` 增加 `absolute_path` 并在 `include_host_paths=False` 时将 `absolute_path`、`full_path`、`library_root`、`source_path` 返回为 `None`；`library/api.py` 与 `management.py` 按 `user["profile"] == "owner"` 传入 `include_host_paths`。
   - `frontend/web/src/track-file-info-dialog.tsx`：`absolute_path` 改为可选可空字符串，当其为 `null` 或空串时隐藏 `serverAbsolutePath` 区块。
4. **契约文档与跨角色/跨主题验收**：
   - 更新三份 `contracts/` 文档，补充后端单元测试与 Web E2E 对照测试，并对 `TrackFileInfoDialog` 进行桌面/手机、浅色/深色主题及 `owner`/`listener` 视觉走查。

## 验收（按 AGENTS.md §3 定级）

本方案触及共享组件行为、接口缓存/权限契约及 Web `TrackFileInfoDialog`，并结合 `0.8.17` 发版按 **L3** 实测执行，所有以下条目均在最终代码改动后重新运行通过：

- 定向后端测试：`uv --directory backend run --frozen --extra community-sources pytest tests/test_file_reorganizer.py tests/test_assets.py tests/test_avatars.py tests/test_podcast_artwork.py -q` → **32 passed**（覆盖 `ETag`/`Vary`/`304`/失效与无权会话绝不返回 `304`，以及 `owner`/`librarian`/`editor`/`listener` 的 `file-info` 宿主机路径权限与字段对齐）。
- Web E2E 与视觉验收：`npm --prefix frontend/web run test -- track-file-info.spec.ts` → **4 passed**（`desktop` 与 `mobile` 均跑通 mock 重排及真实后端 `owner` vs `listener` 对照，重登录后服务端日志观察到缓存封面返回 `304`）；逐张查验全部 8 张截图 `artifacts/file-info-{owner,listener}-{desktop,mobile}-{light,dark}.png`，`owner` 可见宿主机物理路径且无溢出，`listener` 下「服务器绝对物理路径」区块干净隐藏且浅/深主题排版对齐。
- 全量质量与多端检查：
  - `make ci PYTEST_ARGS="-n auto"` → 全部通过：`make check`（17 项 pre-commit 钩子）、`make source-plugins`（10 项节点单测通过并打包 3 个插件 ZIP）、`make dependency-audit`（前后端插件 npm 零低危及以上漏洞）、`make test`（**891 passed, 2 skipped**）、全部 8 组 Playwright Web 套件（`test-web` **334 passed / 138 skipped**、`test-podcast-web` **94 passed**、`test-publisher-web` **6 passed**、`test-libraries-web` **18 passed**、`test-large-web` **2 passed**、`test-browse-web` **12 passed**、`test-catalog-web` **2 passed**、`test-transcoding-web` **4 passed**）及 `uv lock --check --project backend`。
  - 原生插件与三端检查：`make test-native-plugin`（`1 passed`）、`make ios-test`（`93 + 105 = 198` Swift tests passed）、`make macos-test`（`42 tests in 6 suites passed`）及 `make android-ci`（debug／release 编译、unitTest、`lintDebug`／`lintRelease` 与 APK 打包均成功）。
- 未覆盖范围：本机未启动 Docker daemon，容器 smoke／test 与 Android API 35 模拟器完整回归交由 GitHub Actions 执行。

## 风险与回滚

- 风险：旧客户端无条件缓存或代理误缓存跨账号图片；通过 `Cache-Control: private, no-cache`（每次使用须重验证）、`Vary: Cookie, Authorization, X-Wildstring-Library` 及鉴权先于 `If-None-Match` 防护。
- 回滚：可在 `site_access.py`、`http_cache.py` 与 `file_reorganizer.py` 按提交回退。
