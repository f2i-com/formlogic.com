# README screenshots

The September 2026 screenshots show the actual FormLogic application rendered by
the local development server. They are browser captures, not product mockups.

| File | View | Dimensions |
| --- | --- | --- |
| `dashboard-desktop.jpg` | Workspace dashboard | 2880 × 2000 |
| `dashboard-mobile.jpg` | Dashboard at a 390-pixel viewport | 780 × 2000 |
| `connect-ai-desktop.jpg` | Bring-your-own AI wizard | 2880 × 2000 |

The screenshots use fictional studio data and the fictional Alex Morgan fixture.
API requests were intercepted in isolated Playwright contexts using the dashboard
preview fixtures; other origins were blocked. No account, backend record, AI
provider or local device setting was changed. No private phone numbers, email
addresses, call transcripts or credentials are included.

The screenshot fixture source is
`formlogic/ui/scripts/capture-dashboard-preview.mjs`. The related landing-page
captures live in `formlogic/ui/public/images/dashboard-demo/`.

Other images in this directory predate this refresh. The root README uses the
three refreshed captures listed above.

The website documentation reuses `connect-ai-desktop.jpg` at `formlogic/ui/public/images/docs/connect-ai.jpg`.
