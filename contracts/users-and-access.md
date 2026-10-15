# 本地用户、权限与域名白名单

状态：实现于当前开发分支，验证结果见交付说明。SQLite schema v10；历史 admin 密码、有效会话、歌曲 ID、歌单、收藏及收听统计迁移保留。当前不提供公开注册、邮件找回或账号删除。

## 角色与身份

音乐、封面、歌词是共享曲库；收藏、普通/规则歌单、播放次数、时长与最近播放按用户隔离。管理员也只能通过个人歌单接口操作自己的歌单，不因管理员身份获得其他用户的个人数据。

- `admin`：曲库管理、元数据与歌词编辑、任务、AI 连接和访问设置、账号管理。
- `user`：浏览与播放共享曲库、读取歌词、管理自己的收藏/歌单/收听记录、修改自己的密码。
- `/api/v1/manage/**` 与扫描/导入历史要求管理员。网页隐藏管理入口只是辅助，权限在后端执行。
- HTTP Cookie、认证音频和写请求的 `X-Wildstring-Client: web|android` 规则继续生效，不把令牌放入 URL。

`GET /api/v1/auth/status` 保留 `configured`、`authenticated`；已登录时增加 `user`。`POST /api/v1/auth/login` 接受 `{username,password}`，返回 `{id,username,role,enabled,version}`，不再把账号固定为 admin。用户名不区分大小写。

所有新建账号的用户名为 1–32 位 ASCII 字母、数字、点、下划线、连字符，首位为字母或数字。密码为 12–128 个字符，采用独立随机盐与 scrypt；返回信息和输入校验错误不回显密码或哈希。沿用实例级登录/当前密码校验失败限流：连续 5 次失败后暂停 60 秒，尚无按账号/IP 的独立限流。

## 密码与用户管理

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/api/v1/auth/password` | 已登录用户提交 `{current_password,new_password}`；成功 204，清 Cookie，撤销该用户所有设备会话 |
| GET | `/api/v1/manage/users` | 管理员读取 `{items:[User]}`，不返回凭据 |
| POST | `/api/v1/manage/users` | `{username,password,role:"user"|"admin"}`，默认普通用户；成功 201 |
| PUT | `/api/v1/manage/users/{id}` | `{version,role,enabled}`；更新后撤销目标用户全部会话 |
| POST | `/api/v1/manage/users/{id}/password` | `{version,new_password}`；管理员重置其他用户密码，成功 204 并撤销目标用户全部会话 |

全部写接口要求合法客户端标头。重名返回 409，版本过期返回 409，未知账号返回 404，非法输入返回 422。停用账号不能登录。不能停用或修改当前账号的角色，从而保留至少一个启用的管理员；自己的密码必须通过当前密码校验入口修改，不能走管理员重置绕过。终端 `make admin` / `make docker-admin` 仍用于恢复内置 admin，只撤销该账号会话，不清理其他用户的数据。

网页的“账号设置”向所有用户开放；管理员另有“管理 → 用户”。改密后客户端应停止播放并重新登录。角色/停用/重置操作使其他客户端的后续请求返回 401；已经传给客户端的音频字节不可撤回。

## Host 白名单

管理路径为 `GET /api/v1/manage/access` 与 `PUT /api/v1/manage/access`，格式 `{enabled,hosts:[string],version}`。默认 `enabled:false, hosts:[]`，不限制访问域名。启用时 hosts 不能为空，最多 50 项。

- 每项为精确主机名或 IP，不含协议、端口、路径、凭据或通配符。支持 IDNA、IPv4、IPv6，大小写与域名末尾的点归一化。请求端口不参与域名匹配。
- 校验实际 HTTP `Host`，不相信 `X-Forwarded-Host`。反向代理需正确设置 Host；各客户端使用的局域网 IP、域名均须列入。
- 启用后，网页静态资源、登录与已登录请求、封面、歌词和音频均受限制。不匹配或重复/非法 Host 返回 400 `host_not_allowed`，管理员没有旁路。
- `/health` 与 `/health/ready` 仅暴露原有健康信息，保留探针可用性，不能通过它们访问设置或曲库。存储无法读取时，其他请求返回 503。
- 修改后立即生效并持久化。网页明确显示当前主机名及锁定风险；不提供临时回退窗口或未认证的关闭接口。

### 误配置恢复

如果当前访问主机被排除，管理页面也无法访问，**只能直接修改数据库关闭白名单**。先在服务器对数据库做 SQLite 在线备份，再执行：

```sql
UPDATE site_access SET enabled=0, version=version+1 WHERE id=1;
```

数据库位于运行目录的 `wildstring.sqlite3`，Docker 默认 `/data/wildstring.sqlite3`。正常运行时每个请求读取生效设置，修改后无需重启。不要通过删除数据库恢复，以免丢失账号和曲库信息。

## 客户端对接

新增用户身份读取、角色显示和密码修改接口需要客户端实现。账号登录框不能固定 admin。遇到 401 应清理当前连接的私密状态并停止播放；403 表示角色不允许，不应无限重试。域名限制使用客户端配置的服务端 URL 对应的 Host；修改 Base URL 时必须重新建立该地址的认证上下文。本文不代表 Android/iOS 等原生客户端已完成新增 UI。
