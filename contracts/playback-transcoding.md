# AAC 播放与缓存接口

实现于 Python 后端与 React Web，部署仍为一个容器，FFmpeg 已在镜像内。原生客户端需按本契约接入；Android/Apple 真机兼容性未由网页测试代替。

## 播放决策

已登录用户调用 `GET /api/v1/tracks/{id}/playback`，可选 `format=aac&bitrate_kbps=128|192|256|320&start_ms=0`。查询只探测源文件和缓存状态，不启动编码。

- 不传参数为原音；格式和码率必须同时传，非零 `start_ms` 只能与 AAC 请求一起传。未知格式、档位或负偏移 422；转码偏移达到或超过歌曲时长 416。
- 实际 FLAC、ALAC → AAC；实际 MP3、AAC 及其他可识别的有损 M4A 编码保持原文件。识别依据为实际 codec，M4A 不等同 AAC。
- 输出 AAC-LC、48 kHz、最多双声道、fragmented M4A，`audio/mp4`。单声道目标码率最高 256 kbps，避免编码器每声道码率上限；以返回的实际目标值展示。
- FLAC 的压缩码率不决定是否转码。目标码率为编码器目标，静音/简单内容的实际平均码率可能较低。

返回示例：

```json
{
  "mode": "transcode",
  "reason": "lossless_to_aac",
  "source": {"codec": "flac", "container": "flac", "lossless": true, "bitrate_kbps": 1100, "sample_rate": 96000, "channels": 2, "bit_depth": 24, "duration_ms": 285000},
  "output": {"codec": "aac", "container": "m4a", "profile": "LC", "bitrate_kbps": 320, "sample_rate": 48000, "channels": 2},
  "duration_ms": 285000,
  "start_ms": 53000,
  "requested_bitrate_kbps": 320,
  "cache_state": "miss",
  "stream_url": "/api/v1/tracks/REAL_TRACK_ID/stream?format=aac&bitrate_kbps=320&start_ms=53000"
}
```

直放时 `mode:"original"`、`reason:"original_requested"|"lossy_passthrough"`，`output` 为真实源信息，`start_ms:0`，URL 不带转码参数。客户端在原音元素中按歌曲位置 seek，不因偏好为 AAC 就显示为已转码。缓存状态为 `none|miss|encoding|hit`。

## 串流与跳转

`GET|HEAD /api/v1/tracks/{id}/stream` 接受同样参数，复用同一播放决策、会话、文件版本和路径检查。缓存无匿名静态 URL，所有 API/媒体响应 `private, no-store`。

- 无参数保留既有原文件 Range 行为。
- 首次 AAC GET 边编码边返回 200，`Accept-Ranges:none`，不提供虚假 Content-Length/Content-Range。请求中的字节 Range 被忽略。
- 完整缓存命中支持真正的单段字节 Range、206/416、ETag、If-Range；HEAD 不启动编码，有完整缓存时返回真实长度/Range 信息，无完整缓存时不返回长度。
- 首次流的 fragmented MP4 不保证提供整曲 duration 或原生 seek。**客户端使用 playback.duration_ms 显示整曲时长，显示位置为 start_ms + 音频元素/媒体流的相对位置。**
- 跳到尚未缓存位置时，重新请求 `start_ms=目标歌曲位置` 的播放信息与流；新的流从该位置开始，相对时间归零。该尾段有独立缓存身份，不能当成整曲缓存。
- 网页在 AAC 模式跳转时统一按 `start_ms` 重新请求；切换档位保留歌曲位置和暂停状态。客户端自行合并连续拖动请求，避免拖动中的每个像素都创建转码任务。
- 收听统计保持同一播放会话，只累计实际播放推进；seek、缓冲和重新加载不算收听时长。歌词使用整曲绝对位置。

AAC 响应增加 `X-Wildstring-Playback:transcode`、`X-Wildstring-Codec:aac`、`X-Wildstring-Bitrate-Kbps`、`X-Wildstring-Start-Ms`、`X-Wildstring-Duration-Ms`、`X-Wildstring-Cache:encoding|hit`。显式请求但直放时增加 Playback:original 与实际 Codec。头部反映本次响应，缓存可能在查询后变化。

## 缓存与管理

管理员 `GET /api/v1/manage/transcoding`：`version,retention_days,max_size_mb,max_concurrent,cache_bytes,cache_entries,active_jobs,ffmpeg_available`。PUT 提交前四项；写请求需 `X-Wildstring-Client`，旧版本 409。

- 默认保留 7 天，按上次使用续期；容量 10240 MiB；同一 API 进程最多 2 个编码任务。
- 可设置 1–365 天、16–1048576 MiB、1–8 个并发。网页设置可保存、刷新用量、手动清理。
- `DELETE /api/v1/manage/transcoding/cache` 返回 `{freed_bytes,removed,deferred,cache}`；清理可重复调用。正在使用的产物退出复用集合，使用结束后删除，不中断正在读取的播放。
- 路径为数据库所在目录的 `cache/transcoding/`，官方容器是 `/data/cache/transcoding/`。与托管库、导入源分开；不同用户可复用相同音源的派生缓存，个人统计依然隔离。
- key 包含曲目 ID、打开文件的版本、目标码率、输出采样/声道、偏移、编码策略和清理代次。修改展示文字不重编码；文件变更后不命中旧缓存。
- `.part` 经 FFmpeg 正常退出、源文件稳定性和输出 codec/采样率/时长核验后才原子发布。启动移除无主临时文件和未登记产物，运行每分钟清理过期及超容量内容；临时文件、活动延迟删除内容均计入容量。
- 同一 key 的请求复用进程内任务，文件锁防止其他进程同时写。并发配额以单 API 进程为范围；本版按单进程自托管部署，不承诺分布式全局配额。
- 消费者断开后继续补完缓存，仍受并发、容量、超时约束；每任务最多 1 小时。服务退出会终止编码并清理未完成内容，重启不复用半成品。

转码 GET 在并发已满时最多等待 5 秒，仍无可用名额返回 429（Retry-After）；FFmpeg 缺失、存储不足或编码失败在尚未发送响应头时 503。流已开始后失败会关闭流，客户端应允许重试/切换原音。基础原音播放不依赖 FFmpeg。

实现依据与设计决策见 [架构说明](../docs/architecture/playback-transcoding.md)。验证入口：`make ci`、`make test-transcoding-web`（需要 FFmpeg）及 `make docker-test`；仅使用合成测试音乐。
