# MCP — build apps with your own AI

FormLogic ships an **MCP server** (Model Context Protocol, over HTTP) so you can point your *own* AI —
Claude Desktop, Claude Code, Cursor, or anything that speaks MCP — at a FormLogic app and have it build
and edit forms, compose **widget dashboards**, write **custom screens**, and wire everything together.
Bring your own (frontier) model instead of the built-in one.

It works over a **temporary, scoped connection**: a short-lived bearer token with an idle timeout that you
can revoke at any time.

> Beta. App screens created this way run in the same sandbox as everything else (see [Custom screens](#)).

---

## Connecting

There are three places to start a connection — all open the same **Connect an AI** dialog:

| From | Scope of the token |
|---|---|
| **Settings → Connect an AI** | All your apps (account-wide) |
| **App settings → Manage → Connect an AI** | That one app only |
| **Apps → "Hand to an AI"** | Creates a blank app, then a link scoped to it |

Click **Generate connection**. You'll get an **MCP URL**, a **bearer token** (shown once), and a ready‑to‑paste
client config:

```json
{
  "mcpServers": {
    "formlogic": {
      "url": "https://your-host/api/mcp",
      "headers": { "Authorization": "Bearer flm_xxxxxxxx" }
    }
  }
}
```

Add it to your MCP client as a **remote / HTTP MCP server**. The endpoint speaks JSON‑RPC 2.0
(`initialize`, `tools/list`, `tools/call`).

---

## The connection is temporary

| | Default |
|---|---|
| Hard expiry (TTL) | **1 hour** (max 24h) |
| Idle timeout | **15 minutes** of inactivity |
| Reveal | token shown **once** at creation |
| Revoke | any time, from the same dialog |

Treat the token like a password — it can create and edit your content. The token is stored only as a
SHA‑256 hash; it can't be recovered after creation (generate a new one if lost).

---

## Scopes

Each token carries a capability list. The **default ("builder") token** can manage apps, forms, and
screens — but **cannot read submission data**:

`apps:read` · `apps:write` · `forms:read` · `forms:write` · `screens:write`

`responses:read` is **off by default** and must be granted explicitly. `tools/list` only returns the tools
your token's scopes allow.

**App‑scoped tokens** are enforced everywhere: they only see that one app's forms, can't create new apps,
and can't touch other apps or their forms.

---

## Self-describing (zero prior knowledge)

You can hand the link to any MCP-capable AI and just say *"build me an app"* — it doesn't need to know
FormLogic in advance:

- The **`initialize`** response carries an `instructions` string (the MCP client feeds it to the model) with
  the whole workflow: `create_app` → `create_app_form` → `set_app_home` (widget dashboard) → publish, the
  field types, the dashboard widget shapes, and the custom-screen SDK.
- **`get_started`** is the first tool listed and returns a full guide with a worked example. It needs no
  scope, so an AI can always read it before acting.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `list_forms` | forms:read | List your forms (only the scoped app's, if app‑scoped) |
| `get_form` | forms:read | Get one form (fields, `logicScript`, `customScreen`) |
| `create_form` | forms:write | Create a form (fields, onSubmit script, custom screen, status) |
| `update_form` | forms:write | Update a form |
| `list_apps` | apps:read | List your apps (only the scoped one, if app‑scoped) |
| `create_app` | apps:write | Create an app — optional `description` + `appKind` audience tag (rejected for app‑scoped tokens) |
| `update_app` | apps:write | Rename, set description, change the **slug**, publish (`status: "published"`) / unpublish (`"draft"`) |
| `add_form_to_app` | apps:write | Attach a form to an app |
| `set_app_home` | screens:write | Set the app's **home** screen — a widget **dashboard** (preferred) or a custom code screen |
| `create_report` | apps:write | Add a chart, KPI, or table to the app's Reports section |
| `create_document` | apps:write | Compose an exportable PDF report page from charts and text |
| `list_responses` | responses:read | List a form's responses (off by default) |

Everything goes through the same services + ownership checks as the rest of the API, so an MCP token can
only ever touch the owner's resources (and, when app‑scoped, only that app).

### Widget dashboards via MCP (the primary home screen)

A dashboard is **data, not code**: a grid of widgets the host renders natively (theming, drill‑down and
auto‑refresh come free). `set_app_home` accepts it as the `customScreen`:

```json
{
  "appId": "<appId>",
  "customScreen": {
    "kind": "dashboard",
    "dashboard": {
      "cols": 12,
      "widgets": [
        { "kind": "report", "layout": { "x": 0, "y": 0, "w": 4, "h": 2 }, "title": "Open jobs",
          "spec": { "formId": "<formId>", "viz": "kpi", "measure": { "fn": "count" } } },
        { "kind": "actions", "layout": { "x": 0, "y": 2, "w": 12, "h": 1 } },
        { "kind": "list", "layout": { "x": 0, "y": 3, "w": 6, "h": 3 },
          "list": { "formId": "<formId>", "limit": 8, "titleField": "title" } }
      ]
    }
  }
}
```

- `dashboard` = `{ cols?: 12, widgets: […] (max 60), showRangePicker?, refreshInterval?: 30|60|300 }`.
- Every widget: `{ kind, layout: {x,y,w,h}, title? }`. Kinds: **report** (an inline chart/KPI/table —
  `spec` is exactly the `create_report` spec shape), **list** (recent records:
  `{ formId, limit?≤25, titleField?, subtitleField?, metaField? }`), **text** (`{ body }`), **actions**
  (new‑record buttons, no config), **activity** (a latest‑records feed, no config).
- Saves run through the same sanitizer as the app UI (`AppReportService`): a widget whose `formId`,
  joins, or field refs point outside the app is **dropped**, layout is clamped — use the real form ids.
- **Form section dashboards**: a form can carry its own dashboard on its section screen —
  `update_form { formId, customScreen: { kind: "dashboard", dashboard } }` *after* creating the form
  (its specs may reference that form and the forms its `linked_record` fields target). The same
  sanitizer runs on this path too (also when a dashboard is passed directly to
  `create_form`/`create_app_form`).

### Custom code screens via MCP

`create_form`/`update_form` accept a `customScreen` (`{ enabled, html, css, js/ts/files }`) — a sandboxed UI
over the form that talks to the backend through the injected `FormLogic` SDK (`submit` / `records` /
`currentUser` / `context` / `toast`). `set_app_home` does the same for an app's landing page, with an
app‑scoped SDK (`submit(formId, …)` / `records(formId)` / `navigate(formId)`). See [docs/API.md](API.md)
for the data model.

A good build flow for "hand a blank app to an AI":

1. `update_app` — name the app (and optionally set its slug). Or `create_app { name, description?, appKind? }`
   for account‑wide/creator tokens — `appKind` tags the audience: `admin` | `client` | `staff` | `public` |
   `internal` | `custom` (invalid values are rejected with the list of valid kinds).
2. `create_app_form` — create each form with its fields (creates **and** attaches in one call).
3. `set_app_home` — give the app a **widget dashboard** home (or a custom code screen).
4. (optional) `update_form` — add `logicScript` automation and/or form **section dashboards**.
5. (optional) `create_report` / `create_document` — add charts, KPIs, and PDF report pages (forms must exist first).
6. `update_app` — `status: "published"` (`"draft"` unpublishes).

### Reports & PDF documents

`create_report` adds a single chart, KPI, or table to the app's Reports section. `create_document`
combines existing reports with explanatory text into an exportable PDF page. Create chart reports
first; documents reference them by the `id` returned from `create_report`.

**`create_report` inputs**

| Field | Required | Notes |
|---|---|---|
| `appId` | yes | |
| `name` | yes | |
| `description` | no | |
| `spec.formId` | yes | Real form id (as returned by `create_app_form`) |
| `spec.viz` | yes | `bar` \| `line` \| `area` \| `pie` \| `donut` \| `kpi` \| `table` |
| `spec.groupBy` | no | `{ field, bucket? }` — `bucket`: `"day"` \| `"month"` \| `"year"` for date fields |
| `spec.measure` | no | `{ fn, field? }` — `fn`: `count` \| `countDistinct` \| `sum` \| `avg` \| `min` \| `max` (`field` required except for `count`) |
| `spec.joins` | no | `[{ via, formId, type }]` — cross-form joins |
| `spec.filters` | no | `[{ field, op, value? }]` |
| `spec.columns` | no | Array of field refs (table viz) |
| `spec.seriesSort`, `spec.sort`, `spec.having`, `spec.limit` | no | Sorting, post-aggregate filter, row cap |

**`create_document` inputs**

| Field | Required | Notes |
|---|---|---|
| `appId` | yes | |
| `name` | yes | |
| `description` | no | |
| `blocks` | yes | At least one. Each block: `{ kind:"text", title?, body }` or `{ kind:"report", reportId, caption? }` |

**Examples**

*(a) KPI — total submission count*

```json
{
  "appId": "<appId>",
  "name": "Total submissions",
  "spec": { "formId": "<formId>", "viz": "kpi", "measure": { "fn": "count" } }
}
```

*(b) Bar chart grouped by a status field*

```json
{
  "appId": "<appId>",
  "name": "Jobs by status",
  "spec": {
    "formId": "<jobFormId>",
    "viz": "bar",
    "groupBy": { "field": "status" },
    "measure": { "fn": "count" }
  }
}
```

*(c) Table with specific columns*

```json
{
  "appId": "<appId>",
  "name": "Recent submissions",
  "spec": {
    "formId": "<formId>",
    "viz": "table",
    "columns": ["__submitted_at", "name", "email"],
    "limit": 50
  }
}
```

*(d) PDF document — intro text block + two chart blocks*

```json
{
  "appId": "<appId>",
  "name": "Monthly summary",
  "description": "KPIs and status breakdown",
  "blocks": [
    { "kind": "text", "title": "Overview", "body": "Submission counts and status breakdown for the current period." },
    { "kind": "report", "reportId": "<id from create_report for example (a)>", "caption": "Total submissions" },
    { "kind": "report", "reportId": "<id from create_report for example (b)>", "caption": "Breakdown by status" }
  ]
}
```

**Constraints**

- Use **real form ids** (returned by `create_app_form` / `list_forms`). The `@pack:` reference syntax
  is for offline pack files only — it is not valid over MCP.
- `spec.formId`, and every form id in `joins`, **must belong to the target app**. A foreign form id is
  rejected.
- `joins[].via` must be the id of a `linked_record` field on the **base** form pointing to the joined
  form.
- Field references in `groupBy`, `measure`, `filters`, and `columns` are one of:
  - a base form field id (e.g. `"status"`)
  - a joined-form field ref: `"<joinFormId>::<fieldId>"`
  - a pseudo-field: `__submitted_at` (submission timestamp) or `__status` (workflow status)
- `responses:read` scope is **not** required to create reports. Runtime data access still respects
  each user's response permissions.

---

## Security

- Tokens are short‑lived (TTL + idle timeout), revocable, and hashed at rest.
- Default tokens cannot read submission data (`responses:read` is opt‑in); there is no response **write**
  tool over MCP.
- App‑scoped tokens are enforced on every call.
- Per‑call size caps (fields 500KB, script 100KB, custom screen 512KB) and a JSON‑RPC batch cap (20).
- Widget‑dashboard and report specs are sanitized server‑side against the target app/form on save (the
  same `AppReportService` boundary as the UI): out‑of‑scope forms, joins, and field refs are dropped.
- Every action is audited (`mcp.*`) with the owner's user id.
- The `/api/mcp` endpoint authenticates with the bearer token only — never a session cookie.

To turn the **built‑in** AI off entirely and steer everyone to bring‑your‑own‑AI, set `AI_ENABLED=false`
in the backend `.env`.
