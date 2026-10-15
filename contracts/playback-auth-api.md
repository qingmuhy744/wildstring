# 管理员与原音播放 API

当前为单管理员、单曲库。网页、API 和音频使用同一个 HttpOnly / SameSite=Strict 会话 Cookie，不在音频 URL 放令牌。所有曲库、扫描记录和音频请求均需登录；健康检查、静态网页和认证状态可匿名访问。

## 管理员

- 账号固定为 `admin`。首次在可信服务端终端执行 `make admin`（Docker 使用 `make docker-admin`），交互输入 12–128 字符密码。没有默认密码，也没有匿名网页注册接口。
- 可通过未跟踪的 `.env` 中 `WILDSTRING_ADMIN_PASSWORD` 在首次启动时初始化；已有管理员时忽略该值。密码使用随机盐与 scrypt 存储，服务端不保存明文。
- 修改密码撤销全部会话；退出撤销当前会话；会话有效期 7 天，重启后保留。SQLite 只保存令牌哈希，原令牌仅发到 Cookie。
- 连续 5 次失败会暂停登录 60 秒；这是单实例的基础限流，不是公网接入方案。
- 登录和退出需 `X-Wildstring-Client: web` 请求头，不开放跨域 CORS。HTTPS 部署设置 `WILDSTRING_COOKIE_SECURE=true`；本机 HTTP 默认 false。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v1/auth/status` | 返回 `configured`、`authenticated` 布尔值，响应不缓存 |
| POST | `/api/v1/auth/login` | JSON `{username, password}`；成功 200 并设置 Cookie；错误密码 401，限流 429，未初始化 503 |
| POST | `/api/v1/auth/logout` | 撤销当前会话、清 Cookie，返回 204；可重复调用 |

## 原文件串流

`GET /api/v1/tracks/{id}/stream` 与 `HEAD /api/v1/tracks/{id}/stream` 按数据库中的真实曲目 ID 读取当前托管曲库，只读，不触发导入、扫描或转码。

- MP3 / FLAC / M4A 对应 `audio/mpeg` / `audio/flac` / `audio/mp4`。
- GET 支持单段 `Range: bytes=start-end`、开放末尾和后缀范围，返回 206、Content-Range 与准确的 Content-Length；无效或越界范围返回 416 与 `bytes */size`。
- HEAD 返回完整文件头、Accept-Ranges、ETag、Last-Modified，无正文；忽略 Range。
- If-Range 与当前 ETag 或 Last-Modified 不匹配时返回完整 200。多段 Range 与未知单位当前忽略并返回完整 200。
- 每次请求先认证，再从已打开的文件描述符验证大小、纳秒修改时间；从同一描述符按最多 256 KiB 分块读取。进度跳转、切歌和断开后关闭描述符，不把整首歌读入内存。
- 曲目不存在或文件已消失返回 404；已扫描为不可用、源文件发生变化或无法安全打开返回 409；未登录返回 401。路径不来自请求参数，拒绝绝对路径、父目录及 POSIX 符号链接替换。
- 响应使用 `Cache-Control: private, no-store`，减少共享浏览器退出后复用缓存。已加载进客户端的音频字节不可能通过服务端撤回；网页退出会停止并卸载播放器。

HTTP 行为参考 [MDN Range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)。当前没有转码、音频归一化、音效、跨设备队列或离线缓存。可扫描不等于浏览器可解码，无法解码时网页提示并允许换歌/重试。

## 网页播放

- 登录后分页浏览与中文关键词搜索；按钮播放当前结果页，超过 50 首时明确显示“播放本页”。播放队列从该页建立，之后搜索不会替换队列。
- 播放/暂停、上一首/下一首、拖动进度、桌面音量、加入队列与删除非当前曲目；播放结束自动前进，队尾停止，不自动循环。
- 队列只在当前页面内存中保存，刷新后重建；浏览器支持时接入 Media Session 元数据与系统控制。
- 手机布局优先使用设备音量，页面不显示音量滑条。封面、专辑视图和滚动歌词见 [本地资源](local-library-assets.md)。
- 文件变化、解码失败、连接中断与认证失效会反馈；重试重新请求原文件。没有后台重扫按钮，使用 Make 导入或重扫后刷新列表。

## 验证

`make browser-install` 后运行 `make ci`，会运行后端测试、构建 Web 并启动隔离的临时曲库，验证桌面与手机视口的登录、中文搜索、空状态、真实 MP3 播放、暂停、Range、进度、切歌、队列、错误反馈和会话失效。浏览器用自有静音测试文件，完全不读取个人曲库。浏览器测试配置参考 [Playwright Web server](https://playwright.dev/docs/test-webserver)。这些检查不能代替 Android / iOS 真机及不同浏览器的兼容验证。
