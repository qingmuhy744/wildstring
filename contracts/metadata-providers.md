# 联网资料与 Last.fm（0.2.2）

所有写操作需要登录与 `X-Wildstring-Client`。管理 API 仅管理员；个人 Last.fm API 使用当前登录账号，不接受其他用户 ID。默认关闭联网。

| 方法与路径（相对 `/api/v1`） | 用途 |
| --- | --- |
| GET /manage/providers | 读取公开设置、版本、代理和 Last.fm 是否配置；不返回密钥或代理 URL |
| PUT /manage/providers | 乐观版本检查保存设置；enabled、auto_new、musicbrainz、lastfm、caa、public_url、proxy_mode；可选 api_key/api_secret/proxy_url 更新私密配置 |
| POST /manage/providers/query | `{track_ids: [...]}`，每次 1–100 首；持久排队，活跃任务不重复创建 |
| GET /manage/providers/tracks/{id} | 最近任务、候选字段、来源、版本和封面候选 |
| POST /manage/providers/suggestions/{id}/apply | `{version, fields: [...]}`，选择要替换的字段；元数据变化返回 409，已应用返回 404 |
| POST /manage/providers/suggestions/{id}/cover | `{version}`，明确确认此候选封面，下载/解码/版本检查通过后保存 |
| GET /lastfm | 当前用户连接、同步开关、授权状态、队列计数；不返回 session key |
| POST /lastfm/authorize | 返回 Last.fm 官方授权 URL；管理员须配置公开回调地址和应用凭据 |
| GET /lastfm/callback | 公共授权回调；一次性随机 state 绑定用户，校验有效期与账号启用状态 |
| PUT /lastfm | `{version, scrobble, now_playing}`，当前用户同步偏好，默认关闭 |
| DELETE /lastfm | 断开当前账号、删除本地会话凭据、取消待发；不会撤销 Last.fm 上已有记录 |

代理模式 `environment` 默认、`custom` 或 `direct`。手动地址支持 `http://[user:password@]host:port`；留空字段不变，改为直连可停止使用。环境支持大小写 HTTP_PROXY / HTTPS_PROXY、ALL_PROXY 回退及 NO_PROXY。仅 HTTP 代理端点；HTTPS 目标通过 CONNECT。代理错误只回传固定错误码。

`POST /listening` 新增可选 `started_at`（Unix 秒）和 `state`（playing/paused/ended）；旧客户端省略 state 时仍累计本地记录，不推送正在播放。服务端核对开始时间、会话归属和实际累计，Last.fm 还要求曲长大于 30 秒且实际收听达到半曲/240 秒较短值。现有心跳间隔 5 秒。新客户端对 0.2.1 后端的收听请求会因额外字段返回 422，请同步升级服务端到 0.2.2；基础播放接口未改变。离线重启跨设备恢复不在本版范围。

元数据响应新增 composers/lyricists/arrangers/vocalists 等数组，external_ids 的 recording/release_track/release/release_group 是不同标识；artists/album_artists/works 标识为数组。`GET /artists`、`/artists/{id}/tracks` 和 `/artists/{id}/albums` 可传 role=artist/album_artist/vocalist/lyricist/composer/arranger，按歌曲去重统计。
