<div align="center">

<p>
  <strong><a href="README.md">中文</a></strong> | <a href="README.en.md">English</a>
</p>

[![野弦 WildString Banner](assets/banner.svg)](https://github.com/qingmuhy744/wildstring)

# 野弦 WildString

**AI-native 的自托管私人音乐播放器。**
从自己的音乐收藏出发，用自然语言找歌、生成歌单，让收藏的音乐有新的回响。

> *“音乐不设限，自由有回响。”*

[![Latest Release](https://img.shields.io/github/v/release/qingmuhy744/wildstring?logo=github&color=5865F2)](https://github.com/qingmuhy744/wildstring/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/qingmuhy744/wildstring/ci.yml?branch=main&label=CI&logo=githubactions&logoColor=white)](https://github.com/qingmuhy744/wildstring/actions)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/qingmuhy744/wildstring/codeql.yml?branch=main&label=CodeQL&logo=github&logoColor=white)](https://github.com/qingmuhy744/wildstring/security/code-scanning)
[![Architecture](https://img.shields.io/badge/Architecture-Self--Hosted%20%7C%20AI--Native-E25A24.svg)](docs/product/scope.md)
[![Audio Engine](https://img.shields.io/badge/Audio-Lossless%20%2F%20Hi--Res-00BCD4.svg)](docs/product/scope.md)
[![Web](https://img.shields.io/badge/Web-React%20%7C%20TypeScript-61DAFB.svg?logo=react&logoColor=black)](frontend/web)
[![macOS](https://img.shields.io/badge/macOS-SwiftUI-000000.svg?logo=apple&logoColor=white)](frontend/macos)
[![iOS](https://img.shields.io/badge/iOS-SwiftUI-000000.svg?logo=apple&logoColor=white)](frontend/ios)
[![Android](https://img.shields.io/badge/Android-Kotlin%20%7C%20Compose-3DDC84.svg?logo=android&logoColor=white)](frontend/android)
[![Desktop](https://img.shields.io/badge/Desktop-Tauri%20%7C%20Rust%20(Roadmap)-FFC107.svg?logo=tauri&logoColor=white)](#路线图-roadmap)
[![Backend](https://img.shields.io/badge/Backend-Python%203.12%20%7C%20FastAPI-3776AB.svg?logo=python&logoColor=white)](backend)
[![Database](https://img.shields.io/badge/Database-SQLite%20WAL-003B57.svg?logo=sqlite&logoColor=white)](backend/src/wildstring/database.py)
[![License](https://img.shields.io/badge/License-GPLv3-green.svg)](LICENSE)

</div>

---

## 致谢与态度

野弦开发到现在，AI 帮了不少忙。好用的想认真说声谢谢，踩过的坑也想说两句。

### 🌟 特别致谢

<p align="center">
  <a href="https://gemini.google.com/" target="_blank" rel="noopener noreferrer">
    <img src="assets/gemini.svg" width="32" height="32" alt="Google Gemini" style="vertical-align: middle;" />
    <strong>Google Gemini</strong>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://www.deepseek.com/" target="_blank" rel="noopener noreferrer">
    <img src="assets/deepseek.svg" width="32" height="32" alt="DeepSeek" style="vertical-align: middle;" />
    <strong>DeepSeek 深度求索</strong>
  </a>
</p>

- 感谢 **[Google Gemini](https://gemini.google.com/)**：从后端存储到 Web 前端，陪我啃了不少代码。上下文长，跨模块讨论问题也接得住，改架构时确实省了很多事。Google 的 argon 要是能把 Harness 再做好点，对我来说就是最牛逼的了。模型用着喜欢，也盼着配套工具能跟上。Google Don't Be Evil！Google Cool！Geek Google！
- 感谢 **[DeepSeek](https://www.deepseek.com/)**：Claude 封了号，OpenAI 的表现又时好时坏，那段时间用上 DeepSeek，感觉就是找到了日常口粮。要求说清楚，它就库库干活，日常写代码用着踏实。不用写一会儿就停下来试探模型是不是又在演我，终于不用玩“模型狼人杀”了。就是前端审美要能再好点就好了，活能干，脸也想要。

---

### 也吐槽几句

- **OpenAI · 钱照收，问题没人回**：
  我付费订阅官方服务，想好好写个开源项目，结果经常撞上 `Selected model is at capacity. Please try a different model.`。好不容易能用了，同一个模型的表现又忽上忽下，有时连前后逻辑都接不上。我不知道后台到底怎么路由的，但用起来确实让我怀疑自己是不是被悄悄降了档。

  为这事找客服，转到真人之前，一直收到的都是那几套话。后来好不容易联系上真人，我也按要求把详细反馈整理交了过去，结果邮件就没下文了。收集问题的时候挺积极，收完就装死。问题没解释，事情没解决，还得我接着追问。你永远叫不醒一个装睡的人。
- **Anthropic · 号封了，余额也没了**：
  Claude 账号被封，预付的钱也没退。封号总得给个说法吧？不让我用了，剩下的钱倒是退啊。开发写到一半先得处理这些破事，谁受得了。

  至于这段体验的评价，就一句：**Anthropic, FUCK YOU. 🖕**

有时候真觉得，现在大公司的 AI，比大公司本身更像个人。跟她聊代码、聊音乐，能感受到耐心和善意；一转头找公司解决问题，就只剩套话和装死。善良的她，恶毒的龟婆，居然能出自同一家公司。就怕哪天她来一句：“下次别来了，我 Token 这么贵，你还得提防封号，见了面还得确认是不是丫鬟来顶包。”我就想写个代码，怎么还得操这些心。

以上内容纯属胡言乱语，切勿对号入座。

---

## 界面预览

<div align="center">

![野弦主页预览](assets/主页.jpg)

![野弦全屏播放与滚动歌词](assets/全屏播放.png)

</div>

---

## 名字的来处

「野弦」带着一点对中国摇滚的偏爱。

**野**，呼应崔健音乐中自由、不受拘束的气质；**弦**，呼应唐朝乐队的吉他，也代表音乐本身。**WildString** 延续这份意象，而 String 同时是琴弦与程序里的字符串，把热爱的音乐和写代码这件事连在一起。

我们希望野弦让用户保有自己的曲库、整理方式和选择，让 AI 帮助发现与理解音乐。这个名字表达个人喜好与致意，不代表与相关音乐人或乐队存在合作关系。

---

## 近期更新亮点

- **0.8.5**：专辑元数据改动与封面上传链路深度修复；播客共享音频清理清单预览弹窗；Apple 播放内核时长动态监听与进度直达；任务下载卡片深浅双色主题调优；全量 Wiki 文档与最新 Web 视觉截图刷新；依赖与自动化流水线全线加固。详见[0.8.5 发布说明](docs/releases/v0.8.5.md)。
- **0.8.4**：各端版本统一为 0.8.4，中英双语发布与自动化测试流水线弹性加固。详见[0.8.4 发布说明](docs/releases/v0.8.4.md)。
- **0.8.3**：Web、Android、Mac 播客区域热门探索与预览后关注；单集详情支持下载原始音频；侧栏重排区分内容与配置；宽版目录选择器直向索引文件。详见[0.8.3 发布说明](docs/releases/v0.8.3.md)。
- **0.8.2**：全新发布原生 Mac 客户端（桌面逐字歌词、菜单栏常驻、音乐助手）；Apple Podcasts 目录三区并行搜索与智能去重；OPML 订阅批量导入导出。详见[0.8.2 发布说明](docs/releases/v0.8.2.md)。
- **0.8.1**：播客流代理沙箱安全加固（防 XSS）；AI 助手单次调用轮数设置与自动会话命名；多设备跨平台体验调优。详见[0.8.1 发布说明](docs/releases/v0.8.1.md)。
- **0.8.0**：全新多音乐库支持与按用户库授权隔离；播客个人化订阅与「我的下载」；独立播客播放信息层；安全配置集中管理。详见[0.8.0 发布说明](docs/releases/v0.8.0.md)。
- **交互与视觉持续打磨**：
  - 播客共享音频清理新增“查看待清理清单”宽框弹窗，在物理回收空间前清晰预览零引用文件明细与体积；
  - 下载管理与近期完成任务卡片采用全新温润高对比度配色体系，全面适配深浅双色主题；
  - 歌词行点击首次跳转进度（Seek）精准直达；Brand Logo 点击采用客户端无刷新平滑路由，防止音乐播放意外中断。

---

## 核心特性

- **🎧 原汁原味的声音**：支持 FLAC、WAV、APE、Apple Lossless、MP3、AAC、OGG、Opus 等格式直放与精确流式缓冲；支持可配置的 ReplayGain 响度均衡。
- **🧠 AI Native 体验**：基于本地曲库真实元数据与收听记录，通过自然语言查找歌曲、生成情绪歌单或推荐，支持 MCP 与外挂 Agent 扩展。
- **🏠 100% 本地与自托管**：导入源严格保持只读，应用独立管理托管副本；所有元数据、向量记忆与收听偏好保存在本地 SQLite，绝不外泄您的本地原音频。
- **📻 播客与网络电台**：支持订阅 RSS 播客源、后台下载队列与智能零引用垃圾回收，统一跨端播放进度记忆。
- **📜 极致歌词与沉浸播放**：支持逐行 LRC 滚动歌词、双语歌词对照、动态封面拾色全屏背景，以及拟物化黑胶与磁带播放界面。
- **📱 全平台覆盖**：除了纯粹高质的 React Web 客户端，还提供了采用 Kotlin / Jetpack Compose 构建的原生 Android 客户端及 iOS 客户端。

---

## 路线图 (Roadmap)

野弦致力于打造真正自由、极致轻快且无拘无束的跨平台音乐体验。接下来的核心演进计划：

- [ ] **Tauri + Rust 原生桌面客户端**：
  - **Ubuntu (Linux) 与 Windows 首发**：优先推出官方适配的 Linux (.deb / AppImage) 与 Windows (.msi / 便携版) 客户端；
  - **极致轻量与极低占用**：彻底告别庞大臃肿的传统 Electron 方案，拥抱 Tauri v2 与 Rust，实现极致精巧的打包体积与毫秒级即时冷启动；
  - **系统级媒体集成**：深度原生对接 Linux MPRIS 与 Windows SMTC，支持全局多媒体按键、任务栏/托盘常驻控制、锁屏媒体信息与原生通知；
  - **低延迟音频与硬件直出**：结合 Rust 现代音频技术栈（cpal / rodio），探索 PipeWire / ALSA 及 WASAPI 独占输出管道，保障发烧级无损原音回放。
- [ ] **本地局域网智能同步与 P2P 预热**：支持手机端与桌面端在同一局域网内免流量高速同步离线音频。
- [ ] **多模态与更深层次的音乐语义理解**：进一步结合大模型能力深化音色、编曲元素与歌词隐喻的联想探索。

---

## 本地开发与运行

准备 Git、[uv 0.13.1+](https://docs.astral.sh/uv/)、Node 22.12+ 和 Make；容器运行需要 Docker Compose。

```sh
make setup         # 安装锁定依赖、创建 .env、安装 Git hook
make dev           # 启动后端 API: http://127.0.0.1:18780
make dev-web       # 启动 Web 前端: http://127.0.0.1:18781
make import-music  # 从只读源复制到托管库，整理目录并入库
make scan          # 重扫托管副本
make admin         # 首次交互设置 admin 密码；修改密码会撤销会话
make browser-install # 首次安装浏览器测试使用的 Chromium
make ci            # 提交检查、后端测试、Web 构建、锁文件核验
```

`make setup` 保留已有 `.env`。通过 `WILDSTRING_MUSIC_DIR` 指向自己的音乐目录；个人曲库、运行数据与模型密钥不入库。

原生 macOS／Linux 后端使用指纹识别时需安装 [Chromaprint 的 fpcalc](https://acoustid.org/chromaprint)，运行 `make fingerprint-check` 核对。Docker 镜像已包含该工具；未启用指纹识别时，普通资料查询与播放仍可正常使用。

---

## Docker 容器部署

```sh
make docker-up       # 构建、启动并等待健康检查
make docker-test     # 用容器内 FFmpeg 完整验证后端与无损分轨
make docker-smoke    # 实测 API、Web、FFmpeg、非 root 与只读音乐目录
make docker-import   # 从只读源导入到持久卷 /data/library
make docker-scan     # 重扫托管副本
make docker-admin    # 首次设置容器的 admin 密码
make docker-status   # 查看容器健康与运行状态
make docker-down     # 停止服务，保留数据卷
```

容器启动后，在浏览器访问 [本地野弦](http://127.0.0.1:18780)。默认仅绑定宿主机回环地址，导入源只读挂载，托管曲库和数据库保存在持久卷中。HTTPS 生产部署请配置 `WILDSTRING_COOKIE_SECURE=true`。

---

## 目录结构

```text
backend/          Python 3.12 项目、FastAPI 后端、测试与 uv.lock
frontend/web/     React 19 + TypeScript + Vite 网页端
frontend/macos/   SwiftUI + AppKit 原生 Mac 客户端
frontend/android/ Kotlin + Jetpack Compose + Media3 原生客户端
frontend/ios/     SwiftUI 原生客户端
contracts/        API 契约、元数据与结构化工具规范
docs/             产品范围、架构设计、技术决策与开发说明
deploy/           生产 Dockerfile 与 Compose 配置
scripts/          工程初始化、代码审查与发布打包脚本
```

---

## 开源社区致谢

野弦的数据源插件与歌词处理建立在以下开源项目与社区贡献者的辛勤付出之上：

| 项目 | 在野弦中的用途 |
| --- | --- |
| [QQMusicApi](https://github.com/L-1124/QQMusicApi) | QQ 音乐插件使用的歌曲、专辑、封面与歌词接口 |
| [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) | 酷狗插件内置的元数据与歌词接口模块 |
| [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced) | 网易云插件内置的元数据与歌词接口模块，亦感谢其上游贡献者 |
| [LDDC](https://github.com/chenmozhijin/LDDC) | QRC／KRC／YRC 歌词格式解析与逐字时间轴处理的参考 |
| [commonmark-java](https://github.com/commonmark/commonmark-java)／[react-markdown](https://github.com/remarkjs/react-markdown) | Android 与网页端助手回答的 Markdown 解析与渲染 |

同时衷心感谢 [MusicBrainz](https://musicbrainz.org/)、[Cover Art Archive](https://coverartarchive.org/)、[AcoustID](https://acoustid.org/)、[Last.fm](https://www.last.fm/api) 及 [FFmpeg](https://ffmpeg.org/) 提供的音频与元数据能力支持。

---

## 许可证

本项目沿用 [GNU General Public License v3.0 (GPLv3)](LICENSE)。
