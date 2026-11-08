# 暗色主题（Warm Carbon）迁移契约

数值与角色的唯一来源是 [`DESIGN.md`](../DESIGN.md) §3.2、§6.7 与 §7。本文件只记录范围、旧值到令牌的对应关系、各端状态和验收，不复制新色值。

## 1. 目标与范围

- 暗色从「Charcoal Olive」（灰绿底）改为「Warm Carbon」（暖褐黑底），与亮色同一色相家族，与珊瑚强调色协调。
- 橄榄/鼠尾草色只保留为文字色（`--olive`），不再作为暗色下的面、胶囊、按钮填充。
- 新增 `--accent-container`（强调色的低饱和填充），取代实心褐红 `#5A2E22`。
- 黑胶盘面、盘边、唱臂配色同步改为暖色（§6.7）。
- **不变**：亮色主题全部令牌；强调色、`--on-accent`、`--success`、`--warning`、`--danger`、`--olive`、`--accent-hover`；布局、字号、间距。

## 2. 旧值到令牌（仅供搜索替换）

| 旧值（已废弃） | 对应令牌 | 说明 |
| --- | --- | --- |
| `#171716`、`#191A17` | `canvas` | Android Material 旧值是 `#191A17` |
| `#1C1E18` | `--sidebar` | |
| `#22251E`、`#22241F` | `panel` / `surfaceContainer` | |
| `#292C24`、`#292B25` | `raised` / `surfaceContainerHigh` | |
| `#191D17` | `--surface-input` | 新值低于画布（凹入），不是高于画布 |
| `#30332B`、`#33362E` | `--bg-hover` / `surfaceContainerHighest` | |
| `#262B21` | `--row-active` | |
| `#30352A`、`#353A2F` | `--nav-active` / `--tag-bg` | 选中胶囊、AI 徽章、中性标签 |
| `#33342E`、`#43473D` | `--border` | |
| `#EEEAE2` | `--text` | |
| `#A8A59C`、`#A8AA9D` | `--muted` | |
| `#8E9284` | `--faint` | 新值在 hover 面上不足 4.5:1，hover 面上用 `--muted` |
| `#5A2E22` | `--accent-container` | 文字色 `#FFDBCC` 不变 |
| `#30352C`、`#11150F`、`#252B20`、`#BBC1AD`、`#191C15` | 黑胶盘面、纹路、轴心 | 见 §6.7 |

橄榄色填充一律不保留：凡暗色下用橄榄背景的位置，选中态用 `--nav-active` 或 `--accent-tint`，强调按钮用 `--accent-container`。

## 3. 各端状态与入口

| 端 | 状态 | 需要改的位置 |
| --- | --- | --- |
| Android | 已按规范实现，**未做截图验收**：只在一台真机看过发现页，没有逐页走查 | `ui/WildStringApp.kt` 的 `classicDarkColors`；`ui/PlaybackVisual.kt` 黑胶；`res/values/styles.xml` 窗口背景 |
| Web | 未做 | `src/style.css`、`src/theme.tsx`、`index.html`（`theme-color` 与首屏背景）、`src/workspace.css`、`src/podcasts.css`、`src/completion.css`、`src/desktop-help.css`、`src/playback-style.css`（黑胶、唱臂） |
| macOS | 未做 | `WildStringMac/MacChrome.swift` 的 `MacTheme` 暗色分量；黑胶若有绘制，同步 §6.7 |
| iOS | 未做 | `WildString/Appearance.swift` 与 `Assets.xcassets`；暗色目前依赖系统色的位置需要核对是否应改为 `canvas` 等令牌 |

应用图标（`app-icon.svg`、`ic_wildstring.xml`、`icon_colors.xml`）含旧橄榄色，**不在本次范围**，需要时单独决定。

## 4. 实现规则

1. 令牌名在各端保持一致，数值只改令牌定义处，不在组件里写死色值。
2. Android 的 Material 映射见 `DESIGN.md` §3.2「Android Material mapping」。
3. 选中、播放中的状态沿用 `--accent-tint`（强调色 14%），不要新增别的叠色。
4. 黑胶：盘下接触阴影不随盘旋转；盘边不得出现明亮的环；唱臂为哑光暖金属，不用镀铬或绿色。动画仍只用 `transform`/`opacity`，并遵守 `prefers-reduced-motion`。
5. 不得引入纯黑 `#000000` 背景或冷蓝、霓虹紫。

## 5. 验收（L2，跨端令牌）

- 对每一端：`git grep` 上表中的旧值，确认不再出现在暗色路径（图标除外）。
- 对比度：`--text`、`--muted`、`--olive`、`--accent`、状态色在 `canvas`、`--sidebar`、`panel`、`raised`、`--row-active`、`--nav-active` 上不低于 4.5:1；`--faint` 不用于 `--bg-hover`；`--on-accent` 在 `--accent` 上、`#FFDBCC` 在 `--accent-container` 上同样不低于 4.5:1。
- 视觉：桌面与 390px 宽度，浅色与深色各一次，逐张查看截图。必看页面：电台列表、节目详情、待播列表、音乐播放器（黑胶）、播客播放器、设置、对话框与菜单、搜索框。重点检查选中胶囊、播放中行、`--accent-container` 按钮、黑胶盘面与唱臂。
- 状态：Loading / Empty / Error / 权限不足 在暗色下可读。
- 走通：播放、切页、返回；播放器各样式（封面、黑胶、磁带）切换。
- 命令：Web `make test-affected-desktop`；macOS `make macos-test`；iOS `make ios-test`；Android `make android-ci`。发布前 `make ci`。

## 6. 已知风险

- `--faint` 在 `--bg-hover` 上仅约 4.4:1，规范已要求该面使用 `--muted`；迁移时容易漏。
- Web 有多个 CSS 文件各自写了暗色值，需逐个替换，避免只改 `style.css`。
- 暗色下以橄榄色相写死的组件（徽章、推荐理由底、磁带外壳等）需要逐个判断是否属于「面填充」。
