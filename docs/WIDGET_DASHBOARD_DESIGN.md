# Widget Dashboard Design (current, no-code)

This is the **current** dashboard system. Every app screen — the app **home/Dashboard** and each
form's **section screen** — is a declarative, host-rendered grid of `recharts` widgets. There is no
sandboxed user code and no iframe: the host renders React + recharts directly, reusing the Reports
engine. (The legacy sandboxed-code screens live in
[CUSTOM_SCREEN_DASHBOARD_KIT.md](CUSTOM_SCREEN_DASHBOARD_KIT.md) and are an advanced escape hatch only.)

> **Editing agents:** for any normal app dashboard or form section screen, edit the widget dashboard
> (this doc). Only edit a `kind: 'code'` custom screen when the design genuinely can't be a widget grid.

## Storage

A dashboard is stored on the existing `customScreen` JSON column (on `apps` for the home, on `forms`
for a section screen):

```jsonc
customScreen: {
  enabled: true,
  kind: 'dashboard',          // vs 'code' (legacy sandboxed screen)
  allowNewResponses: true,    // (form screens) show a "New record" affordance
  dashboard: {
    version: 1,
    cols: 12,                 // 12-col grid; collapses to 1 col < 768px
    widgets: [ /* … */ ]
  }
}
```

Types live in `ui/src/types/app.ts` (`DashboardScreen`, `DashboardWidget`, `WidgetLayout`).

## Widgets

Each widget has `{ id, title?, layout: {x,y,w,h}, kind, … }`. Kinds:

| kind       | Renders | Config |
|------------|---------|--------|
| `report`   | A chart/number/table via **`ReportResultView`** (bar/line/area/pie/donut/kpi/table). | `spec: AppReportSpec` — the same query model as the Reports section. Editable inline with the reused `ReportBuilder`. |
| `list`     | A compact recent-records list with a "View all" link to the records grid. | `list: { formId, titleField?, subtitleField?, limit }` |
| `text`     | A static note. | `text: { body }` |
| `actions`  | Quick "new record" buttons for the app's submittable forms (app scope). | derived from the app |
| `activity` | Cross-form recent-activity feed (app scope). | derived from the app |

## Rendering & editing

- Renderer: `ui/src/components/app-runtime/WidgetDashboard.tsx` (+ `AppWidgetDashboard`,
  `AppSectionDashboard`, `AppDashboardHome`). Report widgets reuse `ReportResultView` verbatim.
- Editor: `DashboardBuilder.tsx` — a drag-and-drop resizable grid (pointer events; `touch-none` on
  the move/resize handles for touch). Report widgets open the full `ReportBuilder`; others get a
  compact config. Owner-only ("Edit dashboard").
- Data: one **batched** report run per dashboard (`/api/app/{slug}/reports/run-batch`, or the
  form-owner/public run endpoints for section/public scope).

## Security & permissions

- **Permission-gated:** a `report`/`list`/`activity` widget bound to a form the viewer can't see is
  hidden. The real boundary is server-side — `resolveAndRunSpec` re-derives joins and checks
  `verifyFormBelongsToApp` + per-form view permission; the spec's declared joins are never trusted.
- **Save-boundary hardening:** saved dashboards are sanitized against app/form scope
  (`AppReportService::sanitizeDashboard`) — foreign/broken widgets dropped, layouts clamped, widget
  count capped.
- Theme: charts read the app accent; solid accent buttons pick a contrast-aware foreground
  (`readableForeground`). Renders in light + dark.

## Authoring / QA pipeline

Pack dashboards are authored in the pack `.ts` files, then:
`node scripts/emit-marketplace.mjs` → `php scripts/provision-demo.php`, followed by the screenshot
vision-QA sweep (capture light+dark → route fixes to the pack `.ts` / seeder). No sandboxed code, so
the CSP/egress concerns of the legacy kit do not apply here.
