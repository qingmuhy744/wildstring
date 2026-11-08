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
| Android | 已按规范实现并提交，**未做截图验收**：只在一台真机看过发现页，没有逐页走查 | `ui/WildStringApp.kt` 的 `classicDarkColors`；`ui/PlaybackVisual.kt` 黑胶；`res/values/styles.xml` 窗口背景 |
| Web | 已实现（2026-11-09）：令牌、散落暗色值、黑胶盘面/纹路/唱臂/枢轴、`theme-color` 全部换暖；`podcast-player.spec.ts` 两处旧色断言同步更新 | `src/style.css`、`src/theme.tsx`、`index.html`、`src/workspace.css`、`src/podcasts.css`、`src/completion.css`、`src/browse.css`、`src/desktop-help.css`、`src/podcast-player.css`、`src/playback-style.css`、`tests/podcast-player.spec.ts` |
| macOS | 已实现（2026-11-09）：`MacTheme` 与 `MacRootView` 侧栏的暗色分量全量换暖；黑胶盘面、纹路、唱臂、唱头、枢轴同步 §6.7 | `WildStringMac/MacChrome.swift`、`WildStringMac/MacRootView.swift`、`WildStringMac/MacFullscreen.swift` |
| iOS | 已实现（2026-11-09）：仅播放器自定义绘制面（背景画布、黑胶盘面/纹路/轴心）换暖；列表等系统色界面保持 iOS 原生外观，未引入令牌 | `WildString/NowPlayingView.swift` |

例外（按约定保留）：电台节目占位封面插画（`podcasts.css` 收音机拨盘一带）与应用图标仍为旧橄榄插画色，属美术资产而非主题面，另议；`podcast-search.css` 中 `var(--muted, #9ca3af)` 等回退值在 `:root` 恒有定义、永不渲染，未改动。

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

## 7. 迁移执行记录（2026-11-09，Web/macOS/iOS）

- 已验证：`make check` 全绿（含 Web format/typecheck/i18n）；`make test-affected` 全绿（backend + Playwright，含同步后的 `podcast-player` 30 项）；`make macos-test` 37 项通过；`make ios-test` 105 项通过；`make ios-build` 编译 app target 确认 `NowPlayingView` 可构建。全仓 `git grep` 契约 §2 旧值清零（图标与插画例外除外）。
- 对比度：新令牌在 `canvas/sidebar/panel/raised/row-active/nav-active` 上 `--text`≥10.2、`--muted`≥5.3、`--faint`≥4.5、`--olive`≥6.8、`--accent`≥5.2；`--faint` 在 `--bg-hover` 上 4.35:1，规范已限定该面用 `--muted`；`--on-accent` 6.7、`#FFDBCC` 9.6。
- 视觉（已逐张查看）：Web 桌面 1360 与 390px、浅深各一轮——库列表、电台页（含空态）、节目详情、管理中心、黑胶全屏播放器、迷你播放条与正在播放行；macOS 渲染测试 PNG——全屏宽/窄×浅深、队列浮层浅色。浅色主题确认未受影响。
- 未覆盖：Android 仍无逐页截图走查；iOS 未做模拟器渲染截图（仅单元测试 + 编译）；Web 的 Loading/Error 边界状态、播放器样式切换（封面/磁带）与真实播放走查未逐项执行；`make ci` 未跑（发布前需要）。
- 实现方式备忘：Web 在令牌精确映射之外，对残留的暗色橄榄色相写死值做了保明度、色相归 30° 的程序化转换（限暗色作用域，饱和度封顶 22%），使历史漂移的表面/边框色保持层级地并入暖色族；磁带外壳随动换暖，浅色作用域与语义绿（成功/在线）不参与。
- 去硬编码（2026-11-09 第二轮）：Web 补齐 `--faint` 双主题令牌，`podcast-*`/`workspace-*`/`--paper` 别名定义改为引用共享令牌，组件规则中与令牌等值的写死色值替换为 `var()`（`var()` 回退值、深色遮罩 `#181614aa/bb`、黑胶与磁带等主题无关的绘制面、无对应令牌的漂移色除外）；macOS `MacRootView` 侧栏色板改为别名 `MacTheme`（仅 `sidebarFaint` 因亮色值有意不同而保留本地定义）；iOS 新增 `Color.playerCanvas` 动态令牌供播放器画布使用。`make check`、`make test-affected`（含浅深色断言）与浅深截图对照确认渲染不变。

## 6. 已知风险

- `--faint` 在 `--bg-hover` 上仅约 4.4:1，规范已要求该面使用 `--muted`；迁移时容易漏。
- Web 有多个 CSS 文件各自写了暗色值，需逐个替换，避免只改 `style.css`。
- 暗色下以橄榄色相写死的组件（徽章、推荐理由底、磁带外壳等）需要逐个判断是否属于「面填充」。
