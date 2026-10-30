# 界面语言

界面语言按账号保存，网页、Android 和 iOS 共用同一个设置，换设备登录后保持一致。

## 取值

| 值 | 含义 |
| --- | --- |
| `auto`（默认） | 跟随系统或浏览器语言：`zh*` 显示中文，`en*` 显示英文，其他语言回退到英文 |
| `zh` | 中文（简体） |
| `en` | English |

## API

- `GET /api/v1/auth/status` 返回 `language`，即解析后的实际语言 `zh` 或 `en`。登录后优先使用账号设置；`auto` 或未登录时按请求的 `Accept-Language` 解析。登录后 `user.language` 是账号保存的原始取值（`auto|zh|en`）。
- `PUT /api/v1/auth/preferences`，请求体 `{"language": "auto"|"zh"|"en"}`，需要会话和客户端头，返回更新后的用户。这个接口不增加资料 `version`，不会让其他设备上打开的资料表单冲突。非法取值返回 422 `invalid_account_input`。
- schema 43 新增 `users.language`，默认 `auto`；既有账号升级后保持跟随系统。

## 约定

- 服务端错误继续只返回错误码（`detail`），客户端按当前语言翻译；需要服务端生成文字时，用 `resolve_language` 结合账号设置和 `Accept-Language` 选择语言。
- 未登录时客户端使用系统语言；登录后以账号设置为准，并在本地缓存，供下次启动登录前使用。
- 助手按用户提问的语言回答，不跟随界面语言。
- 中英文资源的 key 必须一致，由 `scripts/check_i18n_keys.py` 检查。
