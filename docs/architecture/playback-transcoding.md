# AAC 实时转码与服务端缓存

更新日期：2026-10-15。Python 后端与 React Web 已实现，接口见 [AAC 播放契约](../../contracts/playback-transcoding.md)，具体验证结果见交付说明。该流程产生播放缓存，与导入 WAV/CUE 到托管 FLAC 独立。

## 实现选择

- 单个现有容器包含 Python、Web 与 FFmpeg；后端按需启动 FFmpeg 子进程，无需独立转码容器或 sidecar。
- 客户端明确请求 AAC 和档位后，只对实际 FLAC/ALAC 转码；无参数直放。已有有损格式不做二次编码，不把低码率升到 320k。
- 输出 AAC-LC fragmented M4A，48 kHz、最多双声道；客户端可边收边播放。单声道最高目标 256k，返回实际选择。
- 已完成缓存提供真实字节 Range；冷流不冒充可定位文件。通过明确 start_ms 重新编码尾段实现时间跳转，客户端维护整曲时间线与相对媒体时间的偏移。
- 以源文件版本、目标参数和偏移建立缓存，临时内容核验后发布。并发请求复用、文件锁、超时和容量约束共用一个服务，不把管道完整读进内存。
- 默认 7 天 / 10 GiB / 2 个并发，管理员可调整和清理。断连后有界补完缓存；活动读者延迟删除，清理后的新请求不复用旧条目。
- 音乐只读，缓存独立持久化。缓存命中也检查认证、曲目状态和源文件版本。

## 验收边界

后端用 FFmpeg/ffprobe 实际生成与核验 AAC，覆盖各档位、ALAC/AAC 区分、偏移尾段、Range、并发与断连、过期、重启、清理、磁盘不足和源文件变化。网页用 Chromium 桌面/手机视口验证原音与 AAC、切档、跳转、完整时间线与同一收听会话。`make ci` 在安装 FFmpeg 时包含 AAC 浏览器用例；本机无 FFmpeg 会明确跳过，可通过容器验证后端。

原生客户端未在此变更中修改。Android/iOS 真机、Safari、长曲目和多人高并发仍需实测；本版为单 API 进程，进程间文件锁不等同分布式任务调度。不做响度归一、音效、离线下载、其他目标编码或有损重编码。

## 参考

按 Navidrome 提交 [`be201a2d7972d9580bef5533bfcb8bc49a2675d2`](https://github.com/navidrome/navidrome/tree/be201a2d7972d9580bef5533bfcb8bc49a2675d2) 核对 [播放决策](https://github.com/navidrome/navidrome/blob/be201a2d7972d9580bef5533bfcb8bc49a2675d2/core/stream/decider.go) 与 [串流、缓存和偏移](https://github.com/navidrome/navidrome/blob/be201a2d7972d9580bef5533bfcb8bc49a2675d2/core/stream/media_streamer.go)，参考源格式判定和缓存失效；本项目明确限制无损到 AAC。

编码与容器依据：[FFmpeg AAC 编码器](https://ffmpeg.org/ffmpeg-codecs.html#aac)、[fragmented MP4](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)。
