# Browser & Device Launch Matrix

Manual pre-launch verification. Run each flow on each target and record the result (✅ / ⚠️ note /
❌ bug + issue link). This is a **manual** checklist — automated coverage is the Playwright release
gate (`.github/workflows/e2e.yml`); this catches the rendering/gesture/PWA issues automation misses.

Perf sanity for dashboards is scripted: `node form-builder/ui/scripts/perf-demo-dashboards.mjs`
(first-chart paint per demo app); bundle budget is reported in CI (`check-bundle-budget.mjs`).

## Targets

| # | Target | Notes |
|---|--------|-------|
| 1 | Chrome — desktop | primary |
| 2 | Safari — desktop (macOS) | WebKit; check date inputs, cookies |
| 3 | Firefox — desktop | |
| 4 | Safari — iPhone | WebKit mobile; PWA install via Share → Add to Home Screen |
| 5 | Chrome — Android | PWA install prompt |

## Flows to verify on each target

Record a cell per (flow × target).

| Flow | 1 Chrome | 2 Safari | 3 Firefox | 4 iPhone | 5 Android |
|------|:--:|:--:|:--:|:--:|:--:|
| Landing loads, no horizontal scroll | | | | | |
| Sign up / log in / log out | | | | | |
| Marketplace browse + open pack detail | | | | | |
| Public **live demo** launch → app opens | | | | | |
| App runtime: nav, records grid, submit a record | | | | | |
| **Public form submit** (all field types incl. upload, signature, date/time) | | | | | |
| **Dashboard viewing** (charts render light + dark, no overflow) | | | | | |
| **Dashboard editing** (drag/resize) — desktop OK; small screens show the "easier on a larger screen" hint and touch-drag works | | | | | |
| Reports: run a report, export PDF | | | | | |
| **PWA install** + offline: install, reopen, submit while offline → syncs on reconnect | | | | | |
| Theme toggle (light ↔ dark) persists | | | | | |

## Known posture

- **Dashboard editing on phones** is intentionally cramped (12-col grid); the builder shows a
  "easier on a larger screen" hint and sets `touch-none` on the drag/resize handles so touch-drag
  works. Viewing collapses to a single column < 768px. Treat editing as "desktop-recommended".
- **Safari date/time inputs** render as native pickers — confirm value round-trips on submit.
- **PWA** avoids caching authenticated API responses + private uploads (no shared-device leak) while
  still queueing offline submissions for background sync — verify both halves on install targets.

Record results + date here or in the launch issue before flipping to public.
