# Navidrome 实现参考

核验日期：2026-10-15。官方仓库提交：[`be201a2d7972d9580bef5533bfcb8bc49a2675d2`](https://github.com/navidrome/navidrome/tree/be201a2d7972d9580bef5533bfcb8bc49a2675d2)，提交时间为 2026-10-14。本文记录设计参考，没有将 Go 源码移入本项目。

## 当前扫描单元

- [scan 官方文档](https://www.navidrome.org/docs/usage/admin/cli/scan/)：区分增量扫描与忽略修改时间的全量扫描。野弦先采用手动命令、独立进程和 `--full` 刷新；暂不引入定时或目录监听。
- [inspect 官方文档](https://navidrome.org/docs/usage/admin/cli/inspect/)：将原始标签和映射结果作为可诊断的信息。野弦保留标签原文和标题来源，搜索使用独立归一化文本，文件名只在标题缺失时兜底。
- [扫描控制](https://github.com/navidrome/navidrome/blob/be201a2d7972d9580bef5533bfcb8bc49a2675d2/scanner/controller.go)：参考扫描运行与状态控制的边界；野弦使用跨进程锁和 SQLite 运行记录，不宣称具有同等调度能力。
- [缺失与移动处理](https://github.com/navidrome/navidrome/blob/be201a2d7972d9580bef5533bfcb8bc49a2675d2/scanner/phase_2_missing_tracks.go)：Navidrome 使用 PID 对缺失和新位置进行匹配。野弦当前只保留缺失记录，不删除元数据；目录遍历不完整时不批量标缺失。外部移动识别暂未实现。

## 下一步播放

[`core/stream/media_streamer.go`](https://github.com/navidrome/navidrome/blob/be201a2d7972d9580bef5533bfcb8bc49a2675d2/core/stream/media_streamer.go) 明确区分 raw 与转码流：可 seek 的流使用 `http.ServeContent`，不可 seek 的流不承诺字节 Range；转码缓存键包含文件更新信息及输出参数，并设有转码并发控制。

野弦下一步先实现真实曲目 ID 对应的原文件串流、Range、响应头与断连行为。转码缓存、时间偏移与资源限制单独设计，不把 FFmpeg 的实时输出伪装成完整静态文件。

## 与 Python 实现的关系

标签解析采用 [Mutagen](https://mutagen.readthedocs.io/en/latest/index.html)，当前锁定版本见 `backend/uv.lock`。MP3、FLAC 与 M4A 分别处理 ID3、Vorbis Comment 和 MP4 atoms，不盲目切分艺人字符串。

本项目沿用原仓库的 GPLv3 许可证。后续实际引入第三方代码时，另外记录来源与适用许可；设计参考不等于已实现其全部行为。
