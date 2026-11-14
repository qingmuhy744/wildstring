# DESIGN.md — WildString (野弦)

## 1. Product Overview & Brand Identity

- **Product Name**: WildString (野弦)
- **Tagline**: 个人声音档案 (Personal Sound Archive)
- **Category**: AI-native, self-hosted music & podcast player across Web, macOS, iOS, and Android.
- **Core Value**: A calm, personal, archival listening space for a user's own music collection and subscribed podcasts, paired with a grounded AI music assistant for natural-language track discovery, playlist curation, and metadata organization.
- **Brand Persona**: Warm, literary, tactile, archival, and unhurried—like album liner notes printed on warm cotton paper, paired with classic analog audio equipment (vinyl turntables, cassette tapes, and bakelite FM radios) and modern typographic clarity.

---

## 2. Aesthetic Direction & Design Principles

1. **Warm Archival Paper & Olive Ink (Not Cold Tech SaaS)**
   - Rejects pure `#000000` / `#FFFFFF` and generic neon purple/blue streaming aesthetics.
   - Uses warm unbleached paper (`#F6F3ED`), soft olive-grey stone (`#EEEEE5`), warm carbon (`#181614` / `#211E1B`), and terracotta coral (`#BC5438` / `#E98A6D`).
2. **Editorial Hierarchy**
   - Page titles, album headers, and daily curation titles use a refined Serif display voice (`Songti SC`, `Source Han Serif SC`, `Newsreader`, `Iowan Old Style`) to evoke printed liner notes and broadsheets.
   - Catalog tables, controls, and metadata use crisp system Sans-Serif with strict tabular numerals (`font-variant-numeric: tabular-nums`) for timestamps, track numbers, and audio specs.
3. **Information De-noising & State Clarity**
   - Visual emphasis belongs only to what is **currently playing** or **in progress**.
   - Completed podcast episodes are visually muted (greyed-out title + subtle checkmark + `"已听完"`) with no full-width progress bar clutter.
   - In-progress podcast episodes highlight remaining time (`"剩 N 分钟"`) in warm terracotta with a slim proportional progress bar.
4. **Safe & Forgiving Interactions**
   - Primary actions (`播放全部`, `继续收听`) are prominent warm-coral pills.
   - Destructive or low-frequency actions (`取消订阅`, `从歌单移除`, `不感兴趣`) are tucked inside `⋯` overflow or context menus, never placed directly adjacent to primary playback buttons.
5. **Honest Analog Tactility**
   - Fullscreen playback supports **Cover**, **Vinyl**, **Cassette** (for music), and **Retro Bakelite Radio + Broadsheet** (for podcasts).
   - Decorative motion (turntable rotation, tape reels, radio dial backlight) is strictly driven by real `isPlaying` state and respects `prefers-reduced-motion`.
   - The radio play control may pair with a short synthesized power-switch click (≤120 ms, Web Audio, no audio assets). It is strictly opt-in, off by default, and saved per account in the browser.
   - The radio VU window shows one sample-peak LEVEL ramp (instant attack, smooth release) with a 2px bright hold marker recording the displayed ramp’s maximum on the same track. The marker follows a rising ramp immediately when it catches up and never falls inside the displayed ramp. The ramp releases toward the current sample peak using a time-normalized exponential factor of `0.9^(elapsedSeconds × 60)`. The `AnalyserNode` tap on the shared playback graph down-mixes the output; both readings map −60 dBFS..0 dBFS to 0..1. A dBFS scale above the track marks −40, −20, −10, −3 and 0 with 3px short ticks at their true positions. Numeric labels use 11px tabular monospace and share a single baseline; omit labels as space narrows rather than staggering or redistributing the ticks. Keep −40, −20 and 0 readable at narrow widths; show −10 only above the 760px Web breakpoint and when the meter container is wider than 152px, and use an unlabelled tick for −3. Align scale and peak marker to the same track width. At viewport widths ≤380px, the radio control columns use 1.3fr / 1fr / 48px with an 8px gap and 6px meter horizontal padding to preserve readable labels at the supported minimum width. Each new displayed maximum resets the marker’s 500 ms hold; after the hold it decays on the normalized dB scale retaining 74% per second, bounded below by the displayed ramp; sampled absolute amplitude ≥1 turns it red for 1 second after the latest full-scale sample. The ramp only enters red near 0 dBFS. Release uses elapsed time so refresh rate does not change the ballistics. Pause, buffering, errors and reduced motion reset the readings and warning, including when reduced motion changes during playback. Reveal the ramp and position the peak marker using `transform` only; never animate layout or `clip-path`.

---

## 3. Color System & Theme Tokens

WildString supports two themes: **Light (Warm Paper — Daylight)** and **Dark (Warm Carbon — Night)**. Android follows the system, or a saved light or dark choice.

### 3.1 Light Theme (Warm Paper & Daylight Olive)

| Token | Hex | Role & Usage |
| :--- | :--- | :--- |
| `--bg` / `canvas` | `#F6F3ED` | Primary page canvas (warm unbleached paper) |
| `--surface-subtle` / `sidebar` | `#EEEEE5` | Left navigation sidebar, inspector drawer, secondary chrome |
| `--surface` / `panel` | `#FAF9F4` | Cards, track rows, hero panels, bottom transport bar |
| `--surface-input` / `raised` | `#FFFDF8` | Search inputs, active form fields, slider thumbs, elevated modals |
| `--bg-hover` | `#E4E7DB` | Hover state for buttons, chips, and interactive surfaces |
| `--row-active` / `accentSoft` | `#DDE2D0` | Selected sidebar item & currently playing track row background |
| `--border` | `#DEDED2` | Hairline dividers (`1px`), card borders, inactive progress tracks |
| `--border-strong` | `#C9CBBD` | Secondary button borders and input outlines |
| `--text` / `ink` | `#2A2B25` | Primary body text, track titles, active headings |
| `--muted` | `#626457` | Secondary text, artist/album names, inactive nav labels |
| `--faint` | `#6A6E5B` | Timestamps, table column headers, completed podcast episodes (≥ 4.5:1 on canvas, panel and sidebar; use `--muted` on `--row-active`) |
| `--accent` | `#BC5438` | Primary terracotta coral (play buttons, active indicators, progress fill) |
| `--accent-text` / `accentDeep` | `#9F422B` | High-contrast terracotta for text links, badges, and active icons |
| `--olive` | `#57492F` | Warm archival olive-brown for recommendation reasons & editorial tags |
| `--olive-soft` | `#E4E7DB` | Soft sage pill background for AI/editorial badges |
| `--on-accent` | `#FFFAF3` | Text and icons placed on top of `--accent` buttons |
| `--success` | `#496332` | Success status text and icons |
| `--warning` | `#80591E` | Warning status text and icons |
| `--danger` | `#A64027` | Destructive actions (`取消订阅`, `删除`) |
| `--danger-container` | `#F5D8CE` | Muted fill behind danger chips/actions |
| `--on-danger-container` | `#7A2815` | Text/icon on `--danger-container` |
| `--accent-container` | `#F5DDD4` | Tonal accent fill (accent-container semantics, badges); pairs with an ink `#3A160B` (`on-accent-container`) |
| `--tag-bg` | `#E0E5D6` | Neutral tag and chip fill |
| `--accent-hover` | `#A8472E` | Hover state for primary accent controls |
| `--accent-tint` | `--accent` at 14% | Currently playing podcast episode row fill |

### 3.2 Dark Theme (Warm Carbon & Warm Coral)

Dark shares the hue family of Light: every neutral sits at hue 25°–35° with 6%–10% saturation (warm brown-black), matching the terracotta accent. Olive/sage appears only as a text colour, never as a surface fill — an olive fill at night reads as muddy grey-green.

| Token | Hex | Role & Usage |
| :--- | :--- | :--- |
| `--bg` / `canvas` | `#181614` | Primary page canvas (warm carbon black) |
| `--sidebar` | `#1D1A18` | Left navigation sidebar & right inspector background |
| `--surface` / `panel` | `#211E1B` | Cards, track rows, hero panels, bottom transport bar |
| `--surface-subtle` / `raised` | `#2A2622` | Elevated cards, menus, dialogs |
| `--surface-input` | `#131110` | Search inputs and form fields (recessed below the canvas) |
| `--bg-hover` | `#34302A` | Hover state for rows and secondary controls |
| `--row-active` / `accentSoft` | `#2B2521` | Currently playing track row fill |
| `--nav-active` / `oliveSoft` / `--tag-bg` | `#2E2924` | Selected sidebar navigation pill, selected chip, AI badge and neutral tag fill (warm taupe) |
| `--border` | `#3A352F` | Hairline dividers (`1px`) and card strokes |
| `--text` / `ink` | `#E8E3D9` | Primary warm parchment text |
| `--muted` | `#AAA59A` | Secondary metadata text (artist, album, descriptions) |
| `--faint` | `#9A948A` | Timestamps, disabled/completed episode text, section kickers (≥ 4.5:1 on canvas, sidebar, panel, raised, row-active and tag; use `--muted` on `--bg-hover`) |
| `--accent` / `--accent-text` / `accentDeep` | `#E98A6D` | Warm coral accent for buttons, active waveform, and progress bars |
| `--accent-hover` | `#F0A48A` | Hover highlight for primary accent controls |
| `--accent-container` | `#43302A` | Tonal accent fill (queue/play-all buttons, accent badges); text on it uses `#FFDBCC` (9.6:1). Replaces the solid maroon `#5A2E22` |
| `--olive` | `#B4C09E` | Soft sage-olive **text** for recommendation reasons (`reason`) |
| `--on-accent` | `#211B17` | Dark ink icon/text on `--accent` primary buttons |
| `--success` | `#B2C69A` | Success status text and icons |
| `--warning` | `#E5BD7C` | Warning status text and icons |
| `--danger` | `#F2A392` | Error banners and destructive menu items |
| `--danger-container` | `#3F241E` | Muted fill behind danger chips/actions |
| `--on-danger-container` | `#F2A392` | Text/icon on `--danger-container` |
| `--accent-tint` | `--accent` at 14% | Currently playing podcast episode row fill and selected states that need warmth |

Dark has no `--border-strong`; secondary button and input outlines use `--border`. Verified contrast: `--text` ≥ 10.2:1, `--muted` ≥ 5.3:1 and `--olive` ≥ 6.8:1 on every surface above; `--accent` ≥ 5.2:1.

**Android Material mapping**: `background`/`surface` = `canvas`; `surfaceContainerLowest` = `--surface-input`; `surfaceContainerLow` = `--sidebar`; `surfaceContainer` = `panel`; `surfaceContainerHigh` = `raised`; `surfaceContainerHighest` = `--bg-hover`; `surfaceVariant` and `secondaryContainer` = `--nav-active`; `primaryContainer` = `--accent-container`; `tertiary` = `--accent-text`; `tertiaryContainer` = `--accent-container`; `error` = `--danger`; `errorContainer` = `--danger-container`; `onError` / `onTertiary` / `onErrorContainer` = `--on-accent` / `--on-accent` / `--on-danger-container`; `inverseSurface` / `inverseOnSurface` = dark: `raised` / `--text`, light: `--text` / `canvas` (status Snackbars stay warm instead of Material's pale inverse bar); `outlineVariant` = `--border`; `onSurface` = `--text`; `onSurfaceVariant` = `--muted`.

---

## 4. Typography & Scannable Hierarchy

### Font Stacks
- **Editorial Display (`--font-display`)**:
  `"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "Iowan Old Style", "Newsreader", Georgia, serif`
  - Used for: Brand title (`野弦`), page headers (`24px–28px`, medium weight), daily recommendation hero title (`今天，听点喜欢的`), fullscreen song/podcast titles, and podcast broadsheet articles.
- **UI & Catalog Sans (`--font-sans`)**:
  `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Inter", system-ui, sans-serif`
  - Used for: Navigation, track lists, buttons, chips, form controls, and settings.
- **Technical & Time Mono (`--font-mono`)**:
  `"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace` with `font-variant-numeric: tabular-nums`
  - Used for: Track durations (`3:42`), podcast remaining time (`-33:27`), rank badges (`01`, `02`), playback speed pills (`1.5×`), and audio quality badges (`FLAC · 96kHz`).

### Type Scale
- **Hero / Page Title**: `24px–28px`, `font-weight: 500–600`, `line-height: 1.25`, Display Serif.
- **Section Heading**: `15px–16px`, `font-weight: 600`, Sans-Serif.
- **Track / Episode Title**: `13px–14px`, `font-weight: 400` (default) / `600` (currently playing), single-line truncated (`text-overflow: ellipsis`).
- **Secondary Metadata (Artist / Album / Date)**: `12px`, `color: var(--muted)`.
- **Recommendation Reason / Tag**: `11px`, `color: var(--olive)`.
- **Micro Kicker / Table Header**: `10px–11px`, `font-weight: 600`, `letter-spacing: 0.05em`, `color: var(--faint)`.

---

## 5. Layout, Grid & Spatial Architecture

### 5.1 Desktop & Web Shell (Three-Zone + Bottom Bar)
- **Window Minimum**: `1100px × 720px`
- **Left Sidebar (`228px–240px` fixed)**:
  - Top brand header (`waveform` badge + `野弦` serif title + `个人声音档案` subtitle).
  - Grouped navigation:
    - Primary: `首页`, `搜索`
    - `曲库`: `全部歌曲`, `专辑`, `艺人`, `歌单`, `我喜欢` (with count badge)
    - `发现与电台`: `每日推荐`, `电台` (Podcasts), `音乐助手` (AI), `播放队列` (with count badge)
    - `更多音乐`: `收听记录`, `跨设备继续`, `通知`, `待确认草案`
  - Bottom pinned area: Segmented Appearance Switcher (`自动 | 浅色 | 深色`), `管理`, `设置`, `退出登录`.
- **Main Content Area (`flex: 1`, `background: var(--bg)`)**:
  - Content max-width `1180px` (`860px` for reading-heavy podcast detail panes), `24px` horizontal padding.
- **Right Inspector Drawer (`336px` collapsible)**:
  - Toggles between synchronized **Lyrics (`歌词`)** and **Playback Queue (`播放队列`)** without leaving the current catalog page.
- **Bottom Transport Bar (`84px` height, `background: var(--surface)`, `1px` top border)**:
  - **Left (`26%`, max `330px`)**: `48×48` rounded artwork (`6px` radius), track/episode title, clickable artist/show subtitle, favorite heart icon.
  - **Center (`max-width: 560px`)**:
    - Music mode: `Shuffle`, `Previous`, `Play/Pause` (`38×38` `--accent` circle), `Next`, `Repeat`.
    - Podcast mode: `Sleep Timer` (`moon` icon), `-15s`, `Play/Pause` (`38×38` `--accent` circle), `+30s`, `Playback Rate Pill` (`1.0×` / `1.5×` bordered capsule).
    - Progress row: Elapsed time (`12:34`), **Buffered Scrubbing Bar** (`5px` track height, `--accent` 28% buffered range, `--accentDeep` played range, `14×14` white thumb with `2px` coral stroke), and Total/Remaining time (`-33:27` for podcasts).
  - **Right (`26%`, max `330px`)**: Mute toggle + compact `72px` Volume Slider, Lyrics toggle, Queue toggle, Fullscreen toggle, Desktop Lyrics toggle.

### 5.2 Accessibility Floor

- **Text contrast**: body and metadata text must reach 4.5:1 against the surface it sits on, in both themes. `--accent` is for fills, progress and large icons; accent-coloured text uses `--accent-text`. On `--row-active` use `--muted`, not `--faint`.
- **Type size**: no text below 11px; Chinese text below 12px is limited to micro kickers and table headers.
- **Touch targets**: interactive controls are at least 44×44pt on iOS and 48×48dp on Android. Visually smaller controls (such as the `32×32` `⋯` button) expand their hit area on touch platforms. Desktop controls are at least 28×28.
- **Focus**: every focusable control shows a 2px `--accent` focus ring with a 2px offset. The ring is never removed without a replacement.
- **Playback state**: play/pause, favorite, shuffle, repeat and mute expose their current state to assistive technology (`aria-pressed` on Web, `selected` / `stateDescription` on Android and `accessibilityValue` on Apple platforms). Progress sliders announce elapsed and total time.
- **Colour is never the only signal**: completed episodes keep the checkmark and `已听完`; in-progress episodes keep `剩 N 分钟`; errors keep their text.

### 5.3 Narrow Screens & Native Clients

- **Web breakpoints**: the shell reflows at `1100px`, `980px`, `760px` and `700px`. Below `760px` the sidebar collapses and the layout is single-column; the supported minimum width is `320px`, and acceptance is checked at `390px`.
- **Android AVD & input**: Local emulators and test profiles must enable physical hardware keyboard input (`hw.keyboard = yes`), ensuring typing and keyboard navigation work seamlessly in Android Studio Running Devices and standalone windows. The reference testing baseline pins two standard profiles: Phone (1080×1920) and Pad (2560×1600).
- **Android Phone / Pad**: Classify the current available window as Pad when its shorter dimension is at least `600dp`; smaller split windows and folded foldables use Phone. Rotation of a phone does not turn it into Pad. Both layouts are touch-first and share navigation, ViewModel, playback and selection state. Preserve drafts and scroll anchors when the window changes; do not key pages by layout mode.
- **Navigation**: Android Phone uses the Material bottom `NavigationBar`; Pad uses a `NavigationRail`. The mini player sits at the bottom of the content, above Phone navigation, and expands to the fullscreen player. iOS uses `TabView`; Web keeps the transport bar at the bottom of the viewport.
- **Android catalog and search**: Keep absolute server item positions and the same scroll state across layouts. Albums use the existing adaptive cover grid. On Pad, artists and playlists use cards of at least `260dp`; track lists show artist, album and tabular duration columns when content width reaches `720dp`. Narrower lists retain the stacked metadata row. All row menus retain `48dp` touch targets.
- **Android podcast and assistant**: On Pad with at least `720dp` content width (after navigation and insets), show a `260dp` subscription column beside podcast details, or a `240dp` conversation column beside chat. Narrower windows retain hierarchical podcast navigation and the chat history dialog. The selected show/conversation stays shared across modes; each pane scrolls independently. Limit episode and chat reading width to `760dp`, centered in the remaining pane. With no selected podcast, keep subscription actions available and show one selection prompt in the detail pane.
- **Android player and queue**: Treat the safe drawing area as wide from `840dp` width and `480dp` height. For a music player with at least `840dp` width and `600dp` height, open the queue as a bottom-trailing floating panel, at most `360 × 520dp` and `24dp` from the safe edges. Narrower or shorter windows use a bottom sheet. The queue overlays the player without changing its layout; its close button, Back and tapping outside dismiss it. Lyrics stay in place and the transport queue control is the entry point. Queue rows retain their drag handles, insertion feedback, edge scrolling, and accessible move actions.
- **Android podcast player**: Phones switch Cover and Article with one shared 240ms ease: the content cross-fades with a slight scale while the control area morphs continuously (button sizes, secondary rows and the speed/queue chips animate together) instead of swapping. Article mode uses a compact reading bar (progress, ±15/30s and play/pause); previous/next, speed and queue move into a `⋮` menu. Wide layouts show the cover with full-size controls beside the article, so neither is compromised and the mode tabs are hidden. Motion follows the app preference and Android system animation settings.
- **Android settings**: On Pad at `840dp` safe width, show a `260dp` category column beside the selected settings content, with independent scrolling and the mini player below both columns. Initially select account and servers; keep the selection when the window changes size. Below that width use the existing hierarchical phone pages. The category column uses concise labels without descriptions or trailing arrows.
- **Action groups** wrap as whole controls; the primary action stays first and is never clipped. Secondary and destructive actions move into `⋯`.
- **Safe areas**: native bottom bars, mini players and sheets respect system insets; content never sits under the status bar, home indicator or gesture area.
- **Native tokens** use the same names and values as §3 (`MacTheme` and the Android `Appearance` colours mirror them); a value changes in `DESIGN.md` first, then in each client.

### 5.4 Boundary State Patterns

| State | Pattern |
| :--- | :--- |
| Loading | Layout-matched placeholder (rows or cards at their final height); no full-page spinner; keep already loaded content visible during refresh. |
| Empty | One calm sentence naming what is missing plus one action that fixes it (import, browse, subscribe). No illustration or slogan. |
| Error | `role="alert"`, `--danger` text, one sentence of what failed plus what to do next, with a `重试` control when retrying can help. Keep the surrounding page usable. |
| Permission denied | Same shape as Error without retry: state what is not allowed and who can change it (library owner) or which account to switch to. |
| Offline / AI unavailable | Basic browsing and playback continue; only the affected feature shows the Error pattern. |

---

## 6. Core Component Specifications

### 6.1 Track List & Card Rows (`MacPlayableTracks` / Web Track Table)
- **Header Bar**: Sticky column headers (`歌曲`, `艺人`, `专辑`, `时长`) on `var(--surface)` with `1px` bottom border.
- **Row Styling**:
  - Rounded card row (`10px` radius, `padding: 8px 12px`, `6px` vertical gap) with `var(--surface)` fill and `1px solid var(--border)`.
  - **Currently Playing State**: Fill shifts to `var(--row-active)` (`#DDE2D0` light / `#262B21` dark), border tints to `var(--accent)` at 45% opacity, with a `3px` vertical `--accent` pill indicator on the left edge and a `speaker.wave.2.fill` icon on the right.
  - Artist and Album names are interactive links that navigate directly to the Artist or Album detail view.

### 6.2 Daily Recommendations & Rankings (`每日推荐` / `收听排行`)
- **Top Segmented Switcher**: `每日推荐 | 收听排行` (`220px` width). When `收听排行` is active, right-aligned segmented pickers switch Scope (`我的 | 大家`) and Period (`7 天 | 30 天 | 全部`).
- **Compact Daily Hero Card**:
  - `16px` radius panel (`var(--surface)` with `1px` border).
  - **Left**: `84×84` **2×2 Cover Mosaic** (`12px` outer radius, `6px` inner cell radius, `4px` gap) composed from the first 4 recommended tracks.
  - **Center**: Date badge capsule (`11月3日 · 今日推荐`), optional `AI 整理` sage capsule, display serif title (`今天，听点喜欢的`), and source breakdown subtitle (`15 首 · 6 首来自收藏与常听，9 首来自曲库探索`).
  - **Right**: Prominent `播放全部` coral button above secondary compact buttons (`换一批`, `保存歌单…`, `挑选歌曲`).
- **Per-Track Recommendation Reason**:
  - Each track row displays its specific provenance (`来自红心曲目的同专辑作品`, `探索曲库中尚未听过的歌曲`) in `11px` `var(--olive)` directly beneath the track title.

### 6.3 Podcasts (`电台`) — Two-Pane Master-Detail
- **Left Sub-pane (`260px`)**:
  - Header (`我的订阅` / `全部节目`), rounded search input (`搜索节目`), and subscribed show cards (`44×44` cover, title, author, `99 未听 · 100 集`, coral checkmark).
- **Right Detail Header**:
  - `92×92` show artwork (`12px` radius), `24px` title, author, and positive availability copy: `共 100 集 · ` + coral `还有 99 集可听`.
  - Header action buttons:
    - Unified `待播列表` button opening the pending queue sheet/dialog (the ordered queue only, with `▶ 播放全部` and item-level play/remove controls). The per-show `新集自动待播` rule has no row of its own: it lives in the `已关注 ⌄` menu on the show page (a `新集待播` header with the three choices `自动加到队尾`, `自动加到最前`, `仅关注`, current one checked, then `自动下载` and a red `取消关注`), and the button shows the active rule as `已关注 · 队尾` (the quiet default `仅关注` adds no suffix). The rules tab remains the central management entry; redundant auto-limit spinbox/stepper stays out of the primary UI.
    - Quick play action: `▶ 播放待播 (N)` rendered whenever queued episodes exist (`queuedSet.size > 0`), starting playback of queued episodes in sequence.
  - Primary coral pill button (`▶ 继续收听` or `▶ 播放最新一集`) paired with a circular `32×32` `⋯` button housing `分享节目` and destructive `取消订阅`.
  - Collapsible 2-line show description with `展开简介` link.
- **Episode Filter, Sort & Grouping**:
  - Filter pills: `全部`, `未听完`, and `已收藏` (solid dark pill when active; when `已收藏` is selected, only favorited episodes are shown).
  - Right-aligned sort dropdown (`从新到旧 ⌄` / `从旧到新 ⌄`).
  - Time section headers: `本周` and `更早`.
  - Automatic title cleanup strips redundant trailing show-name brackets (e.g., `【王局拍案播客】`).
- **Episode Row States (Three Distinct Visual Tiers)**:
  1. **Currently Playing (`current`)**: Full-row warm tint (`--accent-tint`), left animated/colored `waveform` icon, bold ink title, subtitle `日期 · N分钟 · 正在播放` (in coral), inline queue button shows disabled `正在播放`.
  2. **In Progress / Unplayed**: Left bordered circular play button, normal ink title, subtitle `日期 · 剩 N 分钟` (coral highlight), and a slim `3.5px` coral progress bar at the bottom of the row if in progress. Inline queue button displays `+ 待播` or `✓ 已待播` (accent pressed style; clicking toggles queue status).
  3. **Completed (`completed` or `position >= duration`)**: Visual muting with row opacity `0.62`, muted grey play circle, **greyed-out title (`var(--podcast-subtle)` / `var(--faint)`)**, inline `✓ 已听完` status tag right after the title, muted subtitle `日期 · N分钟 · 已听完`, and **no bottom progress bar**.
- **Episode Context Menu (`RowMenu`) & Dialog Actions**:
  - `播放单集`, `下一集播放`, `加入待播` (or toggle via inline quick button).
  - `标为已听完` / `标为未听`: manual completion toggle immediately persisting progress and toggling row muting.
  - `单集收藏` / `取消收藏`: single-episode favorite toggle with heart icon (`<Icon name="heart" />`), updating favorited state and ensuring server audio cleanup protection.
  - `保存到服务器` / `取消个人保存`.
- **Podcast Episode Dialog (`PodcastEpisodeDialog`)**:
  - Modal view with show cover, title, metadata (pub date, duration, online/downloaded availability), rich description, and action buttons (`播放单集`, `下一集播放`, `加入待播`, `下载音频`, `保存到服务器`, `单集收藏` / `取消收藏`).
- **Android podcast exploration**: On Pad with at least `720dp` available content width, keep equally weighted result and preview panes with a `16dp` gap and independent scrolling. Automatically preview the first result after loading; this never adds or follows a show. The result list stays in place when selecting another show. Use native touch targets from §5.2 and preserve the selected card, search draft and result scroll position when resizing. Narrower windows use list-to-preview navigation, with Back returning to the results before closing exploration; in the wide layout the close action always exits exploration. A pasted RSS address uses one centered preview with a maximum reading width of `760dp`. Preview artwork uses the existing `92dp` show-header size. On Pad, place confirmation directly after a short preview; long previews scroll within the pane while keeping confirmation available. Keep search and region controls available in both modes.
- **Podcast Discovery & Chart Caching**:
  - 1-hour TTL in-memory caching and silent prefetch on idle (800ms debounce) for discovery charts, ensuring zero-latency reopen without loading flash.

### 6.4 Search (`搜索`)
- Warm canvas header with result counter (`共 N 项匹配`), primary `播放歌曲` button when track matches exist, `10px`-radius elevated search input (`var(--surface-input)` with focus accent ring), and category filter capsules (`全部`, `歌曲`, `专辑`, `艺人` with counts).
- Unified results view displaying interactive Track cards, Album grid cards (`148px` cover + `10px` card frame), and Artist horizontal cards (`48×48` circular avatar + album/track counts + chevron).

### 6.5 AI Music Assistant (`音乐助手`)
- Conversational interface grounded in real library track IDs.
- Supports model connection selector, natural-language queries ("找几首适合雨天夜晚听的器乐"), inline playable track cards with one-click `播放全部` or `保存为歌单`, and graceful degradation when AI connections are offline.

### 6.6 Lyrics View (`歌词`)
- **Only the current line is emphasized** (see §2, item 3): played and upcoming lines share one muted color; word-level karaoke tinting is confined to the active line, never accumulated on lines already sung.
- **Android bilingual lyrics**: place the source line first, followed by its translation and optional romanization as quieter secondary lines. Keep `4dp` within a line group and `28dp` between groups; the current group's secondary lines gain a gentle emphasis. Place language toggles in a stable toolbar above the scrolling viewport, without obscuring lyrics.
- **Position is content-driven**: the current line centers only within the scrollable range (`clamp(lineCenter − H/2, 0, maxScroll)`); short lyrics are centered as a block and never scroll; the first lines start from the top.
- **Follow recovery is shared across pointer types**: 2 s after manual browsing stops while playing; paused playback suspends the timer. Pointer-specific behavior is limited to line taps and seek confirmation.
- Cross-platform rules and per-platform implementation status: [`contracts/lyric-view.md`](contracts/lyric-view.md).

### 6.7 Music Vinyl Player

- With no valid saved music player style, default to Vinyl. Preserve an existing explicit Cover, Vinyl, or Cassette choice; changing this default must not overwrite it. Podcast playback keeps its own presentation.
- Vinyl sits on the theme canvas from §3, with restrained dark olive grooves and a slender tonearm. The disc uses `#2E2A25`, `#0F0D0B`, and `#221E1A` (warm black), with warm `#C8BFB2` hairline grooves whose opacity drifts between 3% and 8% so the disc reads as pressed rather than printed, and a `#1A1714` spindle. The circular artwork occupies approximately 44% of the disc diameter. Use the display face for the track title, tabular figures for time and audio quality, and the theme accent for the primary play control.
- On a wide Android player, let the visual and controls use available space up to 480dp, with lyrics alongside and the queue presented as in §5.3; preserve the safe area and adapt to shorter windows without fixed-height filler.
- The disc and arm reflect actual playback, including buffering and failure; stop decorative motion while inactive or when reduced motion is requested. Keep cover preview, lyrics, queue, transport and existing style choices accessible in the native layout.
- Other music styles may retain their artwork atmosphere. Do not add a full-screen blurred artwork layer to Vinyl; let the disc and theme canvas provide the visual hierarchy.
- A fixed room-light sheen rests on the disc while the grooves rotate beneath it, as two point-symmetric soft wedges, each about 30° wide with a smooth rise and fall (0% at the edges, at most 12% warm white on the centre line, no hard edges or hairlines). Radially they fade out near the label and at the rim, peaking between 55% and 85% of the disc radius; the disc fill carries no second static highlight, so the wedges are the only light source. The wedges never rotate with the platter. Three irregular smooth dark track-separation rings interrupt the grooves, each spanning approximately 4% of the disc radius. A 2px dark pressed rim and 1px faint bright edge seat the centre artwork into the label area; the disc edge stays subdued instead of looking moulded. Light falls from the upper left, with the arm and pivot casting restrained shadows 3px toward the lower right. The arm is a slim matte warm-metal bar (`#4A443D` → `#B4AA9C` → `#5A534A`, soft centre highlight, never chrome or green) or capsule on a warm-black pivot (`#26221F`) with a warm-black headshell (`#2B2723` → `#5A524A`) carrying a theme-accent stylus tip, pivoting between rest and engaged over the outer grooves. A soft contact shadow sits under the disc and does not rotate; the disc rim is a dark pressed edge with at most a 10% hairline highlight, never a bright ring.

### 6.8 macOS Fullscreen Player

- Layout: header (collapse, center status, player-style menu), stage (disc left, lyrics/queue alongside or centered disc when both panels close), bottom transport. Wide breakpoint `1050pt`; stage max-width `1440pt`; transport max-width `980pt`.
- The disc takes up to `500pt` centered or `400pt` beside a panel (`33%` of stage width, capped by window height minus `150pt`); track title `26pt` display face below the disc with favorite beside it.
- The queue toggle lives in the bottom transport (with lyrics toggle, sleep timer, desktop-lyrics switch), not in the header. The queue opens as a floating bottom-trailing panel (`≤360×520pt`, `18pt` radius, themed panel surface with border and a soft shadow, `36pt` from the trailing edge and `126pt` from the bottom so it never covers the transport); a click on the dimmed canvas or `Esc` closes it. The queue must not shift or resize the stage and transport behind it.

### 6.9 Android Cassette Player

- Cassette is one of the music player styles alongside Cover and Vinyl; Vinyl stays the default, and an explicit style choice is preserved. The switch lives in the player `⋯` menu and the appearance settings.
- The body is drawn at a `1 : 0.62` width-to-height ratio with corner radii of `6%` width and `10%` height. The shell runs `#6F7860` → `#39422E` → `#192015`, carries at most `12%` warm-white sheen from the upper left, a `1.2dp` bevel (lit top-left, dark bottom-right) and a contact shadow to the lower right, matching the vinyl light direction.
- The window sits at `14.2%` of the width and `46.5%` of the height, spans `71.6%` × `34.5%`, and is seated in a `16dp` rounded well. Four screws at `1.7%` of the width radius sit in the corners; a trapezoid head plate spans `28%–72%` of the width at `83%` of the height with one slim head opening and two alignment holes.
- The label paper runs `#ECE2CB` → `#E6D9BE` under a `1.2%`-of-width accent rule. At `≥180dp` show the brand line `野弦 / WILDSTRING`; the title always shows. The second line puts `DISC n · TRACK nn` in Caveat handwriting on the left and the artist, right-aligned, on the right; a missing artist stays blank rather than reading "unknown". Two `1dp` rules at `22%` ink separate the lines. Type scales with the cassette width and clamps: brand `6–9sp`, title `9–17sp`, note `9–15sp`.
- Tape packs use radii of `0.30–0.46` of the window height and conserve tape area (square interpolation between the two radii), so the supply pack shrinks as the take-up pack grows. Tape speed is constant, so angular speed is inversely proportional to the radius (reference `0.388` of the window height); angles accumulate instead of sharing one phase, so a changing radius never jumps. The two strands are outer tangents of the packs, offset by half the tape width and joined by a short fading arc where the outer layer peels off.
- Seeking winds both packs in the seek direction: a `0.9s` extra spin that eases out (at most `1.1×`). Pause and reduced motion stop it.
- Portrait pins the cassette to the top and crops the square canvas to the `1 : 0.62` body. Below it sits a fixed-height lyric frame; the loading skeleton, synced lyrics and the empty state share that frame so the cassette, title and controls never move when lyrics arrive or a track changes.
- With no lyrics, show one short public-domain verse about freedom plus its attribution. Chinese and English decks hold 47 and 39 verses; a shuffled deck shows every verse once before repeating, one verse per track, with a `400ms` crossfade (instant under reduced motion).
- Landscape deck (cassette style only): shown in a landscape window, including naturally rotated tablets. On phones it can also be entered from the menu `横屏` item, or by the prompt after the phone has been held sideways on a stand for `4s` even with auto-rotate off. It is a full-bleed gradient surface (`#2B2822` → `#211F1A` dark, `#E9E6DA` → `#DAD6C7` light) with `18dp` padding. The left column holds the cassette (body `1 : 0.62`, up to `58%` of the width and `480dp`), a `4dp` gap, the inline one-line progress and a `6dp` gap above six `54dp` keys at `9dp` radius (previous, play/pause, next, queue, favorite, sleep); the keys wrap into two rows when needed. The right column holds the compact title and lyrics, with playback mode, more actions and collapse controls at the top. The queue follows §5.3 without replacing the lyrics. Keys travel `3dp` in `90ms` while pressed and spring back; state shows in the icon colour, not a latch. A manually entered landscape session hides system bars with swipe-to-reveal; natural tablet rotation retains them and respects the safe area. Back closes the queue first, then leaves manually entered landscape or collapses the player.
- Lying flat or shaking the phone never triggers the landscape prompt. The prompt hides after `10s`, and the phone must be put upright again before it can appear once more.

---

## 7. Guardrails for UI Generation (Do's & Don'ts)

- **DO** use the exact warm paper (`#F6F3ED`) / olive stone (`#EEEEE5`) / warm carbon (`#181614`) / terracotta (`#BC5438` & `#E98A6D`) palette across all screens.
- **DO** keep border radii consistent: `16px` for hero panels, `14px` for cards, `10px–12px` for track/episode rows, `999px` (capsule) for filter chips and primary pill CTAs. When nesting rounded shapes with `gap < 32px`, follow `inner radius = outer radius - gap` (for values `> 2px`) so concentric corners align cleanly.
- **DO** maintain strict visual and baseline alignment across side-by-side cards, table columns, and action bars; apply `1px–2px` optical centering adjustments for play triangles inside circles and icons beside text.
- **DO** ship every interactive surface with complete states (`Hover`, `Active`, visible keyboard `Focus`, layout-matched `Loading`, actionable `Empty`, and inline `Error` / permission feedback). System and error messages must stay calm and specific ("what failed + what to do next"), without exclamation marks or filler copy.
- **DO** grey out completed podcast episodes and hide their progress bars so only partially played episodes show progress bars.
- **DON'T** clutter high-frequency listening views with marketing slogans, redundant helper paragraphs, or decorative secondary badges—if a screen needs explanatory text to be understood, fix the layout hierarchy instead.
- **DON'T** introduce cold blue, neon purple, or pure black (`#000000`) backgrounds, or stack heavy drop shadows on bordered cards; rely on spacing, `1px solid var(--border)` strokes, and subtle surface tonal shifts for depth.
- **DON'T** use olive or sage as a surface, chip or button fill in the dark theme; use `--nav-active`, `--accent-container` or `--accent-tint`. Olive remains a text colour.
- **DON'T** animate layout properties (`top`, `left`, `width`, `height`) or attach unthrottled scroll listeners; animate only `transform` and `opacity` and always respect `prefers-reduced-motion`.
- **DON'T** place destructive buttons (`取消订阅`, `删除`) next to primary `播放` / `继续收听` buttons; always place them inside the `⋯` menu.
