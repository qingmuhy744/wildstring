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
   - Uses warm unbleached paper (`#F6F3ED`), soft olive-grey stone (`#EEEEE5`), deep charcoal-olive (`#171716` / `#22251E`), and terracotta coral (`#BC5438` / `#E98A6D`).
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

---

## 3. Color System & Theme Tokens

WildString supports three themes: **Light (Warm Paper — Daylight)**, **Dark (Charcoal Olive — Night)**, and an optional signature **Red Cloth (一块红布)** theme on mobile.

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
| `--faint` | `#8A8E7D` | Timestamps, table column headers, completed podcast episodes |
| `--accent` | `#BC5438` | Primary terracotta coral (play buttons, active indicators, progress fill) |
| `--accent-text` / `accentDeep` | `#9F422B` | High-contrast terracotta for text links, badges, and active icons |
| `--olive` | `#57492F` | Warm archival olive-brown for recommendation reasons & editorial tags |
| `--olive-soft` | `#E4E7DB` | Soft sage pill background for AI/editorial badges |
| `--on-accent` | `#FFFAF3` | Text and icons placed on top of `--accent` buttons |
| `--danger` | `#B83B2A` | Destructive actions (`取消订阅`, `删除`) |

### 3.2 Dark Theme (Charcoal Olive & Warm Coral)

| Token | Hex | Role & Usage |
| :--- | :--- | :--- |
| `--bg` / `canvas` | `#171716` | Primary page canvas (warm carbon black) |
| `--sidebar` | `#1C1E18` | Left navigation sidebar & right inspector background |
| `--surface` / `panel` | `#22251E` | Cards, track rows, hero panels, bottom transport bar |
| `--surface-subtle` / `raised` | `#292C24` | Elevated cards, search inputs, hover surfaces |
| `--bg-hover` | `#30332B` | Hover state for rows and secondary controls |
| `--row-active` / `accentSoft` | `#262B21` | Currently playing track row fill |
| `--nav-active` / `oliveSoft` | `#30352A` | Selected sidebar navigation pill & AI badge fill |
| `--border` | `#33342E` | Hairline dividers (`1px`) and card strokes |
| `--text` / `ink` | `#EEEAE2` | Primary warm parchment text |
| `--muted` | `#A8A59C` | Secondary metadata text (artist, album, descriptions) |
| `--faint` | `#8E9284` | Timestamps, disabled/completed episode text, section kickers |
| `--accent` / `accentDeep` | `#E98A6D` | Warm coral accent for buttons, active waveform, and progress bars |
| `--accent-hover` | `#F0A48A` | Hover highlight for primary accent controls |
| `--olive` | `#B4C09E` | Soft sage-olive text for recommendation reasons (`reason`) |
| `--on-accent` | `#211B17` | Dark ink icon/text on `--accent` primary buttons |
| `--danger` | `#F08C7B` | Error banners and destructive menu items |

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
  - Primary coral pill button (`▶ 继续收听` or `▶ 播放最新一集`) paired with a circular `32×32` `⋯` button housing `分享节目` and destructive `取消订阅`.
  - Collapsible 2-line show description with `展开简介` link.
- **Episode Filter, Sort & Grouping**:
  - Filter pills: `全部` (solid dark pill when active), `未听 N`, `已听 N`.
  - Right-aligned sort dropdown (`从新到旧 ⌄` / `从旧到新 ⌄`).
  - Time section headers: `本周` and `更早`.
  - Automatic title cleanup strips redundant trailing show-name brackets (e.g., `【王局拍案播客】`).
- **Episode Row States (Three Distinct Visual Tiers)**:
  1. **Currently Playing (`current`)**: Full-row warm tint (`rgba(188, 84, 56, 0.14)`), left animated/colored `waveform` icon, bold ink title, subtitle `日期 · N分钟 · 正在播放` (in coral).
  2. **In Progress (`0 < position < duration`)**: Left bordered circular play button, normal ink title, subtitle `日期 · 剩 N 分钟` (coral highlight), and a slim `3.5px` coral progress bar at the bottom of the row.
  3. **Completed (`position >= duration`)**: Muted grey play circle, **greyed-out title (`var(--faint)`)**, inline `checkmark.circle.fill` icon right after the title, muted subtitle `日期 · N分钟 · 已听完`, and **no bottom progress bar**.

### 6.4 Search (`搜索`)
- Warm canvas header with result counter (`共 N 项匹配`), primary `播放歌曲` button when track matches exist, `10px`-radius elevated search input (`var(--surface-input)` with focus accent ring), and category filter capsules (`全部`, `歌曲`, `专辑`, `艺人` with counts).
- Unified results view displaying interactive Track cards, Album grid cards (`148px` cover + `10px` card frame), and Artist horizontal cards (`48×48` circular avatar + album/track counts + chevron).

### 6.5 AI Music Assistant (`音乐助手`)
- Conversational interface grounded in real library track IDs.
- Supports model connection selector, natural-language queries ("找几首适合雨天夜晚听的器乐"), inline playable track cards with one-click `播放全部` or `保存为歌单`, and graceful degradation when AI connections are offline.

---

## 7. Guardrails for UI Generation (Do's & Don'ts)

- **DO** use the exact warm paper (`#F6F3ED`) / olive stone (`#EEEEE5`) / charcoal olive (`#171716`) / terracotta (`#BC5438` & `#E98A6D`) palette across all screens.
- **DO** keep border radii consistent: `16px` for hero panels, `14px` for cards, `10px–12px` for track/episode rows, `999px` (capsule) for filter chips and primary pill CTAs.
- **DO** grey out completed podcast episodes and hide their progress bars so only partially played episodes show progress bars.
- **DON'T** introduce cold blue, neon purple, or pure black (`#000000`) backgrounds.
- **DON'T** place destructive buttons (`取消订阅`, `删除`) next to primary `播放` / `继续收听` buttons; always place them inside the `⋯` menu.
- **DON'T** use heavy drop shadows; rely on `1px solid var(--border)` strokes and subtle surface tonal shifts for depth.
