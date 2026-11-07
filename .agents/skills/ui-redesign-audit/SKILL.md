---
name: ui-redesign-audit
description: "Audits and upgrades existing WildString screens and components (Web, macOS, iOS, Android) to high-craft quality. Diagnoses generic AI design patterns, visual misalignment, noisy helper copy, and missing boundary states, then applies targeted fixes aligned with DESIGN.md and AGENTS.md without breaking existing functionality."
---

# UI Redesign & De-noising Audit (WildString)

This skill is a **diagnostic and in-place upgrade workflow** for existing screens and components across WildString (`frontend/web`, `frontend/macos`, `frontend/ios`, `frontend/android`).

## Workflow: Scan → Diagnose → Fix → Verify

1. **Scan** — Read the target view/component and `DESIGN.md`. Identify the styling system (Web CSS tokens, SwiftUI/AppKit, or Jetpack Compose) and the current layout structure.
2. **Diagnose** — Run the 6-part audit below. Identify visual noise, misalignment, off-scale spacing/radii, and missing states.
3. **Fix** — Apply targeted, minimal upgrades in place. Never rewrite working business logic from scratch.
4. **Verify** — Walk through the key user paths (login, browse, play/seek, state switches) and run `make check` (which automatically scans `frontend/web/tests/*.spec.ts` for stale assertions referencing removed UI copy) followed by `make test-affected-desktop` / `make test-affected` (or `make macos-test` / `make ios-test` / `make android-test` for native clients).

---

## 1. Information De-noising Audit (Cut Filler, Keep States)

- **Cut decorative slogans & helper paragraphs**: Remove marketing taglines, vague subheaders, and explanatory paragraphs on high-frequency screens. If a screen requires explanatory text to be understood, fix the layout hierarchy instead.
- **Cut redundant secondary badges & repeated counts**: Do not display the same counter or status badge in two places within the same view.
- **Keep and refine boundary states**: Cutting noise must **never** remove `Loading`, `Empty`, `Error`, or `Insufficient Permission` states. Every boundary state needs a calm, specific explanation and a clear recovery action (e.g., retry button or navigation entry).
- **Calm, specific system copy**: Error messages must state **what failed + what to do next** without exclamation marks, cute interjections, or vague error codes alone.

## 2. Layout, Baseline & Optical Alignment Audit

- **Baseline alignment**: Side-by-side cards, table columns, segmented controls, and toolbar buttons must share a clean horizontal baseline.
- **Optical centering**: Play triangles inside circular buttons and icons beside text require `1px–2px` optical adjustment so they look visually centered, not merely mathematically centered.
- **Action bar wrapping**: Action groups must wrap cleanly as whole controls when horizontal space is constrained, without clipping button labels or overflowing at `390px` mobile width or `1100px × 720px` desktop minimum.
- **Destructive action isolation**: Never place destructive actions (`取消订阅`, `删除`, `移除`) directly next to primary playback buttons (`播放全部`, `继续收听`). Always tuck destructive or low-frequency actions inside `⋯` overflow or context menus.

## 3. Corner Radius & Surface Hierarchy Audit

- **Nested radius formula**: When a rounded element sits inside a rounded container with `gap < 32px`, enforce:
  ```text
  inner radius = outer radius − gap
  ```
  (for results `> 2px`).
- **Standard WildString radii (`DESIGN.md`)**:
  - Hero panels: `16px`
  - Cards: `14px`
  - Track / episode rows & inputs: `10px–12px`
  - Filter chips & primary pill CTAs: `999px` (capsule)
- **Drop "Border + Heavy Shadow + Background" stacking**: Rely on spacing, `1px solid var(--border)` hairlines, and subtle surface tonal shifts (`--bg` vs `--surface` vs `--surface-subtle`) instead of heavy drop shadows.
- **No single-sided card borders**: Borders go all the way around a card or not at all (except the `3px` `--accent` left pill indicator on the currently playing track row).

## 4. Typography & Numeric Discipline Audit

- **Strict tabular numerals**: Every timestamp (`3:42`, `-33:27`), track index (`01`), badge counter, and audio spec (`FLAC · 96kHz`) must use `font-variant-numeric: tabular-nums` (or `.monospacedDigit()` in SwiftUI / `tnum` in Compose) so columns never jitter during playback.
- **Three-tier font roles (`DESIGN.md`)**:
  - Display Serif (`--font-display`) for brand headers, page titles (`24px–28px`), and fullscreen titles.
  - UI Sans (`--font-sans`) for navigation, catalog rows, controls, and settings.
  - Technical Mono (`--font-mono`) for durations, counters, and technical badges.
- **No ultra-bold (`900`) or italics**: Use `400` (regular), `500` (medium), and `600` (semibold) for hierarchy.
- **Line-wrap balance**: Apply `text-wrap: balance` on headings and `text-wrap: pretty` on body copy to prevent orphaned single words on the last line.

## 5. Color & State Clarity Audit (`DESIGN.md`)

- **Palette compliance**:
  - Light (Warm Paper): Canvas `#F6F3ED`, Sidebar `#EEEEE5`, Panel `#FAF9F4`, Raised `#FFFDF8`, Border `#DEDED2`, Ink `#2A2B25`, Muted `#626457`, Faint `#8A8E7D`, Accent `#BC5438`.
  - Dark (Charcoal Olive): Canvas `#171716`, Sidebar `#1C1E18`, Panel `#22251E`, Raised `#292C24`, Border `#33342E`, Ink `#EEEAE2`, Muted `#A8A59C`, Faint `#8E9284`, Accent `#E98A6D`.
  - Reject pure `#000000` backgrounds and cold blue / neon purple SaaS gradients.
- **Playing vs. Completed state hierarchy**:
  - Visual emphasis belongs only to what is **currently playing** or **in progress**.
  - Completed podcast episodes are visually muted (`--faint` title + subtle checkmark + `"已听完"`) with **no** bottom progress bar.

## 6. Motion, Accessibility & AX Audit

- **GPU-only motion**: Animate only `transform` and `opacity` using smooth deceleration (`cubic-bezier(0.22, 1, 0.36, 1)`). Never animate `top`, `left`, `width`, or `height`.
- **Reduced motion**: Respect `prefers-reduced-motion` across all animations (including vinyl/cassette/radio motion).
- **Full 6 interactive states**: Verify `Hover`, `Active` (`scale(0.98)` / `translateY(1px)`), visible keyboard `Focus` ring, `Loading`, `Empty`, and inline `Error` states.
- **AX (Agent Experience)**: Keep DOM and component trees semantic (`<nav>`, `<main>`, `<section>`), avoid deeply nested wrapper divs, and keep state sources single-truth so future agent edits and Playwright/MCP interactions remain reliable.
