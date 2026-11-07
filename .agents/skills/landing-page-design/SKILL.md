---
name: landing-page-design
description: "Complete system for building high-converting landing pages and polished web UI: intake questions, page structure, layout selection, conversion copywriting, SEO, plus strict visual rules for typography, spacing, nested corner radius, surfaces, hero layout, icons, states, and motion. Adapted for WildString (DESIGN.md) and compatible with both Antigravity and Codex."
---

# Landing Page & Web UI Design System

A landing page is not an in-app workspace. An application workspace serves ongoing tasks; a landing page wins one intent:

**one offer → one audience → one primary action.**

This skill has two halves:
- **Part A** decides what a standalone landing/marketing page says and how it is structured (use **Part A** only when building or reviewing a landing page, release showcase, or marketing/intro page).
- **Part B** is the non-negotiable visual, spacing, alignment, motion, copy, and state system (use **Part B** across both landing pages and web UI components, with WildString's `DESIGN.md` tokens taking precedence for product surfaces).

## Scope & WildString Precedence

1. **In-App Product Views (Player, Library, Podcasts, AI Assistant, Settings)**:
   - Follow `DESIGN.md` and `AGENTS.md` first. Do **not** insert marketing sections (FAQ, testimonials, pricing, tagline scroll reveals, or promotional slogans) into product screens.
   - Apply **Part B** rules for spacing discipline, nested corner radii (`inner = outer - gap`), optical & baseline alignment, GPU-only motion (`transform` / `opacity`), calm system messages, and the full 6-state interactive set (`Hover`, `Active`, `Focus`, `Loading`, `Empty`, `Error`).
2. **Standalone Landing / Release / Intro Pages**:
   - Work through **Part A** before touching **Part B**, using WildString's archival warm-paper & charcoal-olive palette from `DESIGN.md` unless the user explicitly asks for a different palette.

---

# PART A — Strategy and structure (Standalone Landing Pages)

## A1. Intake

Gather these before designing or writing a landing page. Ask only for what is missing, and ask in one batch rather than one question at a time.

**Purpose**
- What is the ONE primary action? (try demo, self-host deploy, download client, view GitHub, join waitlist)
- What is the offer, exactly what do they get?
- What counts as a conversion?

**Audience and context**
- Who is the target user?
- What problem are they trying to solve?
- Top three objections
- Traffic source: search, social, GitHub, direct
- What do visitors already know when they land?

**Proof and assets**
- Proof points: real capabilities, architecture guarantees, benchmarks, screenshots
- Product screenshots, demo video, or interactive preview

**Constraints**
- Brand voice: calm, archival, literary, and grounded (per `DESIGN.md`)
- Mobile priority?

If the user cannot answer, make a reasonable assumption, state it in one line, and continue. Do not stall the build.

## A2. Page structure

**Above the fold (required)**
1. Headline, outcome plus audience
2. Subheadline, clarifies how and adds specificity
3. Primary CTA, clear verb plus what they get
4. One proof signal (real capability summary, supported platforms, or open-source/self-hosted guarantee)
5. Hero visual, real product screenshot or interactive preview

**Mid page (the argument)**
6. Problem to solution, one section
7. Benefits, three to five, outcome driven
8. How it works, three steps (e.g., Mount read-only source → Managed library organization → Multi-client playback & AI discovery)
9. Proof / technical grounding

**Bottom (objection handling)**
10. FAQ, six to twelve questions
11. Risk reversal (e.g., read-only source safety, self-hosted SQLite & Docker persistence, works offline/without AI)
12. Final CTA, identical to the top

## A3. Layout selection

Pick one and say why.

| Type | Use when |
|---|---|
| **A. Classic hero plus sections** | The product is understandable from a hero screenshot. Most common. |
| **B. Long form story** | You need to educate and overcome skepticism. |
| **C. Minimal conversion page** | High intent traffic or a direct download / self-host guide. |
| **D. Comparison page** | Search intent includes alternatives. |

## A4. Conversion rules

**Match message to source.** Keep the promise and visual tone consistent.

**Make the next step obvious.** One primary CTA. Never place competing CTAs above the fold.

**Write benefit first.** Features are what it does. Benefits are what that means for the user.

**Be specific.**
- ❌ "Save time and streamline your music"
- ✅ "Mount your read-only FLAC folder and stream across Web, Mac, iOS, and Android in 3 minutes"

**Treat objections as a section, not a footnote.** Put proof directly beside the claim it supports.

## A5. Copywriting

**Headline formulas**
- "{Outcome} without {pain}"
- "The {category} for {audience}"
- "Ship {result} in {time}"

**Subheadline.** One or two sentences. Clarify what it is and who it is for.

**CTA.** Verb plus what they get. Never vague "Learn more" or "Submit".

**Benefit bullets.** Bold benefit, then the proof or detail.

## A6. Build order

Work section by section, in this order:
1. Hero
2. Benefits
3. How it works
4. Proof
5. FAQ
6. Final CTA

Never rebuild the whole page on each iteration. Section by section keeps control and keeps diffs reviewable.

## A7. SEO and AEO

**Do not index** ad-only campaign pages or temporary test pages (`noindex`).

**Do index** evergreen pages. Add a clear `<title>` and meta description, internal links, and plain question-and-answer FAQ structure.

## A8. Pitfalls

- Too many CTAs above the fold
- Vague value prop: "streamline", "optimize", "next-generation"
- A large feature list with no outcomes
- Proof buried at the bottom
- Mobile layout that breaks readability
- No clear next step

---

# PART B — Visual & Engineering System

Every visual value must resolve through these rules and `DESIGN.md` instead of being invented ad hoc.

## B1. Typography

### Fonts (WildString `DESIGN.md` Alignment)

- **Editorial Display (`--font-display`)**: `"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", "Iowan Old Style", "Newsreader", Georgia, serif` — used for brand titles, page headers (`24px–28px`), daily curation titles, and fullscreen titles.
- **UI & Catalog Sans (`--font-sans`)**: `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Inter", system-ui, sans-serif` — used for navigation, track lists, buttons, chips, form controls, and settings.
- **Technical & Time Mono (`--font-mono`)**: `"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace` with strict `font-variant-numeric: tabular-nums` — used for timestamps (`3:42`, `-33:27`), track numbers (`01`), playback speed (`1.5×`), and audio specs (`FLAC · 96kHz`).
- *(For standalone non-WildString prototypes where no brand font is specified: prefer Geist, Manrope, Geist Mono, and avoid generic Arial/Roboto/Open Sans.)*

**Weight discipline:** Never use ultra-bold weights (`900` / black). Cap at semibold (`600`) or bold (`700`). Use regular (`400`), medium (`500`), and semibold (`600`) to establish clean hierarchy without shouting.

### Copy & Line-Wrap Rules

- **No orphaned words.** A single word or short fragment should not sit alone on the last line. Apply `text-wrap: balance` for headings and `text-wrap: pretty` for body copy.
- **Single-line truncation for catalog rows.** Track and episode titles in list rows use `text-overflow: ellipsis` with consistent baseline alignment across columns.

### Type scale

Keep font sizes snapped to a consistent scale rather than inventing arbitrary intermediate values:
- In WildString product UI, follow `DESIGN.md` Section 4 (`24px–28px` Hero/Page Title, `15px–16px` Section Heading, `13px–14px` Track/Episode Title, `12px` Secondary Metadata, `10px–11px` Micro Kicker/Table Header).
- In standalone landing pages, snap to standard scale steps (`12px`, `14px`, `16px`, `18px`, `20px`, `24px`, `30px`, `36px`, `48px`, `60px`) with matched line heights.

## B2. Spacing

Use a strict spacing scale. Do not invent random pixel values (`13px`, `19px`, `27px`) between steps:

| Token | Value |
|---|---|
| Spacing-0 | `0` |
| Spacing-25 | `2px` |
| Spacing-50 | `4px` |
| Spacing-75 | `8px` |
| Spacing-100 | `12px` |
| Spacing-200 | `16px` |
| Spacing-300 | `24px` |
| Spacing-400 | `32px` |
| Spacing-500 | `40px` |
| Spacing-600 | `48px` |
| Spacing-700 | `64px` |
| Spacing-800 | `80px` |
| Spacing-900 | `96px` |

**Main compact buttons / rows:** `8px` vertical padding, `12px` horizontal padding.

## B3. Corner radius & Nested Radius Formula

Keep border radii consistent with `DESIGN.md`:
- `16px` for hero panels
- `14px` for cards
- `10px–12px` for track/episode rows and search inputs
- `999px` (capsule) for filter chips and primary pill CTAs

**Nested radius formula (Mandatory):** When a rounded shape sits inside another rounded container and the gap/padding between them is **less than `32px`**:

```text
inner radius = outer radius − gap
```

Apply this whenever the result is **greater than `2px`** (below that, use a minimal `2px–4px` or square corner).
- *Example 1*: An outer card at `16px` radius with `8px` internal padding gives an inner element an `8px` radius.
- *Example 2*: Daily recommendation `12px` outer mosaic with `4px` gap gives `6px–8px` inner cells.

## B4. Borders, Surfaces, and Alignment

- **WildString Palette (`DESIGN.md` Section 3)**:
  - **Light (Warm Paper)**: Canvas `#F6F3ED`, Sidebar `#EEEEE5`, Panel `#FAF9F4`, Raised `#FFFDF8`, Border `#DEDED2`, Ink `#2A2B25`, Accent `#BC5438`.
  - **Dark (Charcoal Olive)**: Canvas `#171716`, Sidebar `#1C1E18`, Panel `#22251E`, Raised `#292C24`, Border `#33342E`, Ink `#EEEAE2`, Accent `#E98A6D`.
  - **Never** use pure `#000000` backgrounds or cold blue / neon purple AI gradients.
- **No "Border + Heavy Shadow + White Background" stacking**: Rely on spacing, subtle surface tonal shifts (`--bg` vs `--surface` vs `--surface-subtle`), and `1px solid var(--border)` hairlines instead of heavy drop shadows.
- **No decorative single-sided card borders**: Borders go all the way around a card (`1px solid var(--border)`) or not at all (the only exception in WildString is the `3px` vertical `--accent` pill indicator on the currently playing track row).
- **Baseline & Optical Alignment**:
  - Side-by-side cards, table columns, and action bars must align baselines across titles, metadata, and CTAs.
  - Apply `1px–2px` optical centering adjustments for play triangles inside circles and icons beside text.

## B5. Hero & Section Layout

- Cap reading-heavy blocks and hero subheadings at a comfortable measure (`680px` for hero copy, `860px` for podcast detail panes, `1180px` for main catalog container).
- Break multi-line headings at **meaningful semantic phrases**, never splitting a thought awkwardly.

## B6. Motion & Performance

Motion must feel weighted, calm, and purposeful. Never ship mechanical browser defaults (`linear`) for UI transitions.

- **Base curve:** `cubic-bezier(0.22, 1, 0.36, 1)` (`duration-500` for layout/drawer transitions; `200ms–300ms` for hover/color/opacity shifts).
- **GPU-only properties:** Animate **only** `transform` and `opacity`. Never animate `top`, `left`, `width`, or `height`.
- **Scroll performance:** Trigger scroll reveals (on standalone landing pages) with `IntersectionObserver`. Never attach unthrottled work to `window.addEventListener('scroll')`.
- **Reduced motion:** Always respect `prefers-reduced-motion`—disable decorative rotation/translation and fall back to instant or plain opacity states.

## B7. Content Realism & System Copy De-noising

- **Cut decorative noise:** Remove slogans, empty subtitles, redundant helper paragraphs, and decorative secondary badges. If a high-frequency page needs explanatory text to be understood, fix the layout instead.
- **Banned filler words:** Never write *"revolutionize"*, *"supercharge"*, *"cutting edge"*, *"effortless"*, *"transform your workflow"*, *"take it to the next level"*, *"harness the power"*, or *"world class"*. State what the product actually does in plain terms.
- **Never invent facts:** Never fabricate track IDs, stats, prices, or testimonials. When data is missing in a template, use an explicit placeholder or real empty state.
- **Calm, actionable system messages:** Confirmations are calm and specific. Error messages must state **what failed + what to do next** (e.g., *"连接服务器失败，请检查线路地址或切换备用线路后重试"*), with no exclamation marks or cute interjections.

## B8. Complete Interactive States (Six States)

Every interactive element and view must ship with its full state set—cutting filler text must **never** mean cutting boundary states:

1. **Hover** — subtle surface shift (`var(--bg-hover)`) or accent highlight
2. **Active / Pressed** — subtle physical feedback (`scale(0.98)` or `translateY(1px)`)
3. **Focus** — visible keyboard focus ring (`:focus-visible`) for accessibility
4. **Loading** — layout-matched skeleton or calm inline loading state, avoiding jarring layout jumps
5. **Empty** — composed, helpful empty state with a clear next action, never a broken blank box
6. **Error / Insufficient Permission** — inline, specific explanation of cause and recovery action; never `window.alert()`

No dead links (`href="#"` without handler). Always indicate the active navigation item clearly.

## B9. Ship & Responsive Checklist

- [ ] Matches `DESIGN.md` color tokens (Warm Paper `#F6F3ED` / Charcoal Olive `#171716` / Terracotta `#BC5438` & `#E98A6D`), zero pure `#000000` or purple/blue AI gradients
- [ ] `font-variant-numeric: tabular-nums` enabled on all durations, counters, track numbers, and audio specs
- [ ] Nested radii follow `inner radius = outer radius − gap`
- [ ] Side-by-side elements share baseline alignment; play icons are optically centered
- [ ] Zero decorative slogans or redundant helper text; layout is self-explanatory
- [ ] Full 6 states present (`Hover`, `Active`, `Focus`, `Loading`, `Empty`, `Error` / `Permission`)
- [ ] Destructive actions (`取消订阅`, `删除`) tucked inside `⋯` overflow menus, never beside primary playback CTAs
- [ ] Animations restricted to `transform` and `opacity`, with `prefers-reduced-motion` respected
- [ ] Checked at `390px` mobile width and `1100px × 720px` desktop minimum with no horizontal overflow or clipped button text
- [ ] Semantic HTML (`<nav>`, `<main>`, `<article>`, `<aside>`, `<section>`) and clean component boundaries for UX, DX, and AX
