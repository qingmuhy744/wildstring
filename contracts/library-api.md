# 曲库 API v1

当前接口为只读，所有接口均需管理员会话；未登录返回 401。部署默认仅绑定宿主机回环地址。认证与串流接口见 [播放与登录](playback-auth-api.md)。网页扫描提交和文件写回尚未实现。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v1/tracks?q=&limit=50&offset=0` | 分页查询当前曲库中 available 的文件；limit 为 1–200，offset 不小于 0 |
| GET | `/api/v1/tracks/{id}` | 按内部曲目 ID 查询，含 available、missing、unreadable 状态；不存在返回 404 |
| GET | `/api/v1/scans?limit=20` | 最近扫描记录，limit 为 1–100 |
| GET | `/api/v1/scans/{id}` | 指定扫描结果，不存在返回 404 |

分页结果包含 `items`、`total`、`limit`、`offset`。当前 q 对标题、艺人、专辑与专辑艺人的归一化文本做字面子串匹配，支持中文、Unicode NFKC 与大小写折叠；`%`、`_` 不作为通配符。当前没有拼音、简繁互转、模糊排序或语义检索。

曲目返回原始展示标签、标题来源、相对路径、时长、格式、采样率、声道、封面存在标记与文件大小，不返回宿主机根目录、锁文件或内部搜索文本。封面尚不提供图片读取接口。

扫描记录含 ID、状态、开始/结束时间、计数与最多 100 个错误明细；`counts.errors` 保留完整错误数量。错误码为 `metadata_invalid`、`file_unreadable`、`file_changed`、`directory_unreadable` 或 `root_unavailable`。

扫描状态为 `running`、`completed`、`completed_with_errors`、`failed` 或 `interrupted`。扫描由 `make scan` / `make docker-scan` 运行，不在 HTTP 进程的临时 BackgroundTasks 中执行。

内部 ID 在同一根目录、相对路径不变的重扫、标签更新及缺失后恢复中保留。外部重命名/移动当前按旧文件缺失、新文件导入处理；未实现 Navidrome 的 PID 移动识别。
