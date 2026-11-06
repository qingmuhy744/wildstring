# 日志等级与诊断调用栈

诊断存储与业务数据库独立，位于运行数据目录的 `diagnostics/`。现有事件查询、trace 关联、七天保留及有界队列继续使用。

## 设置与权限

- `GET /api/v1/manage/diagnostics/status` 的 `logging` 返回 `level`、`capture_stack`、`debug_until`、`debug_module` 及存储状态。
- `PUT /api/v1/manage/diagnostics/settings` 接受 `{level:"INFO"|"WARNING"|"ERROR",capture_stack:boolean}`，返回完整 logging 状态。默认为 INFO、开启调用栈。请求为完整替换，省略字段使用默认值；未知字段、非法等级和非布尔值返回 422。
- 读取与写入均要求所有者会话；写入另要求客户端请求头。非所有者返回 403，未登录返回 401。持久化失败返回 503 `diagnostic_settings_unavailable`，保留当前生效设置。
- 设置写入诊断 SQLite，保存成功立即作用于新事件和控制台日志，重启后恢复。关闭调用栈不会删除历史记录。
- DEBUG 不能作为常驻等级。现有 `POST /api/v1/manage/diagnostics/debug {minutes:0..15,module:"outbound"|"agent"|"all"}` 临时开启所选模块的 DEBUG，覆盖常规最低等级；到期、主动关闭或重启后结束。其他等级仍遵循常规阈值。

## 等级与错误定位

INFO 用于正常运行，WARNING 用于警告和请求 4xx，ERROR 用于请求 5xx 和未处理异常；CRITICAL 保持原等级，始终高于 ERROR。成功的健康检查和串流请求摘要继续使用 DEBUG。

异常事件保留 `exception_type`。开启调用栈时，新增 `stack:{exceptions:[{type,relation,frames:[{module,function,line}],frames_truncated}],chain_truncated}`。首个异常的 relation 为 `raised`，后续沿 Python 显式 cause 或未抑制 context 记录为 `cause`／`context`；遵守 `raise ... from None`。最多五个异常，每个保留最后 32 帧，截断明确标记。

只采集代码定位信息，不格式化异常原文、源代码行、局部变量或绝对路径。普通日志正文仍不写入诊断；logger 异常、请求未处理异常、资料来源 worker／任务及助手模型／任务失败可记录调用栈。历史事件没有 stack 时，客户端继续正常展示摘要；不能恢复此前未采集的栈。

Web 管理中心的「诊断」区分采集设置与查询筛选，提供调用栈开关、最低等级选择及错误栈展开。事件查询、JSONL 和诊断包共享相同的结构化数据。

## 验证边界

本地验证使用隔离测试目录和合成异常，不读取个人曲库，不调用真实模型或外部资料来源。实现、自动化测试、浏览器视觉验收和正式部署分别记录。
