# 数据源 ZIP 插件（API v1）

所有者在 Web「管理中心 → 服务设置 → 数据源插件」手动导入 ZIP，配置后启用。新安装默认没有数据源插件，启动或服务升级不自动导入、启用或删除插件；已安装的包、启用状态、配置与密钥保留。Release 分别提供 QQ、酷狗、网易云三个可选包，源码暂留本仓库。导出得到原始 ZIP，配置、Cookie、查询历史不在导出包内。没有插件时基本播放、MusicBrainz 和 Last.fm 保持可用。Android 不提供插件或资料候选管理。

平台请求、认证差异、字段映射、专辑版本选择及 QRC／KRC／YRC 解码与格式处理位于插件内，由插件维护者更新。核心不识别这些平台的响应字段。核心负责权限、统一结构校验、候选排序、确认应用、数据库和客户端播放格式。元数据与歌词可以选择不同来源，所有候选都需要核对版本、艺人和时长。

## Web 导入与维护

0.5.12 开发分支将导入新插件与已安装插件分开，每个来源用一张卡片展示启用状态、能力和配置。ZIP 支持选取与拖放；每次一个非空 ZIP，最大 16 MiB。选中后显示文件名与大小，点击导入／确认升级才发送；服务端仍负责包结构、身份和版本校验。处理中防止重复提交，失败保留文件供重试。单个插件的保存／测试／升级反馈在卡片内显示，不覆盖其他插件未保存的设置。

“版本与维护”默认折叠，包含显式确认升级、导出原始 ZIP、停用并保存后卸载。导出不含配置与密钥，升级保留配置且停用的服务端规则不变。该分支尚未发布或部署；真实后端导入／配置／测试／导出／升级／卸载与桌面／手机布局分别回归。

## 包结构与生命周期

```text
manifest.json          必需，UTF-8 JSON，位于 ZIP 根目录
adapter.py             必需，入口模块
lyric_formats.py       可选，由插件维护的格式解析
lib/                   可选，兼容 Python 3.12 的随包依赖
LICENSE                许可证
README.txt             配置、依赖及平台使用条件
```

```json
{
  "id": "example-source",
  "name": "示例音乐来源",
  "upstream": "https://example.com/source",
  "license": "GPL-3.0-only",
  "version": "1.0.0",
  "api_version": 1,
  "entrypoint": "adapter:Plugin",
  "capabilities": ["metadata", "lyrics", "cover"],
  "requires_modules": [],
  "requires_programs": [],
  "cover_hosts": ["images.example.com"],
  "settings": [
    {"key": "base_url", "label": "API 服务地址", "type": "url", "required": true},
    {"key": "cookie", "label": "Cookie", "type": "secret"}
  ]
}
```

ID 为 2–41 个小写字母、数字、下划线或连字符，以字母开头。版本使用三段版本号，可带预发布后缀。配置类型为 `text`、`url`、`secret`。Secret 仅供插件调用，不回传客户端；空值保留现有值，管理 API 的 `clear_secrets` 可清除。

ZIP 最大16 MiB、展开32 MiB、300个条目，拒绝路径穿越、链接、加密、重复路径和文件／目录冲突。导入只注册并停用，不执行插件代码。升级须提交原配置版本及预期插件 ID，配置保留、版本递增且停用，管理员重新确认启用。历史已选歌词不因插件停用／卸载而消失；旧包文件保留用于恢复，卸载清除活动注册和该插件凭据。

插件是管理员信任的服务端 Python 代码，有服务进程账号所能访问的权限。独立子进程用于限制生命周期和故障影响，**不构成操作系统安全沙箱**。普通账号、模型和 MCP 凭据不能导入或启用插件。官方镜像提供固定 Python 3.12、Node 22 及 QQ SDK 运行依赖；维护者可用 `lib/` 携带兼容依赖并覆盖同名模块，无需修改核心。含本机二进制的依赖需匹配服务端架构。

### 编译模块与闭源分发

源码插件继续使用原来的入口，无需修改 manifest 或重新打包。编译插件也保留薄入口 `adapter.py`，例如 `from plugin_core import Plugin`，将业务实现编译成 CPython 扩展并放在 ZIP 根目录或 `lib/`：

```text
manifest.json                          entrypoint 仍为 adapter:Plugin
adapter.py                             from plugin_core import Plugin
lib/plugin_core.cpython-312-…so         Nuitka --module 产物
```

`requires_modules: ["plugin_core"]` 会使用当前解释器的模块查找器识别源码、包以及兼容的 `.so`／`.pyd` 后缀，不在主进程执行插件。不同 CPython ABI 标记的产物不会被当成可用依赖。加载和调用沿用现有 worker；不支持用二进制文件直接取代 `adapter.py`。

构建示例：`python -m nuitka --module plugin_core.py --output-dir=dist --no-pyi-file`。使用与服务器相同的 CPython 3.12、操作系统、CPU 架构和动态库环境；Linux 官方镜像基于 Debian Bookworm，多架构分别构建，macOS 产物不能放入 Linux 镜像。产物保留原文件名及模块名。随包文档标明目标平台、架构、Python 版本和动态库要求；编译不保证无法逆向。

`make test-native-plugin` 在当前平台编译合成模块，验证真实 ZIP 导入、停用默认值、依赖识别、worker 的 search／metadata／lyrics 调用、升级与导出；常规 `make test` 继续覆盖原有源码插件，并验证新库为空、重启保留已有安装与密钥。测试只使用合成内容。

2026-11-01 本地验证：macOS ARM64／CPython 3.12 的真实 Nuitka 编译模块回归通过；插件聚焦回归 18 项通过，包含实际服务重启、源码文件／包和扩展后缀识别。Linux 与 Windows 编译产物尚未验证。

## 入口契约

入口类实例提供三个同步方法。稳定导入路径为 `wildstring.plugin_api`，可取得 `Manifest`、`PluginError` 和基础 LRC 解析器 `parse_lyrics`。平台格式解析应随包提供。

```python
class Plugin:
    def search(self, context, query):
        return [{"id": "opaque-provider-id"}]

    def metadata(self, context, candidate):
        return {
            "id": "opaque-provider-id",
            "release_id": "edition-id",
            "duration_ms": 240000,
            "fields": {"title": "歌曲", "artists": ["艺人"], "album": "确认的发行版"},
            "source_url": "https://example.com/song/123",
            "cover_url": None,
        }

    def lyrics(self, context, candidate):
        return {
            "format": "lrc",
            "original": "[00:01]歌词",
            "normalized": {
                "format": "lrc", "kind": "synced",
                "lines": [{"time_ms": 1000, "text": "歌词"}],
                "layers": {},
            },
        }
```

`search` 的候选结构不透明，由同包 `metadata` 消费。核心最多取3个候选；`metadata.fields` 使用现有元数据覆盖字段及同样校验。歌曲／发行 ID、来源 URL、时长与匹配依据保留，录音首次发行时间 `original_date` 与本发行日期 `release_date` 分开；不要把再版日期写成首发日期。封面仅接收现有公共 CAA 或插件 manifest `cover_hosts` 声明的 HTTPS 域名及其子域名，确认后下载。

`lyrics` 接收已归一化的 metadata 候选，可保留平台额外字段。`normalized` 为 `none`、`plain` 或 `synced`；时间均为整数毫秒，逐字可增加 `words: [{text, start_ms, end_ms}]`，行可增加 `end_ms`。译文和罗马音分别保留于 `layers.translation`、`layers.romanization`，每层为行数组。没有 `normalized` 时核心仅尝试标准 LRC／纯文本。插件应完成平台加解密、歌词匹配及转换，再返回统一结构。

原文最多512 KiB，归一化最多2 MiB、5000行、单行2000字块、时间范围0–24小时。列表只返回100行预览及完整行数，完整内容和原文保留服务端。每首保留最近5批查询及正在使用的旧候选。确认应用使用歌词版本和文件版本，偏移允许±60秒；仅更新数据库，不改写音乐。手动编辑会取代所选在线歌词。

当前开发分支在播放和候选预览接口的每个原文行附带可选 `translation`、`romanization` 文本字段，供两端一致显示。语言层仍保留原有结构；服务端按时间配对，容忍最多250毫秒差异，不按数组下标硬拼。修复内容、验证与未实现边界见[歌词跟随与双语显示](../product/lyric-follow-and-languages.md)。

0.5.3参考插件版本为1.1.0，QQ SDK仍锁定0.8.2。可选manifest字段 `request_pacing: true` 声明所有物理请求使用运行时门控；未声明时宿主仅控制调用间隔。后台扫描、设置及兼容边界见[歌词补全与洗版](../product/lyric-scans.md)。

0.5.4参考ZIP为1.1.1。酷狗／网易云使用各自的最小元数据工作区，适配、上游归档哈希、来源文件与许可证在`plugins/node-runtime/vendor`；生成及核验入口为`make source-providers-check`，说明见[插件运行依赖](../../plugins/node-runtime/README.md)。不再安装Forge、PAC解释器及FTP依赖，显式HTTP(S)代理继续支持。

## 插件上下文与运行边界

- `context.data["config"]`：本插件非敏感配置；`context.data["secrets"]`：本插件凭据。
- `context.directory`：本插件的持久私有状态目录。
- `context.http(url, payload=None, headers=None)`：JSON HTTP，继承管理员选择的出站代理；单请求最长12秒、响应2 MiB。`payload` 非空时 POST，否则 GET；返回 JSON 对象。
- `context.bridge(path, parameters)`：请求配置的 `base_url`，Cookie 通过请求头发送，适合独立部署的社区 API。
- 仅允许 `search`、`metadata`、`lyrics` 方法。子进程调用最长60秒，每个查询上下文90秒；测试按钮25秒。结果缓存30分钟，按包摘要、配置版本和请求隔离。改变配置或升级后旧缓存不会复用。
- 错误用 `raise PluginError("source_plugin_no_lyrics")` 等简短代码；不要把 Cookie、令牌、URL 查询里的密钥或上游完整异常放入错误文本。stdout 留给协议，普通打印转 stderr 并丢弃。

QQ 包使用 [QQMusicApi](https://github.com/L-1124/QQMusicApi) 0.8.2；酷狗包对应 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)；网易云包对应 [NeteaseCloudMusicApiEnhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)。后两个 ZIP 已包含锁定提交的元数据／歌词模块，官方镜像提供 Node 22 通用运行时，默认无需单独部署上游服务；也可填写外部 HTTP 服务地址。平台 Cookie 为可选配置，覆盖仍取决于上游授权。它们均为社区项目，并非平台官方 API；不提供音频下载。格式处理参考 [LDDC](https://github.com/chenmozhijin/LDDC)，不加载 Qt 桌面程序。上游及平台条款、覆盖和可用性由插件说明和维护者核验。

本仓库参考包源码在 `plugins/`，用 `make source-plugins` 打包。网易云／酷狗包内的 `service.cjs` 由 `plugins/node-runtime/package-lock.json` 锁定上游提交与传递依赖，只包含所用元数据和歌词接口；不用上游登录／反作弊模块、PAC／FTP 代理，不包含音频下载。Node-forge 的已知签名校验通告未覆盖本包仅使用的公钥加密路径；维护者扩展接口前仍应重新审计依赖和可达路径。许可证保留在 `THIRD-PARTY-NOTICES.txt`。

第三方可独立维护同样格式的 ZIP，不需要向核心增加平台枚举。无需为此部署额外 MCP Server。
