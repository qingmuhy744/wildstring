# 音乐标签与野弦字段映射

日期：2026-10-16。状态：**字段统一方向已由用户提出；以下是核对后的映射建议，尚未实现或完成文件往返验证。**

目标是让 Mp3tag、MusicBrainz Picard 整理的文件能被野弦正确读取，未来写回托管副本后仍能被这些工具识别。本文细化[自动整理方案](../product/metadata-automation.md)，不发布新 API，也不改变导入源只读、数据库修正先行、显式写回副本的边界。

## 1. 统一语义，按格式读写

| 层次 | 保存什么 | 本项目的处理方式 |
| --- | --- | --- |
| 文件标签 | FLAC 的 Vorbis Comments、MP3 的 ID3 帧、M4A 的 MP4 atoms；另有图片与歌词结构 | 使用格式适配器，保留原字段和未知标签 |
| 编辑软件字段 | Mp3tag、Picard 显示给用户的逻辑名称 | 参照其公开映射；编辑器名称不直接当作文件内的字段名 |
| 规范化元数据 | 标题、署名、独立艺人、贡献关系、日期、编号和外部身份 | 数据库使用有明确语义和类型的字段；名称无需全部大写 |
| 整理与个人状态 | 原始值、覆盖、锁定、来源、历史、收藏、收听、Last.fm 授权 | 留在应用存储；个人收听状态不自动写入共享音频 |

FLAC 的文本标签为 UTF-8 的 `KEY=value`，键名不区分大小写；音乐字段大多是通行约定。[RFC 9639 第 8.6 节](https://www.rfc-editor.org/rfc/rfc9639.html#section-8.6)建议音乐内容参考 MusicBrainz 的字段列表。重复字段和扩展名的细节参考 [Vorbis Comments](https://xiph.org/vorbis/doc/v-comment.html)。原生 FLAC 图片存于 PICTURE 块，不应把它当作普通文本 `COVER` 字段。

MP3 的 ID3 使用有类型的帧。[ID3v2.4](https://id3.org/id3v2.4.0-frames)允许文本帧内使用空字符分隔多个字符串。用户看到的分隔符与文件物理编码分别处理，不将 `/`、逗号或分号作为全局拆分规则。

## 2. 首批常用字段

本表综合 [Mp3tag 映射](https://docs.mp3tag.de/mapping/)和 [Picard 映射](https://picard-docs.musicbrainz.org/en/latest/appendices/tag_mapping.html)。MP3 列以 ID3v2.4 为主，2.3 差异另述；M4A 指使用 iTunes 风格标签的 MP4 容器，不能直接套到裸 AAC 文件。

| 逻辑信息 | FLAC / Vorbis 常用名称 | MP3 / ID3v2.4 | M4A / MP4 |
| --- | --- | --- | --- |
| 歌曲标题 | `TITLE` | `TIT2` | `©nam` |
| 歌曲艺人显示署名 | `ARTIST` | `TPE1` | `©ART` |
| 独立歌曲艺人名单 | 多值 `ARTISTS` | 多值 `TXXX:Artists` | `----:com.apple.iTunes:ARTISTS` |
| 专辑名称 | `ALBUM` | `TALB` | `©alb` |
| 专辑艺人显示署名 | `ALBUMARTIST` | `TPE2`（通行用途） | `aART` |
| 作曲者 | 多值 `COMPOSER` | `TCOM` | `©wrt` |
| 作词者 | 多值 `LYRICIST` | `TEXT` | `----:com.apple.iTunes:LYRICIST`（Picard 约定） |
| 编曲者 | 多值 `ARRANGER` | `TIPL` 内 `arranger` 角色 | Picard 未列对应映射，不默认编造写回字段 |
| 曲号 / 总曲数 | `TRACKNUMBER` / `TRACKTOTAL`、`TOTALTRACKS` | `TRCK`，如 `2/9` | `trkn` 中的编号和总数 |
| 碟号 / 总碟数 | `DISCNUMBER` / `DISCTOTAL`、`TOTALDISCS` | `TPOS`，如 `1/2` | `disk` 中的编号和总数 |
| 流派 | 多值 `GENRE` | `TCON` | `©gen`，兼容读取 `gnre` |
| 合辑标记 | `COMPILATION` | `TCMP`（通行扩展） | `cpil` |
| 非同步歌词 | `LYRICS` | `USLT` | `©lyr` |
| 内嵌图片 | PICTURE 元数据块 | `APIC` | `covr` |

`TPE2` 在 ID3 原始定义中是乐队/管弦乐队等信息，作为专辑艺人属于广泛采用的约定；`TCMP` 也不能误称为 ID3 核心规范字段。上述表格是互操作映射，不保证任意播放器都支持每个扩展。

`TIPL:arranger` 表示 TIPL 的角色条目，不是 ID3 中另有名为该字符串的独立帧；写回时必须保留同帧其他角色。ID3v2.3 对应 `IPLS` 的角色条目。乐器演奏信息可由 `TMCL` 表达，不能混成歌曲艺人。M4A 其他扩展需要指定兼容配置并验证，不承诺跨所有编辑器统一显示。

## 3. 多人署名与人物身份

建议与 [Navidrome 多艺人设计](https://www.navidrome.org/docs/usage/library/tagging/#handling-multiple-artists-and-collaborations)对齐：`ARTIST` / `ALBUMARTIST` 保存显示署名，`ARTISTS` / `ALBUMARTISTS` 保存独立名单。`ALBUMARTISTS` 的各格式扩展映射需显式登记并验证；不能因支持 FLAC 同名扩展就宣称 MP3/M4A 已兼容。

示例为虚构署名，不是本次真实歌曲的整理结果：

```text
ARTIST=甲 feat. 乙
ARTISTS=甲
ARTISTS=乙
ALBUMARTIST=甲
ALBUMARTISTS=甲
LYRICIST=丙
COMPOSER=丁
ARRANGER=戊
```

界面保留“甲 feat. 乙”，艺人筛选分别关联甲和乙；专辑仍归甲。数据库使用贡献者身份、角色、顺序和原署名表达这些关系。只有显示字段时保留原串，解析得到的名单有歧义则作为候选；不能把 `AC/DC` 自动拆开。

优先读取明确的复数字段；缺失时接受原生多值 `ARTIST` / `ALBUMARTIST`，保留顺序。其他角色仍用多值单数字段，如重复 `COMPOSER`，不自造一套 `COMPOSERS` / `LYRICISTS` 写回字段。`ARTIST` 可能代表器乐演奏者或古典作曲者，不能单凭它自动认定“演唱”。

## 4. 日期、编号与外部 ID

### 日期

数据库区分当前发行日期、原始发行日期、明确录制日期，并保存原文与精度。`2014` 不补造为 `2014-01-01`。Picard 将发行日期映射到 `DATE` / `TDRC` / `©day`，原始发行日期映射到 `ORIGINALDATE` / `TDOR`；Mp3tag 的 MP3 显示名称常为 `YEAR`。ID3 规范中 `TDRC` 的原始含义是录制时间，并另有 `TDRL` 发行时间；不同软件存在语义差异。

建议首期采用 Picard 兼容配置解释普通日期，明确的 `RELEASEDATE` / `TDRL` 和录制日期另外保存。遇到冲突生成候选，不盲目取最新年份或把所有日期并成一个 `year`。向 Navidrome 迁移时需实测其日期解释，不能承诺不同软件的日期展示完全一致。

### 编号

内部使用 `track_number`、`track_total`、`disc_number`、`disc_total` 四个可空整数，兼容读取 `2/9` 及独立总数字段；别名冲突要保留并提示。写回采用选定格式的映射，不能把 `2/9` 解析成曲号后丢弃总数，也不把缺失值写成 `0` 或“未编号”。

### MusicBrainz 身份

| 数据库语义建议 | FLAC 常用字段 | 必须区分的对象 |
| --- | --- | --- |
| `musicbrainz_recording_id` | `MUSICBRAINZ_TRACKID` | 录音身份，同一录音可出现在多个发行版 |
| `musicbrainz_release_track_id` | `MUSICBRAINZ_RELEASETRACKID` | 某个具体发行版中的曲目条目 |
| `musicbrainz_release_id` | `MUSICBRAINZ_ALBUMID` | 具体发行版 |
| `musicbrainz_release_group_id` | `MUSICBRAINZ_RELEASEGROUPID` | 归集多个发行版的专辑组 |
| 主艺人 / 专辑艺人外部身份 | `MUSICBRAINZ_ARTISTID` / `MUSICBRAINZ_ALBUMARTISTID` | 与相应署名中的人物关联 |
| 作品身份 | `MUSICBRAINZ_WORKID` | 创作作品，与某次录音分开 |

这里最容易混淆的是历史字段名：文件中的 `MUSICBRAINZ_TRACKID` 通常保存 **Recording ID**，不能当作 Release Track ID。MP3 的录音 ID 使用 `UFID` 且 owner 为 `http://musicbrainz.org`，发行曲目 ID 则用 `TXXX:MusicBrainz Release Track Id`。参照 Picard 映射逐项处理，不直接靠名称猜对象。

所有外部 ID 都不能代替野弦曲目 ID。同名、同录音和重复文件分别处理；姓名与外部 ID 数量不匹配时不强行按位置绑定，也不把全部词曲编人员塞进主艺人的 ID 标签。

## 5. 歌词、图片与非标签信息

纯文本、LRC 时间轴和 ID3 `SYLT` 同步结构分别保存。把一整段 LRC 文本塞进 `USLT` 不会自动变成规范的 `SYLT`。首期动态歌词继续使用数据库与同名 `.lrc` 的现有流程，后续显式写回需单独选择文本标签或 LRC 侧车，并验证播放器兼容性。

图片保存原图、类型和来源；FLAC PICTURE 与 MP3 APIC 的正面/背面标记应保留。专辑继承是应用显示规则，选择“跟随专辑”不立即给每首歌重嵌图片。

采样率、声道、时长和实际编码信息由音频流读取；标签中自报的时长不覆盖探测结果。Last.fm 的全站热度和标签保留来源，不能覆盖本地用户的收听次数或把全部社区标签自动写为流派。个人收藏、播放进度、每位用户的授权与收听记录只存应用数据。

## 6. 读取、写回与验证建议

1. 建立一份字段注册表：内部类型、格式映射、读入别名、多值规则、适用对象和可写能力；扫描、预览、显式写回复用同一注册表。
2. 保留原始标签观测值及格式版本；未知标签、未知图片、其他语言歌词和未修改的角色条目不因一次编辑被删除。原始快照不保证所有格式自动可无损重写，写回必须逐格式验证。
3. MP3 读取 ID3v2.3 / 2.4；新增标准化写回建议选择 2.4，多值和日期能力更完整。保留 2.3 的选项需展示损失与兼容边界；日常扫描不自动升级标签版本。
4. 用 Mp3tag、Picard 生成的合成文件验证“读取 → 改一个字段 → 写回副本 → 外部编辑器重读”；比较多值、未知字段、歌词、图片和音频内容是否保留。
5. 本地字段模型和映射验证先完成，再把 MusicBrainz、Last.fm 建议转换到同一模型。联网结果确认后才能生效，不另外维护一套不兼容的标签名称。

当前代码的[标签读取](../../backend/src/wildstring/library/metadata.py)只覆盖标题、歌曲艺人、专辑、专辑艺人及曲/碟序等基础信息；独立 `ARTISTS` / `ALBUMARTISTS`、词曲编、总曲碟数、日期和外部 ID 尚未完整接入。本文没有修改这些实现，没有执行标签写回，也没有改动真实音乐。
