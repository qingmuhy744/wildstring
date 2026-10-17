# 联网诊断与元数据任务反馈

2026-10-17。当前修复分支的实现说明；合并、发布与 home 部署分别验收。

## 网页网络检测

管理员打开「管理 → 设置 → 联网资料」，在代理地址旁点击「检测网络」。请求由服务端发出，使用点击时的代理方式、代理草稿地址，以及已经保存的 API 密钥；检测不会保存表单或修改曲库。

检测固定访问 MusicBrainz、Last.fm、Cover Art Archive、AcoustID，不接受客户端传入目标地址。每个来源分别显示可连接／连接失败／未配置、耗时、HTTP 状态及实际是否走代理。缺少 Last.fm 或 AcoustID 密钥时不请求对应服务。允许先测试尚未保存的代理，保存设置仍是独立操作。

普通联网请求和检测共用代理解析规则：直接连接、手动 HTTP 代理、环境变量 HTTP_PROXY／HTTPS_PROXY／ALL_PROXY；NO_PROXY 由同一个标准库处理。代理可包含认证，用户名、密码、API Key、API Secret 和外部原始错误不进入响应或诊断日志。环境变量采用 Python urllib 的大小写优先规则。

各来源并行检测，每个请求的 socket 超时为 8 秒，响应最多读取 256 KiB。单进程同时只运行一组检测。DNS 解析仍受系统解析器影响，不承诺整组在严格 8 秒内结束；网页提供超时恢复，不会因此重复提交元数据任务。

固定公共样本：MusicBrainz 艺人查询、Last.fm `artist.getInfo` 的 Cher 样本、AcoustID 文档中的 track ID 查询。CAA 使用一个固定不存在的发行版，收到 404 代表服务已响应；不下载封面，也不代表 archive.org 图片下载链路通过。检测不发送私人歌曲信息或音频。连接成功不保证某首歌已被来源收录，也不验证 Last.fm 用户授权或 API Secret。

接口为 `POST /api/v1/manage/providers/network-test`，需要管理员会话及 `X-Wildstring-Client`。仅接受 `proxy_mode` 与可选 `proxy_url`，其余字段拒绝。响应包含 `proxy_mode`、四项 `items`；每项有 `provider`、`status`、`elapsed_ms`、`via_proxy`、`code` 和可选 `http_status`。不缓存结果。

## 刷新任务的完整反馈

`POST /api/v1/manage/providers/refresh` 保留原有 `queued`、`already_active`、`total`，新增 `batch_id`。同一事务记录本批新任务及已在运行的任务，复用不会重复执行。旧 `/query` 接口的响应不变。

网页入队后每 2 秒读取 `GET /api/v1/manage/providers/refresh/{batch_id}`。显示本批总数、排队、查询中、建议已生成、失败、无新增资料、歌曲已变化，以及逐曲错误原因。全部进入终态后停止轮询；读取状态失败只重试 GET，不重新入队。关闭弹窗后服务端任务继续，管理「任务记录」和歌曲「联网建议」也展示安全中文错误说明。

进度汇总覆盖全部成员，不依赖最近 20 条任务列表。逐曲详情最多返回 1000 项，超出时标记 `truncated`，总计数仍完整。任务或曲目硬删除后保留成员快照并显示 stale。批次属于当前曲库，仅管理员可读。SQLite 从 schema 14 原子升级到 15，批次在服务重启后保留；本次不自动清理批次历史。

## Last.fm 排查

回调成功、失败和参数校验失败均使用 `no-store` 与 `no-referrer`。应用工厂安装访问日志过滤器，覆盖 Docker 使用 Uvicorn 的启动方式，移除回调查询参数。换取会话失败仅记录内部固定错误码，不记录 token、state、会话密钥、完整 URL、签名或远端错误文本；Last.fm 非 2xx 的 JSON 错误保留数值错误码。

会话密钥按不透明凭据保存，校验为非空、最多 256 字符、可打印且不含空白。不能套用 API 方法签名的“32 位十六进制 MD5”格式：原检查会误拒非十六进制的有效会话密钥。本次已加入正负回归，仍拒绝空值、控制字符和错误的会话对象。

授权仍保持一次性消费。换取会话失败后必须从 App／网页重新发起授权，重复打开旧链接可能显示 `lastfm_auth_expired`。检测网络与签名错误日志用于区分网络、凭据、授权拒绝和响应格式问题，不放宽授权校验。

## 验证边界

自动化使用合成曲库与模拟外部响应，覆盖代理草稿不保存、密钥不回显、固定目标、缺配置、TLS／DNS／超时分类、权限、批次并发复用／隔离／迁移，以及桌面和触屏进度交互。真实自托管部署先只读排查，经用户批准备份并部署最小诊断补丁后，确认实际会话密钥为 32 位非十六进制字符串；修正校验后，用户全新授权成功，回调 200、绑定状态及同步偏好已核验。没有输出或重放真实 token；收听记录投递不能仅凭绑定成功推定。

参考：[Last.fm artist.getInfo](https://www.last.fm/api/show/artist.getInfo)、[AcoustID Web Service](https://acoustid.org/webservice)、[MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API)。
