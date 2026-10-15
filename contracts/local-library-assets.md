# 专辑、封面与本地歌词

所有接口需管理员会话。读取的是托管副本，不访问客户端路径，不写入音频或向第三方下载信息。

## 专辑

- `GET /api/v1/albums?q=&limit=50&offset=0`：分页返回专辑，limit 1–100；q 字面匹配该专辑任一歌曲的标题、艺人、专辑或专辑艺人，返回完整专辑的统计信息。
- `GET /api/v1/albums/{id}`：专辑标题、艺人、曲数、总时长与 `cover_track_id`；不存在返回 404。
- `GET /api/v1/albums/{id}/tracks?limit=50&offset=0`：按碟号、曲号、标题和 ID 排序，limit 1–200。
- 曲目响应增加 `album_id`。专辑按曲库、归一化专辑名与专辑艺人分组；无专辑艺人或无专辑名时按所在目录分组。没有标签时显示“未命名专辑”，不猜发行信息。
- 专辑 ID 可重复计算，正常重扫不变；修改分组标签或目录可能改变专辑 ID。相同专辑名、相同专辑艺人的不同发行版本尚未自动区分；无专辑艺人时分布在不同目录的多碟专辑尚不自动合并。
- 网页提供歌曲列表与专辑网格，专辑详情显示最多 200 首一页；超过一页时明确显示“播放本页”，不会将半张专辑称为完整专辑。切换视图不替换播放队列。

## 封面

`GET /api/v1/tracks/{id}/cover?size=320` 返回 JPEG 缩略图。size 64–768，归为 96、320、768 三档。没有有效来源返回 404，网页保留占位。

优先级：

1. FLAC PICTURE / MP3 APIC 的正面封面（type 3），再尝试其他内嵌图片；M4A 使用 covr。
2. 同目录、音频同名的 `.jpg` / `.jpeg` / `.png` / `.webp`。
3. 同目录 `cover` → `folder` → `front`，每个名称按 JPG、JPEG、PNG、WebP 顺序尝试。文件名匹配不区分大小写，不向上级目录搜索。

只接受 Pillow 可解码的 JPEG、PNG、WebP。单张原图上限 8 MiB、2000 万像素；损坏或过大的图片跳过。纠正 EXIF 朝向并缩小，缩略图按原图内容哈希去重，缓存于运行目录 `covers/`，不改音频或源图。文件接口使用 `private, no-store` 并先认证；外置图片改动后刷新曲库即可重新加载。

格式读取参考 [Mutagen FLAC](https://mutagen.readthedocs.io/en/latest/api/flac.html)、[ID3](https://mutagen.readthedocs.io/en/latest/api/id3_frames.html) 和 [Pillow](https://pillow.readthedocs.io/en/stable/reference/Image.html)。

## 歌词

`GET /api/v1/tracks/{id}/lyrics` 返回 `{kind, source, lines}`。kind 为 synced、plain 或 none；每行含 `time_ms`（纯文本为 null）和 `text`；无歌词返回 200 + none，不阻断播放。

以 `03 - 歌名.flac` 为例，优先读取同目录 `03 - 歌名.lrc`，兼容 `.lryc` 别名；匹配不区分大小写，不模糊匹配其他歌曲。其后尝试：

- FLAC：SYNCEDLYRICS / LYRICS / UNSYNCEDLYRICS / UNSYNCED LYRICS。
- MP3：毫秒时间轴的 SYLT（format 2）；其后 USLT。MPEG 帧计数的 SYLT 不猜换算时间。
- M4A：©lyr。
- 最后读取音频同名 `.txt`。

内嵌多份歌词优先选择有时间轴的内容。同名 LRC 是显式覆盖，即使只有纯文本也优先保留。文本上限 512 KiB、5000 行，支持 UTF-8/BOM、带 BOM 的 UTF-16 和 GB18030；无法解码或超限则跳过。

支持 `[mm:ss]`、百分秒/毫秒、多时间标签、乱序排序、相同时间的译文合并，以及 `[offset:±毫秒]`；本项目规定正 offset 提前显示。增强 LRC 的逐字时间标签可移除后按行显示，暂不逐字高亮。标签元信息不当歌词显示，纯文本不生成虚构时间轴。

网页播放详情包含封面、曲目信息与滚动歌词。高亮根据实际播放位置计算；拖动或点击歌词会更新位置，手动滚动暂停跟随，点击“跟随播放”恢复。切歌撤销旧请求，纯文本/缺失/错误状态均不阻断播放。
