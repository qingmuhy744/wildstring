# 合成音频测试样本

`silence.mp3`、`silence.flac`、`silence.m4a` 为 FFmpeg 生成的约 0.2 秒双声道静音，采样率 44100 Hz，不包含真实歌曲录音。标签为虚构的中文测试数据。

用于验证真实 MP3/FLAC/MP4 容器解析、中文标签、轨道编号与时长。自动测试会复制到临时目录后再修改标签，不改动这些源样本，也不读取用户 `data/`。

生成方式为 `anullsrc=r=44100:cl=stereo`，分别使用 libmp3lame、flac、aac 编码。样本为本项目测试生成，可随仓库使用与分发。

## 播放样本

`playback.mp3` 是本项目用 FFmpeg `anullsrc` 生成的 12 秒单声道静音，使用 libmp3lame 编码，含自编测试标签。仅用于浏览器播放、进度与队列验证，不含商业音乐。
