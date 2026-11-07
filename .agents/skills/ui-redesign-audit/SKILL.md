---
name: ui-redesign-audit
description: "Audits existing WildString screens and components (Web, macOS, iOS, Android) for generic AI design patterns, visual misalignment, noisy helper copy and missing boundary states, then applies targeted fixes. Numeric values live in DESIGN.md; workflow and acceptance live in AGENTS.md."
---

# UI Redesign & De-noising Audit (WildString)

In-place audit for existing screens in `frontend/web`, `frontend/macos`, `frontend/ios`, `frontend/android`. All colors, type scale, radii, sizes and breakpoints come from `DESIGN.md` (do not copy them here); acceptance level and commands come from `AGENTS.md` §3.

## Workflow: Scan → Diagnose → Fix → Verify

1. **Scan** — Read the target view and `DESIGN.md`; identify the styling system (Web CSS tokens, SwiftUI/AppKit, Compose).
2. **Diagnose** — Run the checklist below.
3. **Fix** — Minimal, targeted changes in place; never rewrite working business logic.
4. **Verify** — Pick the level from `AGENTS.md` §3, render and review screenshots, walk the key paths, run the listed checks.

## Checklist

1. **De-noising** — Remove slogans, vague subheaders, helper paragraphs and repeated counts or badges. If a screen needs explanation to be understood, fix the layout. Never remove Loading, Empty, Error or insufficient-permission states; each needs calm copy stating what failed and what to do next.
2. **Alignment** — Baseline-align side-by-side items; optically center play triangles and icons beside text; action groups wrap as whole controls at 390px and at the desktop minimum; destructive actions stay in `⋯` menus, never next to primary playback buttons.
3. **Radius & surface** — Follow `DESIGN.md` radii and `inner = outer − gap`; use spacing, hairlines and surface tone instead of heavy shadows; no single-sided card borders (except the playing-row accent indicator).
4. **Typography** — Tabular numerals for every time, index, counter and audio spec (`tabular-nums`, `.monospacedDigit()`, `tnum`); the three font roles from `DESIGN.md`; no weight 900 or italics; `text-wrap: balance` on headings, `pretty` on body copy.
5. **Color & state** — Palette tokens only; no pure black or cold blue/purple gradients. Emphasis belongs to what is playing or in progress; completed podcast episodes are muted with a checkmark and `已听完`, no progress bar.
6. **Motion & AX** — Animate only `transform` and `opacity`; honor `prefers-reduced-motion`; verify Hover, Active, Focus, Loading, Empty and Error states; keep semantic structure (`nav`, `main`, `section`) and a single source of truth for state so agents and Playwright/MCP stay reliable; accessibility floor per `DESIGN.md` §5.2.
